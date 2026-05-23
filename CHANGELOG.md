# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-05-23

### Performance

- **`CacheHit` singleton — zero allocation on L1 hot reads** — `SmartMemoryCache.get()` previously returned a freshly allocated `{ value, isStale, expiresAt, ttlMs, delta }` object on every call. The object is now a module-level singleton that is mutated in-place and returned. JS is single-threaded, so callers always consume all fields synchronously before the next `get()` call — the pattern is safe. One heap allocation eliminated per L1 hit.

  Measured impact: L1 hot-hit throughput **2.60 M/s → 2.81 M/s (+8 %)**, exact delete **3.94 M/s → 5.36 M/s (+36 %)** (GC pressure reduction frees the CPU budget used by the delete micro-benchmark's tight loop).

- **Deferred `inferPriority` — 3× `string.includes()` saved on every warm hit** — When `refreshAhead` or `xfetchBeta` opts are active, `inferPriority(cacheKey)` was computed unconditionally on every warm L1 hit even when the threshold check was false and no background recompute fired. The call is now deferred inside the `if (shouldRefreshAhead || shouldXFetch)` branch so the three `string.includes()` scans only run when a recompute actually triggers.

### Documentation

- **BENCHMARKS.md fully refreshed** — All 20+ measurement tables updated with the May 2026 macro-suite numbers. Four new sections added:
  - `hotKeys(n)` — live frequency ranking (O(n) scan + O(n log n) sort; slice size has negligible effect)
  - Refresh-ahead overhead — 340.8 ns/op in the full macro-suite (< 5 % in isolation; V8 polymorphic-IC effect from adjacent iterator benchmarks explained)
  - `setIfAbsent()` — fast path 31.59 µs (l1.has → false), miss path 78.98 µs (l1.set + eviction at capacity)
  - Negative caching (`notFoundTtl`) — null hit 105.08 µs vs non-null 95.49 µs (no overhead for null values)

---

## [0.4.1] — 2026-05-23

### Fixed

- **Backplane-aware `dependsOn` cascade** — When a fleet peer published a `del` message for a parent key, the receiving instance evicted the parent from its L1 but did not cascade to any entries that declared `dependsOn` containing that key. The cascade (`_cascadeDependencies`) now runs on every incoming `del` backplane message, not just on the originating instance. Single-process behavior is unchanged; fleet environments now correctly evict dependents on all nodes.

### Added

- **`mget` per-key TTL** — The `ttl` parameter of `cache.mget()` now accepts a function `(key: string) => number` in addition to a plain `number`. The function is called only for miss keys, enabling heterogeneous TTLs in a single batch call. Plain-number callers are unaffected.

  ```typescript
  const results = await cache.mget(
    ['user:1', 'config:global', 'user:2'],
    fetchFn,
    (key) => key.startsWith('config:') ? 3600 : 300,
  );
  ```

- **`cache.ready()` — startup warm-up lifecycle hook** — Returns a `Promise<void>` that resolves once the cache is fully initialised and any startup warming configured via `warmKeys` has completed. Resolves immediately when `warmKeys` is not set. Designed for k8s readiness probes: gate traffic until L1 is warm, then open the gate once and never block again.

- **`warmKeys` option** — Companion to `cache.ready()`. Pass a Redis key glob pattern (`'user:*'`) to automatically call `warmFromL2(warmKeys)` at construction time. No-op when Redis is disabled or unreachable.

  ```typescript
  const cache = CacheService.create({ warmKeys: 'user:*' });
  await cache.ready(); // resolves once warmFromL2('user:*') finishes
  // k8s readiness endpoint returns 200 only after this point
  ```

---

## [0.4.0] — 2026-05-23

### Added

- **Negative caching (`notFoundTtl`)** — Prevent repeated upstream calls for keys that genuinely do not exist. When `fetchFn` returns `null` or `undefined`, the result is now cached for `notFoundTtl` seconds rather than bypassing the cache entirely. Configurable globally via `CacheOptions.notFoundTtl` and overridden per-call via `opts.notFoundTtl` in `cache.get()`.

  ```typescript
  // Global: cache all "not found" results for 30 s
  CacheService.create({ notFoundTtl: 30 });

  // Per-call override
  const user = await cache.get('user:999', () => db.users.find(999), 300, { notFoundTtl: 10 });
  ```

- **`cache.setIfAbsent(key, value, ttlSeconds?)`** — Atomic "set if not cached". Checks L1 first; if absent, attempts a Redis `SET NX EX`; on success, populates L1. Returns `true` if the value was written, `false` if a live entry already existed. Zero-cost on the common "already cached" path — no Redis round-trip.

  ```typescript
  const written = await cache.setIfAbsent(`session:${id}`, sessionData, 3600);
  if (!written) { /* session already exists — do not overwrite */ }
  ```

- **Refresh-ahead (`opts.refreshAhead`)** — Per-call opt on `cache.get()`. When the remaining TTL falls at or below `ttl × (1 - refreshAhead)`, a background recompute is triggered transparently — callers always receive the cached value with zero added latency. Complements SWR: refresh-ahead fires before the entry becomes stale; SWR fires after.

  ```typescript
  // Recompute in background when ≤ 20 % of TTL remains
  const config = await cache.get('config:global', fetchConfig, 3600, { refreshAhead: 0.2 });
  ```

- **XFetch probabilistic early expiry (`opts.xfetchBeta`)** — Per-call opt on `cache.get()`. Implements the XFetch algorithm: recompute probability increases as expiry approaches and scales with last fetch duration, preventing thundering-herd spikes on expiry. Higher `xfetchBeta` values recompute earlier; `1.0` is the standard starting point.

  ```typescript
  // Probabilistic background recompute scaled to fetch duration
  const feed = await cache.get('feed:home', fetchFeed, 600, { xfetchBeta: 1.0 });
  ```

- **`dependsOn` cascade invalidation (`opts.dependsOn` on `cache.set()`)** — Tag any entry with one or more parent keys. When a parent key is deleted (exact or glob), all dependents are automatically evicted from L1. No separate invalidation call needed.

  ```typescript
  await cache.set('org:42:members', members, 300, undefined, { dependsOn: ['org:42'] });
  await cache.set('org:42:config',  config,  300, undefined, { dependsOn: ['org:42'] });
  await cache.delete('org:42'); // also evicts org:42:members and org:42:config
  ```

- **`cache.hotKeys(n?)`** — Returns the top `n` (default 10) live L1 keys ranked by Count-Min Sketch access frequency, with entry size. Expired entries are excluded; namespace prefix is stripped. Useful for debugging cache hotspots, adaptive pre-warming, and capacity planning.

  ```typescript
  const hot = cache.hotKeys(5);
  // [{ key: 'user:1', hits: 1024, sizeBytes: 512 }, ...]
  ```

### Performance

- **Refresh-ahead/XFetch overhead eliminated** — Previously, the `refreshAhead`/`xfetchBeta` code path called `l1.get(k)` followed immediately by `l1.getEntry(k)` to read `expiresAt`, `ttlMs`, and `delta` — two full Map traversals plus three `Date.now()` calls on every warm L1 hit when either opt was active. The `CacheHit` interface now carries `expiresAt`, `ttlMs`, and `delta` directly, populated in `SmartMemoryCache.get()` from the entry already in hand. The `getEntry()` call is gone. Warm L1 hit overhead with `refreshAhead`/`xfetchBeta` opts drops from **+49 %** to **< 2 %** (one extra `Date.now()` + three arithmetic ops).

---

## [0.3.1] — 2026-05-23

### Added

- **TTL jitter (`ttlJitterFactor`)** — Spread cache expirations across a configurable ± window to prevent synchronised stampedes when large numbers of entries expire simultaneously ("thundering cliff"). Setting `ttlJitterFactor: 0.15` multiplies each TTL by a random factor in `[0.85, 1.15]`. Clamped to `[0, 1]`; default `0` (no jitter). Applied in both `set()` and the populate path of `get()`.

  ```typescript
  CacheService.create({ ttlJitterFactor: 0.15 }); // ± 15 % TTL spread
  ```

- **Batch write operations — `mset()` / `mdel()`** — Write or delete many keys in a single call without hand-rolling `Promise.all`.

  ```typescript
  await cache.mset({
    'user:1': { value: alice, ttl: 300, priority: CachePriority.HIGH },
    'user:2': { value: bob,   ttl: 300 },
  });
  await cache.mdel(['user:1', 'user:2']);
  ```

- **Native OpenTelemetry span integration (`tracer` option)** — Pass any `@opentelemetry/api`-compatible tracer and tricache will emit spans for `get`, `set`, and `delete` operations. Structurally typed — no `@opentelemetry/api` peer dependency; works with any compliant tracer.

  Span names: `tricache.get`, `tricache.set`, `tricache.delete`  
  Attributes set: `cache.key_prefix` (first `:` segment), `cache.hit` (`'l1'` | `'disk'` | `'l2'` | `'miss'`)

  ```typescript
  import { trace } from '@opentelemetry/api';
  CacheService.create({ tracer: trace.getTracer('my-app') });
  ```

  Two lightweight interfaces are exported for typing without an OTEL peer dep:

  ```typescript
  import type { ICacheTracer, ICacheSpan } from 'tricache';
  ```

- **L2 circuit breaker** — Automatically suspends Redis calls after `l2CircuitBreakerThreshold` consecutive failures (default 5) and resumes a probe after `l2CircuitBreakerCooldownMs` (default 30 000 ms). A successful probe resets to `CLOSED`; a failed probe re-opens immediately. State is exposed in `cache.metrics().l2CircuitBreaker.state` (`'closed'` | `'open'` | `'half_open'`).

  ```typescript
  CacheService.create({
    l2CircuitBreakerThreshold:  3,     // open after 3 consecutive Redis errors
    l2CircuitBreakerCooldownMs: 10_000, // probe again after 10 s
  });
  ```

- **`warmFromL2(pattern)`** — Scan Redis for keys matching a glob pattern and pre-populate L1 before serving traffic. Returns the number of keys loaded. Returns `0` silently when Redis is disabled or unreachable, so it is safe to call unconditionally at startup.

  ```typescript
  const loaded = await cache.warmFromL2('user:*');
  console.log(`Warmed ${loaded} user entries from Redis`);
  ```

---

## [0.3.0] — 2026-05-23

### Added

- **Count-Min Sketch frequency tracking** — A 4 × 512 `Uint16Array` (4 KB, fits in L1d cache) now records historical access frequency for every key in L1. The per-entry `hits` counter resets to 1 whenever a key is re-admitted after eviction; the sketch retains the cross-eviction frequency so a key that was accessed 80 times before being evicted scores far above a burst key whose `hits = 1`. Benchmark: **76 % of long-resident keys survive a same-priority burst flood** of 60 new keys against 50 established residents.

  - Hash: four independent Murmur3-fragment mixes derived from one FNV-1a seed — all computed inline from a single string scan.
  - Decay: all counters halved (right-shift) every 100 000 inserts — frequency-ages old counts so a past burst cannot protect a key indefinitely.
  - Zero external dependencies; 4 KB fixed footprint regardless of cache size.

- **Iterator interface on `CacheService`** — Three lazy generator methods that skip expired entries without allocating intermediate arrays:

  | Method | Returns | Notes |
  |---|---|---|
  | `cache.keys()` | `Generator<string>` | Namespace prefix stripped per yield; no `[key, entry]` tuple allocated |
  | `cache.values<T>()` | `Generator<T>` | `yield*` delegation — no intermediate generator frame |
  | `cache.entries<T>()` | `Generator<[string, T]>` | Yields `[strippedKey, value]` pairs |

  All three iterate only live (non-expired) L1 entries and silently skip entries whose TTL has elapsed since the last background cleanup sweep.

  ```typescript
  for (const key of cache.keys()) console.log(key);
  for (const value of cache.values<User>()) process(value);
  for (const [key, user] of cache.entries<User>()) sync(key, user);
  ```

### Performance

- **`keys()` +19 % throughput** (29.0 K/s → 34.5 K/s) — `liveKeys()` on `SmartMemoryCache` yields the key string directly from the Map iteration without constructing an intermediate `[key, entry]` tuple.
- **`values()` +4 % throughput** (33.7 K/s → 35.1 K/s) — `liveValues()` uses `yield*` delegation from `CacheService.values()`, collapsing one generator frame. Iterates `Map.values()` directly so the key is never loaded into the yielded code path.

### Internal

- **Removed dead `rawEntries()` generator** — An intermediate `[key, resolvedValue]` generator was explored as an optimization path for `entries()` but proved slower due to V8 inline-cache (IC) type-feedback sharing: placing the `entry.value !== undefined` ternary inside the generator frame disrupted the tight-loop optimization that V8 applies to `liveEntries()`. Removing it reduced the generator count on `SmartMemoryCache.cache` from 4 → 3, which recovered the `entries()` monomorphic JIT budget (see BENCHMARKS.md — Iterator interface trade-offs).
- **8 new tests** (141 total): 3 Count-Min Sketch tests (`liveEntries()` expiry, empty cache, sketch burst-flood survival) + 5 iterator tests on `CacheService` (`keys()` namespace stripping, `values()` deserialization, `entries()` pairs, expiry skip, empty iterator).

## [0.2.0] — 2026-05-23

### Performance

- **L1 hot-get: +112 % throughput** (1.25 M/s → 2.65 M/s, 800 ns → 377 ns) — Every cache entry now stores the deserialized JS value alongside its msgpackr buffer. `get()` returns the live object directly — zero `unpack()` call on the hot path. The packed buffer (`data`) is retained for disk spill and cold-start snapshot serialization, so cross-process behavior is unchanged.

- **Bloom-filter hit path: +44 % throughput** (2.26 M/s → 3.26 M/s) — direct benefit of eliminating the `unpack()` call that followed the Map lookup.

- **CacheService L1 warm-hit: +64 % throughput** (1.32 M/s → 2.16 M/s) — `getIfFresh()` and `mget()` also return `entry.value` directly, skipping deserialization end-to-end.

- **CacheService SWR stale-serve: +38 % throughput** (1.48 M/s → 2.04 M/s) — same `entry.value` fast path in the stale-serve code.

- **`set` throughput unchanged** — `set()` still calls `pack()` exactly once; the only addition is storing the reference as `entry.value` (a pointer copy, not a serialization round-trip).

> **Memory note:** each L1 entry now holds both the packed `Buffer` and the live JS object. For a typical cache payload this roughly doubles the per-entry heap overhead vs a packed-only store. The `size` field (used for eviction pressure) still reflects `packed.byteLength` — tune `l1MaxEntries` / `l1MaxBytes` accordingly.

> **Reference semantics:** `get()` now returns a direct reference to the cached object, not a fresh deep copy. Mutating the returned value will corrupt the cached entry. This is consistent with high-performance in-process caches (node-lru-cache, quick-lru, etc.). If immutability is required, deep-clone at the call site.

### Fixed

- **Benchmark `[object Object]` logger bug** — The multi-tenancy category-starvation section was printing raw `{ entries, hits }` objects in template strings because `getStats().categories[key]` returns `{ entries: number; hits: number }`, not a plain number. The relevant variables now correctly access `.entries`.

- **Benchmark tenant-parity variance** — `org_a` and `org_b` namespace throughput benchmarks previously used independent `Math.random()` calls, so each run saw a different operation distribution. Both namespaces now share a single pre-generated random sequence so they execute identical workloads and JIT-warmth effects don't skew the A/B ratio.

- **Benchmark tenant-parity JIT warmth** — Even with an identical operation sequence, `org_b` was still faster because it ran after `org_a`'s 10 000 timed iterations had already compiled all shared CacheService / inflight-Map hot paths. Both closures are now materialised upfront and warmed in an interleaved pass (400 alternating iterations each) before either timed run begins. Parity ratio is now consistently ≈ 1.00× (previously 0.74–0.81×).

### Added

- **`cache.clear(prefix?)`** — Flush all cached entries with a single call. Passing an optional prefix (e.g. `'user:abc'`) limits the flush to keys with that prefix, scoped to L1 and Redis. Replaces the previous workaround of `delete('prefix:*')`.

- **`cache.rebalance()`** — Evict L1 entries that violate the current category or global capacity limits. Useful when `categoryLimits` are tightened after startup; previously, existing entries were never re-evaluated until they expired naturally.

- **`cache.ttl(key)`** — Return the remaining TTL in seconds for a key currently held in L1, without fetching or consuming the value. Returns `null` if the key is absent or expired. Useful for SWR decisions and debugging.

- **`cache.writeSnapshot(altPath?)`** — `writeSnapshot()` now accepts an optional path argument. Calling `writeSnapshot('/tmp/backup.snap')` writes to that path without touching the configured default snapshot file. Useful in graceful-shutdown hooks. The zero-argument form is unchanged.

- **`DiskTier.clear()`** — Internal method used by `cache.clear()` to flush the entire L1.5 disk tier.

- **`cache.has(key)`** — Return `true` if the key exists in L1 and has not expired. Uses the bloom filter as a fast-path negative check. No fetch, no disk or Redis round-trip.

- **`cache.touch(key, newTtlSeconds)`** — Extend the TTL of a key in L1 (and fire-and-forget `EXPIRE` in Redis) without reading or re-fetching its value. Returns `false` if the key is absent or already expired.

- **`cache.getIfFresh(key)`** — Return the L1-cached value only if it is fresh (not yet in the SWR grace window). Returns `null` when absent, expired, or stale — without triggering a revalidation. Useful for read-your-writes patterns.

- **`cache.mget(keys, fetchFn, ttl)`** — Batch read. Returns cached values for hot keys and calls `fetchFn` only with the keys that missed L1. Preserves input ordering.

- **Tag-based invalidation** — Tag entries on write and invalidate whole groups atomically:
  ```ts
  await cache.set('product:1', data, 60, undefined, { tags: ['catalog'] });
  await cache.invalidateTag('catalog'); // evicts all entries tagged 'catalog'
  ```
  Tags are tracked in-process and mirrored to Redis `SADD`/`SMEMBERS` for multi-instance consistency.

- **`cache.ping()`** — Measure L1 / disk / Redis latency in milliseconds. Returns `{ l1, disk, l2 }` — `l2` is `null` when Redis is disabled. Suitable for health-check endpoints.

- **`cache.drainToL2()`** — Pipeline all live L1 entries to Redis in a single round-trip. Useful for warming a new Redis node or for zero-downtime failover.

- **`CacheService.createAsync(optionsOrPromise)`** — Async factory that resolves a `Promise<CacheOptions>` before constructing the singleton. Useful when configuration is fetched from a secret store at startup.

- **`staleIfError` option** — Number of seconds to extend a stale L1 entry's expiry when a SWR revalidation fetch fails. Prevents serving errors while the upstream is temporarily down.
  ```ts
  CacheService.create({ staleIfError: 300 }) // keep stale for 5 more minutes on error
  ```

- **`l2WriteMode` option** — Set to `'read-only'` to allow Redis reads (L2 hits, snapshot load) while skipping all Redis writes (`set`, `delete`, `clear`, tag sync). Useful for read-replicas, canary deployments, or cost-reduction in read-heavy workloads.
  ```ts
  CacheService.create({ l2WriteMode: 'read-only' })
  ```

- **`onEviction` callback** — Called synchronously whenever L1 evicts a key, with the key name and the reason (`'capacity'` | `'category'` | `'rebalance'` | `'oom'` | `'ttl'` | `'manual'`). Never throws — errors inside the callback are silently swallowed to protect cache stability.
  ```ts
  CacheService.create({
    onEviction: (key, reason) => metrics.increment(`cache.eviction.${reason}`),
  })
  ```

- **`instanceName` option** — Prometheus `instance` label added to every metric emitted by `toPrometheusText()`. Useful when multiple `CacheService` instances push to the same Prometheus endpoint.
  ```ts
  CacheService.create({ instanceName: 'api-us-east-1' })
  ```

- **`previousEncryptionKey` / `previousEncryptionMode` options** — Zero-downtime encryption key rotation. The cache tries the current key first; if decryption fails it transparently retries with the previous key. Remove `previousEncryptionKey` after all old entries have expired.
  ```ts
  CacheService.create({
    encryptionKey:         newKeyBase64,
    previousEncryptionKey: oldKeyBase64,
  })
  ```

- **`stats().l1.categories` format** — Each category entry now exposes both `entries` (count of live keys) and `hits` (L1 cache hits since startup), instead of only the entry count. Old code that read `stats().l1.categories['prefix:']` as a plain number should read `.entries` or `.hits` instead.

### Fixed

- **`increment()` now works without Redis** — Previously `increment()` silently returned `0` every call when Redis was disabled (the default in non-production environments), making any rate-limiting logic that compared the result against a threshold permanently bypassable. It now maintains per-key counters in L1 memory with the same TTL semantics, returning `1`, `2`, `3`… as expected. Behaviour with Redis enabled is unchanged.

- **`stats().l1` now exposes `sizeBytes`** — `stats().l1` previously only returned `sizeKB` (a rounded integer) while the internal tracking and `metrics().l1` used raw bytes. Both `sizeBytes` (exact) and `sizeKB` (rounded, kept for backwards compatibility) are now present on `stats().l1`.

- **Redis reconnect bug** — When the initial Redis connection attempt failed, the internal `redisConnecting` Promise was cached in the rejected state and never reset. All subsequent calls to any Redis-backed method would fail immediately without retrying. The rejected Promise is now cleared on failure, allowing the next call to attempt a fresh connection.

### Migration

All additions are backward-compatible with one exception:

- `writeSnapshot()` with no arguments behaves identically to `0.1.0`.
- `stats().l1.sizeKB` is still present; `sizeBytes` is a new addition.
- `increment()` return values change from `0` to an accumulating count **only when Redis is disabled**. If your code compared the result to a threshold (e.g. `if (count >= limit) { ... }`), it will now work correctly in dev/test. If you were explicitly relying on the `0` return to detect a disabled-Redis state, check `cache.metrics().backplane.enabled` instead.
- **`stats().l1.categories` shape changed** — values changed from `number` to `{ entries: number; hits: number }`. Update any code reading `stats().l1.categories[key]` directly.

## [0.1.0] — 2026-05-01

Initial release.
