# TriCache

[![CI](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml/badge.svg)](https://github.com/Kareem411/TriCache/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/tricache.svg)](https://www.npmjs.com/package/tricache)
[![npm downloads](https://img.shields.io/npm/dm/tricache.svg)](https://www.npmjs.com/package/tricache)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20%7C%206.x-blue)](https://www.typescriptlang.org)
[![L1 get](https://img.shields.io/badge/L1%20get-2.65%20M%2Fs-brightgreen)](BENCHMARKS.md)
[![Thundering herd](https://img.shields.io/badge/thundering%20herd-100%25%20coalesced-brightgreen)](BENCHMARKS.md)

tricache is an extremely fast three-tier Node.js cache library. It serves warm reads at **2.65 million operations per second** from a single thread — over 100× faster than a localhost Redis round-trip and below any network latency floor. When L1 fills, evicted entries spill to a local NVMe disk tier rather than being dropped, keeping hit rates high without unbounded RAM growth. Cache misses that reach L2 (Redis or Valkey) are automatically coalesced: no matter how many concurrent callers miss the same key, `fetchFn` fires exactly once. See the [performance section](#-performance) for full numbers. Stale-While-Revalidate, AES-256-GCM at-rest encryption, pub/sub fleet-wide invalidation, OOM guard, cold-start snapshots, and Prometheus metrics are also supported through optional configuration — with zero required fields to get started.

<img src="https://raw.githubusercontent.com/Kareem411/TriCache/master/public/SmartMemoryCache_DiskTier.jpeg" width="600" alt="tricache architecture" />

---

## ✨ Features

| Feature | Detail |
|---|---|
| **Adaptive eviction** | LFU × LRU × priority score; reservoir-sampled O(1) hot path; category limits prevent any prefix monopolising RAM |
| **WASM Bloom filter** | 562-byte binary inlined as Base64 — O(k=7) guaranteed-miss detection, no filesystem access, pure-JS fallback |
| **msgpackr serialization** | All entries packed with msgpackr — uniform binary format, no JSON at any payload size |
| **Stale-While-Revalidate** | Serve stale instantly, revalidate in background — zero added latency on cache hit |
| **Stale-if-error** | Extend a stale entry's TTL when SWR revalidation fails — no errors served during upstream outages |
| **Thundering-herd prevention** | Inflight `Promise` registry — only one `fetchFn` call per key regardless of concurrency |
| **Pub/sub invalidation backplane** | Redis pub/sub channel propagates deletes across all instances in real time |
| **Tag-based invalidation** | Tag entries on write; `invalidateTag('catalog')` evicts all matching entries from L1, disk, and Redis atomically |
| **Batch read** | `mget()` collects L1 hits, calls `fetchFn` only for misses, preserves ordering |
| **OOM guard** | Polls `heapUsed/heapTotal` on a timer; emergency-evicts coldest L1 entries before the process crashes |
| **Cold-start snapshot** | L1 serialised to disk on `SIGTERM`/`SIGINT`, reloaded on next startup — warm cache, cold process |
| **AES-256-GCM encryption** | L2 (Redis) values, disk spill files, and snapshots encrypted at rest; zero-downtime key rotation via `previousEncryptionKey` |
| **Prometheus metrics** | `cache.metrics()` + `CacheService.toPrometheusText()` — drop into any `/metrics` endpoint |
| **Distributed counter** | `cache.increment()` backed by Redis `INCR` for distributed rate limiting; in-process fallback when Redis is disabled |
| **Pluggable logger** | Bring your own `pino`, `winston`, etc. |
| **L2 read-only mode** | `l2WriteMode: 'read-only'` reads from Redis but skips all writes — canary deploys, read replicas |
| **Eviction callback** | `onEviction(key, reason)` fires on every L1 eviction with a typed reason string |

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

### `cache.set<T>(key, data, ttlSeconds?, priority?, opts?)` → `Promise<void>`

Writes to L1 and (in production) L2. Publishes an invalidation to the backplane.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `opts.tags` | `string[]` | `[]` | Associate tags with this entry for group invalidation |

```typescript
await cache.set('product:1', data, 60, undefined, { tags: ['catalog', 'featured'] });
```

### `cache.mget<T>(keys, fetchFn, ttlSeconds?, priority?)` → `Promise<(T | undefined)[]>`

Batch read. Returns L1-cached values for hot keys; calls `fetchFn` only with the keys that missed. Preserves input ordering.

```typescript
const [userA, userB] = await cache.mget(
  ['user:1', 'user:2'],
  (missKeys) => db.users.findByIds(missKeys).then(rowsToMap),
  300,
);
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
| `get` — hot hit (8K entries) | **2.65 M/s** | 377 ns | bloom → Map lookup → return cached value |
| `get` — cold miss | **6.77 M/s** | 148 ns | bloom gates → early return |
| `set` — tiny payload | 915 K/s | 1.09 µs | pack() + Map.set + bloom.add |
| `set` — small payload (≈ 512 B) | 562 K/s | 1.78 µs | pack() same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 213.6 K/s | 4.68 µs | pack() larger payload |
| `set` — CRITICAL priority | 489.7 K/s | 2.04 µs | same set path; skipped in eviction sort |
| `delete` — exact key | **4.40 M/s** | 227 ns | Map.delete |
| `deletePattern` — glob wildcard | 7.1 K/s | 141 µs | O(n) Map scan |

**CacheService (end-to-end)**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | **2.16 M/s** | 462 ns | inflight check → l1.get → return cached value |
| `get` — SWR stale serve | **2.04 M/s** | 491 ns | serves stale; revalidates async |
| `get` — miss + fetchFn | 14.2 K/s | 70 µs | Promise microtask + l1.set |
| `set` | 32.3 K/s | 30.93 µs | l1.set + disk.save (fire-and-forget) |
| `delete` — exact key | 6.5 K/s | 154 µs | l1.delete + disk.delete + backplane |
| `delete` — glob `*` | 781.5 K/s | 1.28 µs | l1.deletePattern O(n) + disk glob |

**Encryption** (IV pool, pre-allocated output buffers)

| Mode | Payload | Encrypt | Decrypt |
|---|---|---|---|
| AES-256-GCM | 64 B | 114 K/s / 8.75 µs | 133 K/s / 7.52 µs |
| AES-256-GCM | 512 B | 70.3 K/s / 14.21 µs | 114 K/s / 8.80 µs |
| AES-256-GCM | 4 KB | 41.7 K/s / 23.99 µs | 43.0 K/s / 23.24 µs |
| AES-128-GCM | 64 B | 127 K/s / 7.89 µs | 145 K/s / 6.91 µs |
| AES-128-GCM | 512 B | 90.8 K/s / 11.01 µs | 132 K/s / 7.59 µs |
| AES-128-GCM | 4 KB | 48.9 K/s / 20.47 µs | 42.9 K/s / 23.32 µs |
| AES-128-CTR | 64 B | 181 K/s / 5.51 µs | 192 K/s / 5.21 µs |
| AES-128-CTR | 512 B | 175 K/s / 5.71 µs | 182 K/s / 5.50 µs |
| AES-128-CTR | 4 KB | 61.8 K/s / 16.18 µs | 54.0 K/s / 18.51 µs |
| XOR _(obfuscation only)_ | 64 B | 2.37 M/s / 422 ns | 2.11 M/s / 475 ns |
| XOR _(obfuscation only)_ | 512 B | 598 K/s / 1.67 µs | 513 K/s / 1.95 µs |
| XOR _(obfuscation only)_ | 4 KB | 82.7 K/s / 12.09 µs | 146 K/s / 6.84 µs |

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
