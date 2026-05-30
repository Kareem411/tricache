# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.3] — 2026-05-31

### Fixed

- `serialize-worker.ts` imports switched to explicit `.ts` extensions (`./encryption.ts`, `./types.ts`). tsx resolves `.ts` imports natively without any hook; the previous extensionless imports were rewritten to `.js` by esbuild (package `"type":"module"`) and tsx's `.js`→`.ts` remap hook is not active inside worker threads on Node 22. Also adds `allowImportingTsExtensions: true` + `rewriteRelativeImportExtensions: true` to `tsconfig.json` to allow the explicit `.ts` import syntax while keeping DTS emit correct.

## [0.6.2] — 2026-05-31

### Fixed

- `serialize-worker.ts` imports changed from `'./encryption.js'` / `'./types.js'` to extensionless `'./encryption'` / `'./types'`. tsx resolves extensionless imports directly to `.ts` files without needing the `.js`→`.ts` remap hook, which is not active inside worker threads on Node 22. Node 24 was unaffected.

## [0.6.1] — 2026-05-27

### Added

- **Worker thread crypto offload (`workerThreads`)** — AES-GCM encryption and decryption can now be offloaded from the V8 main thread to a dedicated `worker_threads` pool (`src/worker-pool.ts` + `src/serialize-worker.ts`). The pool is fixed-size, round-robin dispatched, and auto-sized to `min(4, logical CPUs)` when `workerPoolSize: 0`. Workers are `unref()`'d so they never block process exit. Offload activates only when `enc.isEnabled && payload.length > workerThresholdBytes` (default 128 KB), so small payloads stay on the fast synchronous path with zero overhead. Worker initialisation failure silently falls back to synchronous crypto — no configuration change required.

  | Option | Default | Description |
  |---|---|---|
  | `workerThreads` | `false` | Enable off-main-thread AES-GCM offload |
  | `workerThresholdBytes` | `131072` | Minimum serialized payload size (bytes) to offload |
  | `workerPoolSize` | `0` | Fixed pool size; `0` = auto (`min(4, CPUs)`) |

- **Backplane staleness fence (`backplaneMaxStalenessMs`)** — The Pub/Sub subscriber now tracks its most-recent disconnect timestamp. On reconnection, if the gap since the disconnect exceeds `backplaneMaxStalenessMs`, every L1 entry written before the disconnect is proactively evicted via `SmartMemoryCache.evictSetBefore()`. This prevents stale cache hits caused by silently dropped peer invalidations during network blips, Redis failovers, or container restarts. Set to `0` to disable the fence. Eviction count and gap duration are logged at `warn` level.

  | Option | Default | Description |
  |---|---|---|
  | `backplaneMaxStalenessMs` | `5000` | Gap threshold in ms; staleness fence fires above this |

- **Serverless / ephemeral disk detection (`disableDisk`)** — TriCache now inspects seven well-known environment variables at construction time (zero I/O) to detect AWS Lambda, Google Cloud Run/Functions, Azure Functions, Fly.io, Railway, and Vercel runtimes. When a serverless runtime is detected the disk tier, disk janitor, cold-start snapshots, and the disk spill callback are all silently disabled. The `metrics().disk.disabled` field reflects the current state. The new `disableDisk` option allows explicit override in either direction.

  | Option | Default | Description |
  |---|---|---|
  | `disableDisk` | `undefined` (auto) | `true` = always disable; `false` = always enable; `undefined` = auto-detect |

- **Redis Cluster support (`redisClusterNodes`)** — Pass an array of cluster seed nodes and ioredis handles slot routing, MOVED/ASK redirects, and slot-migration re-queuing transparently. The backplane subscriber is also constructed in cluster mode.

  ```typescript
  CacheService.create({
    redisClusterNodes: [
      { host: 'redis-node-1', port: 6379 },
      { host: 'redis-node-2', port: 6379 },
    ],
  });
  ```

- **Redis Sentinel support (`redisSentinel`)** — Pass sentinel addresses and a master name; ioredis monitors the primary via the sentinel topology and reconnects after failover. The backplane subscriber uses sentinel mode automatically.

  ```typescript
  CacheService.create({
    redisSentinel: {
      name: 'mymaster',
      sentinels: [{ host: 'sentinel-1', port: 26379 }],
    },
  });
  ```

- **`SmartMemoryCache.evictSetBefore(cutoffMs)`** — New internal method used by the staleness fence. Approximates each entry's write time as `expiresAt - ttlMs` and evicts entries written before `cutoffMs`. `CRITICAL` priority entries that have not yet expired are preserved. Bloom filter is rebuilt after eviction. Returns the number of evicted entries.

### Changed

- `getRedis()` return type widened from `Promise<RedisClient>` to `Promise<AnyRedisClient>` to cover Cluster and Sentinel connections.
- `this.redis`, `this.redisConnecting`, and `this.subClient` fields are now typed as `AnyRedisClient` (`Redis | Cluster`) to support all three topology modes.
- `metrics().disk` now includes a `disabled` boolean field alongside the existing stats fields.

### Fixed

- All disk tier call sites (`disk.load`, `disk.delete`, `disk.clear`, `disk.close`) are now guarded by `if (!this._diskDisabled)`, preventing `ENOENT`-class errors on platforms where the disk tier is disabled.
- `destroy()` now unconditionally drains the worker thread pool (if active) before closing Redis connections, ensuring clean shutdown when `workerThreads` is enabled.
- `WorkerPool._dispatch()` now calls `worker.ref()` before posting each message and `worker.unref()` once the pending queue drains, so in-flight `pool.encrypt()` / `pool.decrypt()` calls are always awaited correctly in short-lived scripts (benchmarks, CLI tools) without preventing process exit when idle.

### Dependencies

- `ioredis` 5.10.1 → 5.11.0
- `msgpackr` 2.0.1 → 2.0.2



### Added

- **Adaptive TTL (`adaptiveTtl`)** — tricache now tracks per-key fetch latency in a pre-allocated `Float64Array` ring buffer (default 32 samples). Once a key has ≥ 5 recorded fetch durations the library automatically derives an optimal TTL:

  ```
  adaptedTtl = clamp(p95LatencyMs × adaptiveTtlMultiplier, adaptiveTtlMin, adaptiveTtlMax)
  ```

  The caller-supplied `ttlSeconds` is used until enough samples are collected, then the library takes over TTL management autonomously. Expensive keys (slow DB queries) are cached longer; fast keys stay close to their base TTL. Four new options control the behaviour:

  | Option | Default | Description |
  |---|---|---|
  | `adaptiveTtl` | `false` | Enable adaptive TTL |
  | `adaptiveTtlMultiplier` | `20` | `p95Ms × multiplier = TTL seconds` |
  | `adaptiveTtlMin` | `10` | Floor TTL in seconds |
  | `adaptiveTtlMax` | `86400` | Ceiling TTL in seconds (24 h) |

  `metrics()` gains an `adaptiveTtl` sub-object when the feature is enabled, reporting `trackedKeys` and the top-20 slowest keys by p95 fetch latency with their currently adapted TTLs.

- **`l1EvictionWatermark` option** — `SmartMemoryCache` now supports a configurable watermark (fraction `0–1`, default `0.9`) that controls when proactive eviction fires ahead of the hard capacity ceiling. Wired through `CacheOptions.l1EvictionWatermark`. Lower values (e.g. `0.8`) amortise eviction cost more aggressively at the expense of slightly more frequent eviction rounds; raise to `0.95` on workloads where eviction is extremely rare to squeeze a few extra percent of L1 utilisation.

### Performance

- **Zero-allocation `smartEvict()`** — The L1 eviction hot path previously allocated approximately 2.9 million short-lived heap objects per second at sustained eviction rates: two fresh `Array` instances, up to 16 `{key, score}` object literals, a spread operator for merging candidate pools, a comparator closure for `Array.sort()`, and a `slice()` call per eviction. All allocations are now eliminated:
  - `_evictPool` / `_evictGPool` — two fixed-size pools of 16 `{key: '', score: 0}` slots allocated once at class construction and mutated in-place on every call.
  - Manual merge loop replaces the spread operator.
  - Hand-written insertion sort (N ≤ 16, max 256 comparisons) replaces `Array.sort()` — no comparator closure, no timsort start-up, no allocation.
  - Index-based eviction loop replaces `slice(0, EVICT_COUNT)`.

  Result: **0 heap allocations per `smartEvict()` call**. Eviction soak CV reduced from ~23 % to ~17 % under pathological 100 %-fill load. The remaining ~17 % is the irreducible V8 old-generation GC floor for entry objects and `pack()` Buffers — structurally unavoidable without moving storage off the JS heap.

### Docs

- **BENCHMARKS.md** — Added *"Eviction hot-path — zero-allocation design"* section documenting every allocation site that was removed, the pre-allocated pool design, and the before/after CV numbers with an explanation of the practical floor.
- **BENCHMARKS.md** — Added *"What tricache is very good at"* section: a reference table mapping the nine problems tricache was engineered to solve (thundering herd, priority inversion under flood, write-pressure latency spikes, GC pressure from bloom probes, etc.) to the concrete mechanism and the benchmark row that proves it.

## [0.5.1] — 2026-05-25

### Added

- **`onHit` / `onMiss` callbacks** — Two new `CacheOptions` hooks for per-tier hit/miss observability without waiting for the `onMetrics` interval. `onHit(key, tier)` fires on every L1, disk, or L2 hit; `onMiss(key)` fires when all three tiers are exhausted.

  ```typescript
  CacheService.create({
    onHit:  (key, tier) => cloudwatch.putMetricData({ key, tier }),
    onMiss: (key)       => cloudwatch.putMetricData({ key }),
  });
  ```

- **`frozen` mode (development guard)** — New `CacheOptions.frozen` option. When `true`, every value returned from an L1 hit is recursively frozen with `Object.freeze()` before being handed to the caller. Mutation attempts throw `TypeError` immediately, catching reference-semantic corruption bugs that would otherwise silently corrupt cached entries. Intended for non-production environments only.

  ```typescript
  CacheService.create({ frozen: process.env.NODE_ENV !== 'production' });
  ```

- **`tags` in `cache.get()` opts** — `tags` can now be supplied directly in the `opts` argument of `cache.get()`. When `fetchFn` fires on a miss and populates the entry, the listed tags are automatically registered in both the in-process `tagIndex` and (if Redis is enabled) the Redis SADD index. This removes the need to call `cache.set()` separately just to attach tags.

  ```typescript
  const user = await cache.get(
    `user:${id}`,
    () => db.users.find(id),
    300,
    { tags: ['users', `tenant:${tenantId}`] },
  );
  ```

- **`DiskTier.purgeNextBucket()`** — New public method that purges expired entries from exactly one of 256 subdirectory buckets per call. `CacheService` now drives disk cleanup with a 30-second `setInterval` (one bucket/tick → full sweep in ~128 minutes) instead of the former blocking `purgeExpired()` call every 5 minutes. Per-tick event-loop occupancy is bounded regardless of disk entry count. V3 filenames (expiry encoded in name) skip all file I/O for live entries.

### Fixed

- **AES-128-CTR encryption correctness** — `cipher.final()` / `decipher.final()` return values are now captured and appended in all four encrypt/decrypt paths (`encryptString`, `decryptString`, `encryptBuffer`, `decryptBuffer`). For CTR mode the final block is almost always empty, but discarding it was technically incorrect and could corrupt multi-byte plaintexts whose length is not a cipher-block multiple. Both the string and buffer paths in `encryption.ts` are corrected.

- **File descriptor leak in `DiskTier.purgeExpired()`** — The V2 header-read loop opened an `fd` via `fs.openSync()` inside a try/catch but only called `fs.closeSync()` on the success path. An exception between open and close (e.g. permission error on `statSync`) left the descriptor open. A `finally` block now closes `fd` whenever it is ≥ 0.

- **Disk spill no longer blocks the L1 eviction call chain** — `disk.save()` (called from the L1 `diskSpill` callback during eviction) and `disk.delete()` (called from `cache.delete()` on pattern deletes) are now both deferred via `setImmediate()`. The synchronous SHA-256 hash, msgpackr pack, and filesystem syscalls inside those calls no longer occupy the event loop on the critical `l1.set()` → `smartEvict` → `diskSpill` path.

### Performance

- **Size-aware Bloom filter** — `createBloomFilter()` now accepts `maxEntries` and selects between the WASM filter (hardcoded at 100 K bits, rated for ≈ 10 400 entries at 1 % FP) and a right-sized pure-JS filter. For caches configured with more entries than the WASM filter's capacity, the JS filter is instantiated with optimal bit count ($m = \lceil -n \cdot \ln p \,/\, (\ln 2)^2 \rceil$) and hash count ($k = \text{round}(\ln 2 \cdot m / n)$, clamped to `[4, 10]`). Prevents FP rate saturation that was silently forcing wasted `Map.get()` calls on every definite miss in large caches.

- **Pure-string glob matcher replaces `RegExp` on `deletePattern` hot path** — Three-level fast path: (1) trailing-only wildcard matching a configured category prefix → O(1) via existing `categoryKeys` index; (2) exactly one `'*'` → inline `startsWith` + `endsWith` + length check, zero allocation; (3) general multi-`'*'` → split once, then `globMatchParts()` (prefix anchor + suffix anchor + left-to-right `indexOf` for middle segments, no backtracking). `RegExp` construction and `.test()` are gone from all three paths.

- **Proactive eviction watermark** — `SmartMemoryCache` now runs a single eviction pass whenever either the entry count **or** byte usage crosses 90 % of its configured ceiling, even while headroom remains. This amortises eviction cost across many writes instead of deferring it until the hard ceiling triggers a large forced eviction.

- **Bloom filter dirty-count threshold proportional to `maxEntries`** — The per-delete dirty counter cap is now `max(256, min(capacity >>> 2, ceil(maxEntries × 0.05)))`. Without the cap, a right-sized JS filter for 50 K entries allowed ~12 500 ghost entries before a rebuild (5× longer than the 10 K WASM filter), raising the measured false-positive rate. The new formula restores the original cadence: rebuild after ~5 % of configured entries are deleted.

- **Bloom `add()` skipped on overwrites** — Re-adding an existing key to the Bloom filter inflated the `insertions` counter, delaying phantom-bit detection (trigger 2). The `add()` call is now guarded by `if (!existingEntry)`.

- **WASM module compiled once** — The `WasmBloomFilter` constructor previously called `new WebAssembly.Module(bytes)` on every instantiation. The compiled module is now a module-level constant (`BLOOM_WASM_MODULE`), compiled once at import time. Multiple `SmartMemoryCache` instances (e.g. per-namespace) share the compiled module.

- **Null OTEL span singleton** — `CacheService._nullSpan` replaces the per-call `{ setAttribute() {…}, end() {…} }` object literal returned when no tracer is configured. Eliminates one heap allocation per `get`/`set`/`delete` call in the common no-tracer path.

- **`span.setAttribute()` guarded by tracer presence** — `setAttribute('cache.key_prefix', …)` is now only called when a tracer is actually configured, avoiding a string-split and a method dispatch on the null span for every operation.

- **`_registerTags()` extracted** — Tag registration logic (in-process `tagIndex` update + Redis `SADD`/`EXPIRE` pipeline) is deduplicated into a single private `_registerTags()` method shared by `set()` and the `get()`-miss populate path.

- **`revalidating.has(k)` deferred past threshold check** — The `Set.has()` lookup (~30 ns) for the inflight revalidation guard is now only executed when `shouldRefreshAhead || shouldXFetch` is already true, saving the lookup on every warm hit when neither threshold is crossed.

- **`SmartMemoryCache.scan()` — non-generator bulk traversal** — New public method that accepts a callback `(key, entry, prefixLen) => void` and iterates all live entries in a single `for…of` loop. Avoids generator state-machine overhead and per-entry tuple allocation compared to the existing `liveEntries()` generator. Intended for `CacheService` bulk operations (e.g. `hotKeys`, snapshot serialisation) where the generator protocol adds measurable overhead.

---

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
