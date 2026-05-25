# TriCache

[![CI](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml/badge.svg)](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tricache.svg)](https://www.npmjs.com/package/tricache)
[![npm downloads](https://img.shields.io/npm/dm/tricache.svg)](https://www.npmjs.com/package/tricache)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20%7C%206.x-blue)](https://www.typescriptlang.org)
[![L1 get](https://img.shields.io/badge/L1%20get-2.81%20M%2Fs-brightgreen)](BENCHMARKS.md)
[![Thundering herd](https://img.shields.io/badge/thundering%20herd-100%25%20coalesced-brightgreen)](BENCHMARKS.md)

tricache is an extremely fast three-tier Node.js cache library. It serves warm reads at **2.81 million operations per second** from a single thread — over 100× faster than a localhost Redis round-trip and below any network latency floor. When L1 fills, evicted entries spill to a local NVMe disk tier rather than being dropped, keeping hit rates high without unbounded RAM growth. Cache misses that reach L2 (Redis or Valkey) are automatically coalesced: no matter how many concurrent callers miss the same key, `fetchFn` fires exactly once. See the [performance section](#-performance) for full numbers. Stale-While-Revalidate, AES-256-GCM at-rest encryption, pub/sub fleet-wide invalidation, OOM guard, cold-start snapshots, and Prometheus metrics are also supported through optional configuration — with zero required fields to get started.

<img src="https://raw.githubusercontent.com/Kareem411/TriCache/master/public/SmartMemoryCache_DiskTier.jpeg" width="600" alt="tricache architecture" />

---

## ✨ Features

| Feature | Detail |
|---|---|
| **Adaptive eviction** | LFU × LRU × priority score + Count-Min Sketch cross-eviction frequency; reservoir-sampled O(1) hot path; category limits prevent any prefix monopolising RAM |
| **Count-Min Sketch** | 4 × 512 `Uint16Array` (4 KB) tracks historical access frequency across eviction boundaries — same-priority burst keys cannot displace long-resident entries; **78 % survival rate** in benchmark flood tests |
| **WASM Bloom filter** | 562-byte binary inlined as Base64 — O(k=7) guaranteed-miss detection, no filesystem access, pure-JS fallback |
| **msgpackr serialization** | All entries packed with msgpackr — uniform binary format, no JSON at any payload size |
| **Stale-While-Revalidate** | Serve stale instantly, revalidate in background — zero added latency on cache hit |
| **Stale-if-error** | Extend a stale entry's TTL when SWR revalidation fails — no errors served during upstream outages |
| **Thundering-herd prevention** | Inflight `Promise` registry — only one `fetchFn` call per key regardless of concurrency |
| **Pub/sub invalidation backplane** | Redis pub/sub channel propagates deletes across all instances in real time |
| **Tag-based invalidation** | Tag entries on write; `invalidateTag('catalog')` evicts all matching entries from L1, disk, and Redis atomically |
| **Batch read** | `mget()` collects L1 hits, calls `fetchFn` only for misses, preserves ordering |
| **Batch write** | `mset()` / `mdel()` write or delete many keys in a single `Promise.all` call |
| **TTL jitter** | `ttlJitterFactor` spreads expirations across a configurable ± window — prevents thundering-cliff mass-expiry |
| **OpenTelemetry spans** | Structural `ICacheTracer` / `ICacheSpan` interfaces — pass any OTEL-compatible tracer; no peer dep required |
| **L2 circuit breaker** | Suspends Redis after N consecutive failures; auto-probes after cooldown; state visible in `metrics()` |
| **`warmFromL2(pattern)`** | Scan Redis and pre-populate L1 at startup; returns count loaded; no-op when Redis unavailable |
| **OOM guard** | Polls `heapUsed/heapTotal` on a timer; emergency-evicts coldest L1 entries before the process crashes |
| **Cold-start snapshot** | L1 serialised to disk on `SIGTERM`/`SIGINT`, reloaded on next startup — warm cache, cold process |
| **AES-256-GCM encryption** | L2 (Redis) values, disk spill files, and snapshots encrypted at rest; zero-downtime key rotation via `previousEncryptionKey` |
| **Prometheus metrics** | `cache.metrics()` + `CacheService.toPrometheusText()` — drop into any `/metrics` endpoint |
| **Distributed counter** | `cache.increment()` backed by Redis `INCR` for distributed rate limiting; in-process fallback when Redis is disabled |
| **Pluggable logger** | Bring your own `pino`, `winston`, etc. |
| **L2 read-only mode** | `l2WriteMode: 'read-only'` reads from Redis but skips all writes — canary deploys, read replicas |
| **Eviction callback** | `onEviction(key, reason)` fires on every L1 eviction with a typed reason string |
| **Negative caching (`notFoundTtl`)** | Cache `null`/`undefined` fetchFn results for a configurable TTL — prevents hammering upstream on repeated misses |
| **`setIfAbsent()`** | Atomic "set if not cached" — L1 `has()` check → Redis `SET NX EX` → L1 set on success; returns `true` if written, `false` if already present |
| **Refresh-ahead** | Proactively recompute an entry in the background when remaining TTL falls below a configured fraction — zero-latency freshness |
| **XFetch probabilistic early expiry** | Probabilistic background recompute keyed to last fetch duration and `xfetchBeta` — optimal protection against expiry spikes under load |
| **`hotKeys(n)`** | Returns top N keys by Count-Min Sketch access frequency with size — no full Map scan |
| **`dependsOn` cascade invalidation** | Tag entries with parent keys; deleting a parent automatically evicts all declared dependents from L1 |
| **`onHit` / `onMiss` callbacks** | Per-operation hit/miss hooks with tier info (`'l1'` \| `'disk'` \| `'l2'`) — no wait for the metrics interval |
| **`frozen` mode** | Dev-time mutation guard — `Object.freeze()` applied recursively to every L1 hit so accidental mutations throw immediately |
| **`tags` in `get()` opts** | Attach tags at read time; when `fetchFn` populates the entry on a miss the tags are registered automatically |

---

## 📦 Install

```bash
npm install tricache
# or
pnpm add tricache
```

---

## 🚀 Quick start

```typescript
import { CacheService, CachePriority } from 'tricache';

// Get (or create) the process-level singleton
const cache = CacheService.create({
  redisHost: 'my-redis.example.com',   // omit or set NODE_ENV!=production to disable L2
});

// Get-or-fetch with a 5-minute TTL
const user = await cache.get(
  `user:${userId}`,
  () => db.users.findById(userId),
  300,
);

// Explicit set
await cache.set(`user:${userId}`, user, 300);

// Delete one key
await cache.delete(`user:${userId}`);

// Delete by glob pattern
await cache.delete(`user:${userId}:*`);

// Stale-While-Revalidate: serve stale for up to 30 s while refreshing in background
const dashboard = await cache.get(
  `dashboard:${orgId}`,
  () => analytics.buildDashboard(orgId),
  300,
  { swr: 30 },
);

// Distributed rate-limiting counter
const hits = await cache.increment(`ratelimit:${ip}`, 60 /* TTL seconds */);

// Check if a key is cached (fast, no fetch)
const isCached = cache.has(`user:${userId}`);

// Batch read
const [userA, userB] = await cache.mget(
  [`user:${userIdA}`, `user:${userIdB}`],
  (missKeys) => db.users.findByIds(missKeys).then(rowsToMap),
  300,
);

// Batch write
await cache.mset({
  [`user:${userIdA}`]: { value: userA, ttl: 300 },
  [`user:${userIdB}`]: { value: userB, ttl: 300 },
});

// Batch delete
await cache.mdel([`user:${userIdA}`, `user:${userIdB}`]);

// Warm L1 from Redis at startup
const loaded = await cache.warmFromL2('user:*');
console.log(`Pre-warmed ${loaded} user entries`);

// Or auto-warm at construction + gate traffic with ready()
const cache2 = CacheService.create({ warmKeys: 'user:*' });
await cache2.ready(); // resolves once warm-up completes — ideal for k8s readiness probes

// Atomic set-if-absent — returns true if written, false if key already cached
const written = await cache.setIfAbsent(`session:${id}`, sessionData, 3600);

// Dependency cascade: deleting 'org:42' automatically evicts 'org:42:config'
await cache.set('org:42:config', config, 300, undefined, { dependsOn: ['org:42'] });
await cache.delete('org:42'); // also evicts org:42:config

// Top 10 hottest keys by Count-Min Sketch frequency
const hot = cache.hotKeys(10);
console.log(hot); // [{ key: 'user:1', hits: 842, sizeBytes: 512 }, ...]

// Tag entries for group invalidation
await cache.set(`product:${id}`, product, 300, undefined, { tags: ['catalog'] });
await cache.invalidateTag('catalog'); // evict all catalog entries

// Health check with tier latencies
const { l1, disk, l2 } = await cache.ping();

// Prometheus metrics
const snap = cache.metrics();
console.log(CacheService.toPrometheusText(snap));
```

---

## ⚙️ Configuration

All options are optional — sensible defaults apply.

```typescript
CacheService.create({
  // ── Namespace ─────────────────────────────────────────────────────────
  // Isolates keys, disk dir, snapshot file, and Redis backplane channel.
  // Two instances with different namespaces are fully independent.
  namespace: 'my-app',

  // ── Logger ────────────────────────────────────────────────────────────
  logger: pinoLogger,               // default: console warn/error only

  // ── L1 (in-memory) ───────────────────────────────────────────────────
  l1MaxBytes:   200 * 1024 * 1024,  // 200 MB total RAM cap (default)
  l1MaxEntries: 2_000,              // max entries in L1 (default)
  categoryLimits: {
    // per-prefix limits — keys are matched by startsWith()
    'user:':      { maxEntries: 500,  maxSizeBytes: 50  * 1024 * 1024 },
    'analytics:': { maxEntries: 100,  maxSizeBytes: 20  * 1024 * 1024 },
    'default':    { maxEntries: 1000, maxSizeBytes: 100 * 1024 * 1024 },
  },

  // ── L1.5 (disk spill) ────────────────────────────────────────────────
  diskCacheDir:      '/tmp/my-app-cache',  // default: os.tmpdir()/tricache-disk
  diskMaxBytes:      500 * 1024 * 1024,   // 500 MB (default)
  diskEntryMaxBytes: 10  * 1024 * 1024,   // 10 MB per entry (default)

  // ── L2 (Redis / Valkey) ──────────────────────────────────────────────
  redisHost:    'my-redis.example.com',   // or REDIS_HOST env var
  redisPort:    6379,
  redisTls:     true,                     // default: true when NODE_ENV=production
  disableRedis: false,                    // default: true when NODE_ENV!=production

  // ── Invalidation backplane ───────────────────────────────────────────
  // Redis pub/sub channel that propagates deletes to all instances.
  // Enabled by default when Redis is active.
  invalidationBackplane: true,

  // ── OOM guard ────────────────────────────────────────────────────────
  oomProtection:      true,   // enabled by default
  oomHeapThreshold:   0.85,   // evict when heapUsed/heapTotal > 85 %
  oomCheckIntervalMs: 10_000, // poll every 10 s
  oomEvictPercent:    0.20,   // evict coldest 20 % of L1 per trigger

  // ── Encryption ───────────────────────────────────────────────────────
  // base64-encoded 32-byte key; or set CACHE_ENCRYPTION_KEY env var.
  // node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  encryptionKey: process.env.CACHE_ENCRYPTION_KEY,

  // Zero-downtime key rotation — remove after all old entries have expired
  previousEncryptionKey:  process.env.PREV_ENCRYPTION_KEY,
  previousEncryptionMode: 'aes-256-gcm', // defaults to current encryptionMode

  // ── L2 write mode ────────────────────────────────────────────────────
  // 'read-write' (default) — reads and writes to Redis
  // 'read-only'            — reads from Redis, skips all writes (canary / replica)
  l2WriteMode: 'read-write',

  // ── Stale-if-error ───────────────────────────────────────────────────
  // Extra seconds to extend a stale L1 entry's expiry when a SWR fetchFn fails.
  // Prevents serving errors while the upstream is temporarily down.
  staleIfError: 300, // keep stale for 5 more minutes on revalidation error

  // ── Eviction callback ────────────────────────────────────────────────
  // Called synchronously whenever L1 evicts a key.
  // reason: 'capacity' | 'category' | 'rebalance' | 'oom' | 'ttl' | 'manual'
  onEviction: (key, reason) => metrics.increment(`cache.eviction.${reason}`),

  // ── TTL jitter ────────────────────────────────────────────────────────
  // Multiply each TTL by a random factor in [1-j, 1+j] to spread expiry.
  // Prevents mass-expiry stampedes ("thundering cliff").
  // Range [0, 1]; default 0 (no jitter).
  ttlJitterFactor: 0.15,  // ± 15 % spread

  // ── OpenTelemetry tracer ──────────────────────────────────────────────
  // Pass any @opentelemetry/api-compatible tracer. No peer dependency.
  // Spans: 'tricache.get' | 'tricache.set' | 'tricache.delete'
  // Attributes: cache.key_prefix, cache.hit ('l1'|'disk'|'l2'|'miss')
  tracer: trace.getTracer('my-app'),

  // ── L2 circuit breaker ────────────────────────────────────────────────
  // Opens after N consecutive Redis errors; probes after cooldown ms.
  // State visible in cache.metrics().l2CircuitBreaker.state
  l2CircuitBreakerThreshold:  5,      // default
  l2CircuitBreakerCooldownMs: 30_000, // default

  // ── Negative caching ──────────────────────────────────────────────────
  // Cache null/undefined fetchFn results for this many seconds globally.
  // Prevents repeated upstream calls for keys that genuinely don't exist.
  // Can be overridden per-call via opts.notFoundTtl in cache.get().
  notFoundTtl: 30, // seconds; 0 = disabled (default)

  // ── Startup warm-up ───────────────────────────────────────────────────
  // Auto-call warmFromL2(pattern) at construction time.
  // cache.ready() resolves once warm-up finishes — use as a k8s readiness gate.
  // No-op when Redis is disabled or unreachable.
  warmKeys: 'user:*',

  // ── Prometheus instance label ─────────────────────────────────────────
  // Adds an `instance` label to every metric in toPrometheusText().
  instanceName: 'api-us-east-1',

  // ── Cold-start snapshot ──────────────────────────────────────────────
  snapshotPath:              '/tmp/my-app-cache-snapshot.msgpack',
  snapshotMaxAgeMs:          2 * 60 * 60 * 1000,  // 2 hours (default)
  forbiddenSnapshotPrefixes: ['auth:', 'session:', 'mfa:', 'rate_limit:'],

  // ── Metrics callback ─────────────────────────────────────────────────
  metricsIntervalMs: 60_000,                       // emit every 60 s (default)
  onMetrics: (m) => myMonitoring.record(m),        // optional push callback

  // ── Per-operation hooks ───────────────────────────────────────────────
  // onHit fires on every L1, disk, or L2 hit with the caller-facing key (no prefix)
  // and the tier that served it. Lower latency than waiting for onMetrics.
  onHit:  (key, tier) => cloudwatch.putMetricData({ key, tier }),

  // onMiss fires when all three tiers are exhausted — before fetchFn is called.
  onMiss: (key) => cloudwatch.putMetricData({ key }),

  // ── Development mutation guard ────────────────────────────────────────
  // When true, every L1 hit value is deep-frozen before being returned.
  // Mutation attempts throw TypeError immediately in development.
  // Do NOT enable in production — deep-freezing large objects has measurable overhead.
  frozen: process.env.NODE_ENV !== 'production',
});
```

### Environment variables

| Variable | Purpose |
|---|---|
| `REDIS_HOST` | Redis/Valkey hostname (used when `redisHost` option is not set) |
| `CACHE_ENCRYPTION_KEY` | Base64-encoded 32-byte AES-256-GCM key |
| `NODE_ENV` | When `!== 'production'`, L2 Redis and TLS are disabled by default |

---

## 📖 API reference

### `CacheService.create(options?)` → `CacheService`

Returns the process-level singleton. Options are only applied on the **first** call per namespace — subsequent calls return the existing instance.

### `CacheService.createAsync(optionsOrPromise)` → `Promise<CacheService>`

Async factory that resolves a `Promise<CacheOptions>` before constructing the singleton. Useful when config is fetched from a secret store at startup.

```typescript
const cache = await CacheService.createAsync(fetchSecretsFromVault());
```

### `CacheService.reset(options?)` → `CacheService`

Destroys the existing singleton and creates a fresh one. Useful in tests.

### `cache.get<T>(key, fetchFn, ttlSeconds?, opts?)` → `Promise<T>`

Get from cache or call `fetchFn` on a miss. The inflight map ensures `fetchFn` fires at most once per key regardless of concurrency.

> **Reference semantics:** on an L1 hit, the returned value is the live JS object stored in the entry — not a deep copy. Mutating it will corrupt the cached entry. Deep-clone at the call site if you need an independent copy.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `key` | `string` | — | Cache key |
| `fetchFn` | `() => Promise<T>` | — | Called on a miss; result is cached |
| `ttlSeconds` | `number` | `300` | Hard TTL in seconds |
| `opts.swr` | `number` | `0` | Stale-While-Revalidate grace seconds |
| `opts.priority` | `CachePriority` | auto-inferred | Eviction priority override |
| `opts.refreshAhead` | `number` | — | Fraction `(0, 1]` of TTL — triggers background recompute when `remaining ≤ ttl × (1 - refreshAhead)` |
| `opts.xfetchBeta` | `number` | — | XFetch β ≥ 0 — scales probabilistic early recompute by last fetch duration; higher = recompute earlier |
| `opts.notFoundTtl` | `number` | — | Per-call TTL in seconds for `null`/`undefined` results (overrides global `notFoundTtl`) |
| `opts.tags` | `string[]` | — | Tags to register when `fetchFn` populates the entry on a miss; no-op on L1/L2 hits where tags are already registered |

### `cache.set<T>(key, data, ttlSeconds?, priority?, opts?)` → `Promise<void>`

Writes to L1 and (in production) L2. Publishes an invalidation to the backplane.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `opts.tags` | `string[]` | `[]` | Associate tags with this entry for group invalidation |
| `opts.dependsOn` | `string[]` | `[]` | Parent keys — when any parent is deleted, this entry is automatically evicted from L1 |

```typescript
await cache.set('product:1', data, 60, undefined, { tags: ['catalog', 'featured'] });

// Cascade invalidation: evicting 'org:42' also evicts 'org:42:members'
await cache.set('org:42:members', members, 300, undefined, { dependsOn: ['org:42'] });
await cache.delete('org:42'); // org:42:members is evicted too
```

### `cache.mget<T>(keys, fetchFn, ttl?, priority?)` → `Promise<(T | undefined)[]>`

Batch read. Returns L1-cached values for hot keys; calls `fetchFn` only with the keys that missed. Preserves input ordering.

`ttl` accepts a **plain number** (uniform TTL) or a **function `(key: string) => number`** (per-key TTL). The function is only called for miss keys — L1 hits are unaffected.

```typescript
// Uniform TTL
const [userA, userB] = await cache.mget(
  ['user:1', 'user:2'],
  (missKeys) => db.users.findByIds(missKeys).then(rowsToMap),
  300,
);

// Per-key TTL — heterogeneous data in one batch call
const results = await cache.mget(
  ['user:1', 'config:global', 'feature:flags'],
  fetchFn,
  (key) => key.startsWith('config:') ? 3600 : 300,
);
```

### `cache.mset<T>(entries)` → `Promise<void>`

Write multiple entries in a single call. Each entry accepts `value`, `ttl`, `priority`, and `tags`.

```typescript
await cache.mset({
  'user:1': { value: alice, ttl: 300, priority: CachePriority.HIGH, tags: ['users'] },
  'user:2': { value: bob,   ttl: 300 },
});
```

### `cache.mdel(keys)` → `Promise<void>`

Delete multiple keys in a single call. No-op for keys that do not exist.

```typescript
await cache.mdel(['user:1', 'user:2', 'user:3']);
```

### `cache.warmFromL2(pattern)` → `Promise<number>`

Scan Redis for keys matching a glob pattern (e.g. `'user:*'`) and load their values into L1 with a 10-minute TTL. Returns the number of keys loaded. Returns `0` immediately when Redis is disabled or unreachable — safe to call unconditionally at startup.

```typescript
// In your application startup
const loaded = await cache.warmFromL2('user:*');
console.log(`Pre-warmed ${loaded} user entries from Redis`);
```

### `cache.ready()` → `Promise<void>`

Returns a Promise that resolves once the cache is fully initialised. Without `warmKeys`, resolves immediately. With `warmKeys`, resolves once the automatic `warmFromL2` call completes.

Designed for k8s readiness probes — await before accepting traffic, then never call again:

```typescript
const cache = CacheService.create({ warmKeys: 'user:*' });

// k8s readiness probe endpoint
app.get('/ready', async (_req, res) => {
  await cache.ready();
  res.sendStatus(200);
});
```

### `cache.has(key)` → `boolean`

Return `true` if the key exists in L1 and has not expired. Bloom-filter fast-path — no fetch, no disk or Redis round-trip.

### `cache.ttl(key)` → `number | null`

Return the remaining TTL in **seconds** for a key currently held in L1. Returns `null` if the key is absent or expired. Does not fetch or consume the value.

```typescript
const remaining = cache.ttl('user:123'); // e.g. 247 (seconds left)
if (remaining !== null && remaining < 30) await cache.touch('user:123', 300);
```

### `cache.touch(key, newTtlSeconds)` → `Promise<boolean>`

Extend the TTL of a key in L1 (and fire-and-forget `EXPIRE` in Redis) without reading or re-fetching its value. Returns `false` if the key is absent or already expired.

### `cache.getIfFresh<T>(key)` → `T | null`

Return the L1 value only if it is **fresh** (not yet in the SWR grace window). Returns `null` when absent, expired, or stale — without triggering a revalidation.

```typescript
const fresh = cache.getIfFresh<User>('user:123');
if (fresh !== null) return fresh; // serve from L1, no network hop
```

### `cache.setIfAbsent<T>(key, value, ttlSeconds?)` → `Promise<boolean>`

Atomically write `value` only if `key` is not already cached. Checks L1 first, then attempts a Redis `SET NX EX`. Returns `true` if the value was written, `false` if a live entry already existed.

Useful for distributed lock-style writes, session initialisation, or any pattern where you must not overwrite an already-cached value.

```typescript
const written = await cache.setIfAbsent(`session:${id}`, sessionData, 3600);
if (!written) {
  // session already exists — do not overwrite
}
```

### `cache.hotKeys(n?)` → `Array<{ key: string; hits: number; sizeBytes: number }>`

Returns the top `n` live L1 keys ranked by Count-Min Sketch access frequency. Namespace prefix is stripped from each key. Expired entries are excluded. Default `n = 10`.

```typescript
const hot = cache.hotKeys(5);
// [
//   { key: 'user:1',    hits: 1024, sizeBytes: 512 },
//   { key: 'product:7', hits:  893, sizeBytes: 256 },
//   ...
// ]
```

### `cache.invalidateTag(tag)` → `Promise<void>`

Evict all entries associated with a tag from L1, disk, and Redis.

```typescript
await cache.set('product:1', data, 60, undefined, { tags: ['catalog'] });
await cache.set('product:2', data, 60, undefined, { tags: ['catalog'] });
await cache.invalidateTag('catalog'); // evicts both entries
```

### `cache.ping()` → `Promise<CachePingResult>`

Measure L1 / disk / Redis latency in milliseconds. Returns `{ l1, disk, l2 }` — `l2` is `null` when Redis is disabled. Suitable for health-check endpoints.

```typescript
app.get('/health', async (_req, res) => {
  const { l1, disk, l2 } = await cache.ping();
  res.json({ status: 'ok', latencyMs: { l1, disk, l2 } });
});
```

### `cache.drainToL2()` → `Promise<number>`

Pipeline all live L1 entries to Redis in a single round-trip. Returns the number of keys written. Useful for warming a new Redis node or zero-downtime failover.

### `cache.delete(key)` → `Promise<void>`

Deletes one exact key or a glob pattern (`user:abc:*`). Propagates to disk, Redis, and all backplane peers.

### `cache.clear(prefix?)` → `Promise<void>`

Flush all entries, or only those whose key starts with `prefix`. Propagates to disk and Redis.

```typescript
await cache.clear();           // flush everything
await cache.clear('session:'); // flush only session keys
```

### `cache.rebalance()` → `void`

Evict L1 entries that now violate the current category or global capacity limits. Useful when `categoryLimits` are tightened after startup — normally, existing entries are not re-evaluated until they expire naturally.

```typescript
// Tighten analytics limit at runtime, then immediately enforce it
cache.options.categoryLimits['analytics:'].maxEntries = 50;
cache.rebalance();
```

### `cache.increment(key, ttlSeconds?)` → `Promise<number>`

Redis `INCR` — atomically increments a counter, setting TTL on first write. When Redis is disabled, maintains an in-process counter with the same TTL semantics so rate-limiting works in dev/test.

### `cache.metrics()` → `CacheMetrics`

Returns a full metrics snapshot including hit rates, bloom filter stats, backplane counters, OOM eviction history, and tier sizes.

### `CacheService.toPrometheusText(metrics, prefix?, instanceName?)` → `string`

Converts a `CacheMetrics` snapshot to Prometheus text exposition format. Pass `instanceName` to add an `instance` label alongside `namespace`.

```typescript
app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(
    CacheService.toPrometheusText(cache.metrics(), 'tricache', 'api-us-east-1'),
  );
});
```

### `cache.stats()` → `{ l1, disk }`

Lightweight L1 and disk stats without the full metrics breakdown.

### `cache.writeSnapshot(altPath?)` / `cache.loadSnapshot()`

Manual snapshot control. Called automatically on `SIGTERM`/`SIGINT` — only needed when you manage shutdown yourself. `writeSnapshot()` accepts an optional path to write to an alternate location without touching the configured default snapshot file.

```typescript
// Graceful-shutdown hook — write to a dated backup path
process.on('SIGTERM', async () => {
  await cache.writeSnapshot(`/backups/cache-${Date.now()}.snap`);
  process.exit(0);
});
```

### `cache.keys()` → `Generator<string>`

Lazily yields the key for every live (non-expired) L1 entry. Namespace prefix is stripped automatically. Uses a dedicated generator that skips intermediate tuple allocation.

```typescript
for (const key of cache.keys()) console.log(key);
```

### `cache.values<T>()` → `Generator<T>`

Lazily yields the cached value for every live L1 entry. Returns the live deserialized object (same reference semantics as `get()`). Uses `yield*` delegation — no intermediate generator frame.

```typescript
for (const session of cache.values<Session>()) evict(session);
```

### `cache.entries<T>()` → `Generator<[string, T]>`

Lazily yields `[key, value]` pairs for every live L1 entry. Key has namespace prefix stripped.

```typescript
for (const [key, user] of cache.entries<User>()) sync(key, user);
```

> **JIT note:** all three generators iterate `SmartMemoryCache.cache` (a single `Map`). V8 maintains per-call-site type feedback; having three generator functions share the same Map means no single one gets the full monomorphic specialization budget. In practice the throughput impact is ≤5 % relative to each running in isolation. See [BENCHMARKS.md](BENCHMARKS.md) for numbers.

### `cache.destroy()` → `Promise<void>`

Closes the Redis connection, unsubscribes the backplane, and stops all background timers.

---

## 🎯 Priority levels

```typescript
import { CachePriority } from 'tricache';

CachePriority.LOW      // 1 — analytics, reports — evicted first
CachePriority.NORMAL   // 2 — general application data (default)
CachePriority.HIGH     // 3 — user profiles, config — evicted last
CachePriority.CRITICAL // 4 — never evicted while valid (auth tokens, sessions)
```

Priority is **auto-inferred** from the key when not specified:

| Key contains | Inferred priority |
|---|---|
| `auth:` or `session:` | `CRITICAL` |
| `user:`, `org:`, or `profile:` | `HIGH` |
| `analytics:`, `report:`, or `stats:` | `LOW` |
| anything else | `NORMAL` |

---

## 🧠 Eviction algorithm

L1 eviction uses **reservoir sampling** — an O(n) single pass samples 16 candidates, then sorts only those 16 (O(1)). Each candidate is scored:

```
score = priority × 1000 + min(hits, 100) × 10 + ttlRemaining/60s − age/60s
```

- Higher score = kept longer
- `CRITICAL` entries are excluded from sampling while valid
- When a category limit is breached, entries from that category receive a score penalty

---

## 🪵 Pluggable logger

Bring your own structured logger — tricache doesn't care if it's `pino`, `winston`, or `console`.

```typescript
import pino from 'pino';
const logger = pino();

CacheService.create({
  logger: {
    debug: (msg, meta) => logger.debug(meta ?? {}, msg),
    info:  (msg, meta) => logger.info(meta  ?? {}, msg),
    warn:  (msg, meta) => logger.warn(meta  ?? {}, msg),
    error: (msg, meta, err) => logger.error({ ...(meta ?? {}), err }, msg),
  },
});
```

---

## 🔐 Encryption

AES-256-GCM for L2 (Redis) values, disk spill files, and cold-start snapshots. Three modes are available via `encryptionMode`:

| Mode | Key length | Notes |
|---|---|---|
| `aes-256-gcm` | 32 bytes | **Default.** Authenticated encryption (AEAD). |
| `aes-128-gcm` | 16 bytes | ~15% faster than AES-256. Same AEAD guarantees. |
| `aes-128-ctr` | 16 bytes | Fastest cipher mode. AES-NI keystream, no auth tag. Use when integrity is guaranteed elsewhere (TLS, HMAC). |
| `xor` | any (≥ 16 bytes recommended) | **NOT cryptographic.** XOR obfuscation only. Dev/non-sensitive data. |

**Key generation:**

```bash
# AES-256 (32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# AES-128 / AES-128-CTR (16 bytes)
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"

# XOR — any length, minimum 16 bytes recommended
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```typescript
// AES-256-GCM (default)
CacheService.create({ encryptionKey: '<base64-32-bytes>' });

// AES-128-GCM
CacheService.create({ encryptionKey: '<base64-16-bytes>', encryptionMode: 'aes-128-gcm' });

// AES-128-CTR (fastest cipher, no auth tag)
CacheService.create({ encryptionKey: '<base64-16-bytes>', encryptionMode: 'aes-128-ctr' });

// XOR obfuscation (NOT cryptographic — dev/non-sensitive only)
CacheService.create({ encryptionKey: '<base64-key>', encryptionMode: 'xor' });

// or use the env var: CACHE_ENCRYPTION_KEY=<base64-key>
```

| Mode | Redis format | Disk / snapshot format |
|---|---|---|
| `aes-256-gcm` | `enc:v1:<base64(IV[12]\|Tag[16]\|CT)>` | `TRIC1ENC\|IV[12]\|Tag[16]\|CT[N]` |
| `aes-128-gcm` | `a128:v1:<base64(IV[12]\|Tag[16]\|CT)>` | `TRIC1128\|IV[12]\|Tag[16]\|CT[N]` |
| `aes-128-ctr` | `ctr:v1:<base64(IV[16]\|CT)>` | `TRIC1CTR\|IV[16]\|CT[N]` |
| `xor` | `xor:v1:<base64(key⊕data)>` | `TRIC1XOR\|key⊕data[N]` |

Existing plaintext values are read transparently during key rotation.

### Zero-downtime key rotation

Set `previousEncryptionKey` to your old key while rolling out a new one. The cache tries the current key first; if decryption fails it transparently retries with the previous key. Remove `previousEncryptionKey` once all old entries have expired.

```typescript
CacheService.create({
  encryptionKey:         process.env.NEW_ENCRYPTION_KEY, // new AES-256 key
  previousEncryptionKey: process.env.OLD_ENCRYPTION_KEY, // fallback for old entries
  // previousEncryptionMode defaults to current encryptionMode
});
```

---

## ⚡ WASM Bloom filter

A 100,000-bit filter with k=7 hash probes:

- At the default `l1MaxEntries: 2,000` — false-positive rate ≈ **0.01%**
- At rated capacity (~18,000 entries) — false-positive rate ≈ **1%**
- The filter rebuilds automatically when stale bits from deleted/expired entries accumulate

Mechanics:
- `mightContain(key) === false` → **guaranteed miss** — the Map lookup is skipped entirely
- `mightContain(key) === true` → probable hit — the Map is checked to confirm

The 562-byte WASM binary is inlined as Base64 — zero filesystem access at runtime. Falls back to a pure-JS implementation if `WebAssembly` is unavailable.

---

## 📊 Performance

Measured on a single Node.js thread (no `await` on synchronous paths):

**L1 SmartMemoryCache**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — hot hit (8K entries) | **2.81 M/s** | 356 ns | bloom → Map lookup → return cached value |
| `get` — cold miss | **7.14 M/s** | 140 ns | bloom gates → early return |
| `set` — tiny payload | 899 K/s | 1.11 µs | pack() + Map.set + bloom.add |
| `set` — small payload (≈ 512 B) | 554 K/s | 1.81 µs | pack() same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 205.3 K/s | 4.87 µs | pack() larger payload |
| `set` — CRITICAL priority | 730.1 K/s | 1.37 µs | same set path; skipped in eviction sort |
| `delete` — exact key | **5.36 M/s** | 186 ns | Map.delete |
| `deletePattern` — glob wildcard | 7.2 K/s | 138 µs | O(n) Map scan |
| Count-Min Sketch estimate | **3.37 M/s** | 297 ns | 4 row lookups — called on every `get()` hit and `set()` |

**Iterator interface (L1 live entries, 500 entries)**

| Method | Throughput | Latency | Notes |
|---|---|---|---|
| `cache.keys()` | 26.6 K/s | 37.53 µs | no `[key,entry]` tuple allocation |
| `cache.values()` | 35.5 K/s | 28.19 µs | `yield*` delegation |
| `cache.entries()` | 24.0 K/s | 41.73 µs | `[strippedKey, value]` pairs |
| raw `Map` iteration (baseline) | 277.2 K/s | 3.61 µs | no expiry check, no generator overhead |

**CacheService (end-to-end)**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | **2.03 M/s** | 491 ns | inflight check → l1.get → return cached value |
| `get` — SWR stale serve | **1.78 M/s** | 562 ns | serves stale; revalidates async |
| `get` — miss + fetchFn | 13.7 K/s | 73 µs | Promise microtask + l1.set |
| `set` | 28.7 K/s | 34.86 µs | l1.set + disk.save (fire-and-forget) |
| `delete` — exact key | 7.3 K/s | 137.82 µs | l1.delete + disk.delete + backplane |
| `delete` — glob `*` | 687 K/s | 1.46 µs | l1.deletePattern O(n) + disk glob |

**Encryption** (IV pool, pre-allocated output buffers)

| Mode | Payload | Encrypt | Decrypt |
|---|---|---|---|
| AES-256-GCM | 64 B | 140.4 K/s / 7.12 µs | 155.5 K/s / 6.43 µs |
| AES-256-GCM | 512 B | 103.1 K/s / 9.70 µs | 142.9 K/s / 6.99 µs |
| AES-256-GCM | 4 KB | 58.4 K/s / 17.12 µs | 48.0 K/s / 20.84 µs |
| AES-128-GCM | 64 B | 148.8 K/s / 6.72 µs | 173.0 K/s / 5.78 µs |
| AES-128-GCM | 512 B | 135.7 K/s / 7.37 µs | 158.8 K/s / 6.30 µs |
| AES-128-GCM | 4 KB | 70.2 K/s / 14.24 µs | 53.2 K/s / 18.79 µs |
| AES-128-CTR | 64 B | 187.9 K/s / 5.32 µs | 196.9 K/s / 5.08 µs |
| AES-128-CTR | 512 B | 183.5 K/s / 5.45 µs | 185.6 K/s / 5.39 µs |
| AES-128-CTR | 4 KB | 78.4 K/s / 12.75 µs | 71.8 K/s / 13.93 µs |
| XOR _(obfuscation only)_ | 64 B | 2.43 M/s / 412 ns | 2.10 M/s / 476 ns |
| XOR _(obfuscation only)_ | 512 B | 665.5 K/s / 1.50 µs | 715.3 K/s / 1.40 µs |
| XOR _(obfuscation only)_ | 4 KB | 114.5 K/s / 8.73 µs | 77.6 K/s / 12.89 µs |

> AES and XOR string-path numbers shown (Redis L2). Buffer path (disk/snapshot) is 5–20% faster — no base64 overhead.  
> AES-128-GCM is 5–50% faster than AES-256-GCM depending on payload (gap widens at mid-range sizes on AES-NI hardware).  
> AES-128-CTR removes the GHASH MAC step: ~50% faster than AES-128-GCM at small payloads; use only when integrity is guaranteed by transport.  
> XOR numbers are for the buffer path (32-bit word-level XOR, 4 bytes/iteration). XOR dominates at small payloads (no cipher setup) and remains ~2× faster than AES at 4 KB.

See [BENCHMARKS.md](BENCHMARKS.md) for the full breakdown: bloom filter cost, serialization by payload size, eviction pressure, concurrency analysis, multi-tenancy isolation, and a realistic 80/15/5 read/miss/write workload.

---

## 🤝 Contributing

Bug reports and pull requests are welcome!

1. Fork the repo and create a feature branch
2. Run `pnpm test` — all tests must pass
3. Run `pnpm bench` if you touch a hot path and include before/after numbers in your PR
4. Open your PR against `master`

> New to the codebase? Start with [src/cache-service.ts](src/cache-service.ts) for the public API and [src/smart-memory-cache.ts](src/smart-memory-cache.ts) for the L1 engine.

---

## 🛡️ Security

Found a vulnerability? **Please don't open a public issue.** Report it privately via [GitHub Security Advisories](https://github.com/Kareem411/TriCache/security/advisories/new) so it can be patched before disclosure.

For encryption key generation and rotation best practices, see the [Encryption](#-encryption) section.

---

## 📄 License

MIT
