# tricache

**Three-tier Node.js cache with adaptive eviction, disk spill, Redis/Valkey L2, AES-256-GCM at-rest encryption, WASM Bloom filter, Stale-While-Revalidate, thundering-herd prevention, and Prometheus metrics.**

```
Request
  │
  ▼
L1 — SmartMemoryCache   (in-process RAM, 200 MB default, adaptive LFU×LRU×priority eviction)
  │ miss
  ▼
L1.5 — DiskTier         (NVMe spill, 500 MB default, 2–100 µs, holds evicted L1 entries)
  │ miss
  ▼
L2 — Redis / Valkey     (distributed, production-only by default, pub/sub invalidation)
  │ miss
  ▼
fetchFn()               (your database / API call — fires exactly once per key under load)
```

---

## Features

| Feature | Detail |
|---|---|
| **Adaptive eviction** | LFU × LRU × priority score; reservoir-sampled O(1) hot path; category limits prevent any prefix monopolising RAM |
| **WASM Bloom filter** | 562-byte binary inlined as Base64 — O(k=7) guaranteed-miss detection, no filesystem access, pure-JS fallback |
| **msgpackr serialization** | All entries packed with msgpackr — uniform binary format, no JSON at any payload size |
| **Stale-While-Revalidate** | Serve stale instantly, revalidate in background — zero added latency on cache hit |
| **Thundering-herd prevention** | Inflight `Promise` registry — only one `fetchFn` call per key regardless of concurrency |
| **Pub/sub invalidation backplane** | Redis pub/sub channel propagates deletes across all instances in real time |
| **OOM guard** | Polls `heapUsed/heapTotal` on a timer; emergency-evicts coldest L1 entries before the process crashes |
| **Cold-start snapshot** | L1 serialised to disk on `SIGTERM`/`SIGINT`, reloaded on next startup — warm cache, cold process |
| **AES-256-GCM encryption** | L2 (Redis) values, disk spill files, and snapshots encrypted at rest |
| **Prometheus metrics** | `cache.metrics()` + `CacheService.toPrometheusText()` — drop into any `/metrics` endpoint |
| **Distributed counter** | `cache.increment()` backed by Redis `INCR` for distributed rate limiting |
| **Pluggable logger** | Bring your own `pino`, `winston`, etc. |

---

## Install

```bash
npm install tricache
# or
pnpm add tricache
```

---

## Quick start

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

// Prometheus metrics
const snap = cache.metrics();
console.log(CacheService.toPrometheusText(snap));
```

---

## Configuration

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

## API reference

### `CacheService.create(options?)` → `CacheService`

Returns the process-level singleton. Options are only applied on the **first** call per namespace — subsequent calls return the existing instance.

### `CacheService.reset(options?)` → `CacheService`

Destroys the existing singleton and creates a fresh one. Useful in tests.

### `cache.get<T>(key, fetchFn, ttlSeconds?, opts?)` → `Promise<T>`

Get from cache or call `fetchFn` on a miss. The inflight map ensures `fetchFn` fires at most once per key regardless of concurrency.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `key` | `string` | — | Cache key |
| `fetchFn` | `() => Promise<T>` | — | Called on a miss; result is cached |
| `ttlSeconds` | `number` | `300` | Hard TTL in seconds |
| `opts.swr` | `number` | `0` | Stale-While-Revalidate grace seconds |
| `opts.priority` | `CachePriority` | auto-inferred | Eviction priority override |

### `cache.set<T>(key, data, ttlSeconds?, priority?)` → `Promise<void>`

Writes to L1 and (in production) L2. Publishes an invalidation to the backplane.

### `cache.delete(key)` → `Promise<void>`

Deletes one exact key or a glob pattern (`user:abc:*`). Propagates to disk, Redis, and all backplane peers.

### `cache.increment(key, ttlSeconds?)` → `Promise<number>`

Redis `INCR` — atomically increments a counter, setting TTL on first write. Returns `0` when Redis is disabled (safe for dev).

### `cache.metrics()` → `CacheMetrics`

Returns a full metrics snapshot including hit rates, bloom filter stats, backplane counters, OOM eviction history, and tier sizes.

### `CacheService.toPrometheusText(metrics, prefix?)` → `string`

Converts a `CacheMetrics` snapshot to Prometheus text exposition format. Paste into your `/metrics` route.

```typescript
app.get('/metrics', (_req, res) => {
  res.type('text/plain').send(CacheService.toPrometheusText(cache.metrics()));
});
```

### `cache.stats()` → `{ l1, disk }`

Lightweight L1 and disk stats without the full metrics breakdown.

### `cache.writeSnapshot()` / `cache.loadSnapshot()`

Manual snapshot control. Called automatically on `SIGTERM`/`SIGINT` — only needed when you manage shutdown yourself.

### `cache.destroy()` → `Promise<void>`

Closes the Redis connection, unsubscribes the backplane, and stops all background timers.

---

## Priority levels

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

## Eviction algorithm

L1 eviction uses **reservoir sampling** — an O(n) single pass samples 16 candidates, then sorts only those 16 (O(1)). Each candidate is scored:

```
score = priority × 1000 + min(hits, 100) × 10 + ttlRemaining/60s − age/60s
```

- Higher score = kept longer
- `CRITICAL` entries are excluded from sampling while valid
- When a category limit is breached, entries from that category receive a score penalty

---

## Pluggable logger

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

## Encryption

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

---

## WASM Bloom filter

A 100,000-bit filter with k=7 hash probes:

- At the default `l1MaxEntries: 2,000` — false-positive rate ≈ **0.01%**
- At rated capacity (~18,000 entries) — false-positive rate ≈ **1%**
- The filter rebuilds automatically when stale bits from deleted/expired entries accumulate

Mechanics:
- `mightContain(key) === false` → **guaranteed miss** — the Map lookup is skipped entirely
- `mightContain(key) === true` → probable hit — the Map is checked to confirm

The 562-byte WASM binary is inlined as Base64 — zero filesystem access at runtime. Falls back to a pure-JS implementation if `WebAssembly` is unavailable.

---

## Performance

Measured on a single Node.js thread (no `await` on synchronous paths):

**L1 SmartMemoryCache**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — hot hit (8K entries) | 1.24 M/s | 807 ns | bloom → Map lookup |
| `get` — cold miss | 7.32 M/s | 137 ns | bloom gates → early return |
| `set` — tiny payload | 1.03 M/s | 974 ns | pack() + Map.set + bloom.add |
| `set` — small payload (≈ 512 B) | 519 K/s | 1.93 µs | pack() same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 225 K/s | 4.44 µs | pack() larger payload |
| `set` — CRITICAL priority | 693 K/s | 1.44 µs | same set path; skipped in eviction sort |
| `delete` — exact key | 3.08 M/s | 325 ns | Map.delete |
| `deletePattern` — glob wildcard | 7.1 K/s | 141 µs | O(n) Map scan |

**CacheService (end-to-end)**

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | 1.39 M/s | 720 ns | inflight check → l1.get |
| `get` — SWR stale serve | 1.34 M/s | 744 ns | serves stale; revalidates async |
| `get` — miss + fetchFn | 17.8 K/s | 56.2 µs | Promise microtask + l1.set |
| `set` | 28.3 K/s | 35.3 µs | l1.set + disk.save (fire-and-forget) |
| `delete` — exact key | 29.7 K/s | 33.6 µs | l1.delete + disk.delete + backplane |
| `delete` — glob `*` | 723 K/s | 1.38 µs | l1.deletePattern O(n) + disk glob |

**Encryption** (IV pool, pre-allocated output buffers)

| Mode | Payload | Encrypt | Decrypt |
|---|---|---|---|
| AES-256-GCM | 64 B | 129 K/s / 7.78 µs | 147 K/s / 6.80 µs |
| AES-256-GCM | 512 B | 120 K/s / 8.33 µs | 103 K/s / 9.72 µs |
| AES-256-GCM | 4 KB | 56.3 K/s / 17.8 µs | 46.3 K/s / 21.6 µs |
| AES-128-GCM | 64 B | 116 K/s / 8.66 µs | 153 K/s / 6.55 µs |
| AES-128-GCM | 512 B | 125 K/s / 7.99 µs | 141 K/s / 7.12 µs |
| AES-128-GCM | 4 KB | 58.6 K/s / 17.1 µs | 55.1 K/s / 18.2 µs |
| AES-128-CTR | 64 B | 142 K/s / 7.02 µs | 194 K/s / 5.15 µs |
| AES-128-CTR | 512 B | 181 K/s / 5.54 µs | 190 K/s / 5.25 µs |
| AES-128-CTR | 4 KB | 85.5 K/s / 11.7 µs | 60.0 K/s / 16.7 µs |
| XOR _(obfuscation only)_ | 64 B | 2.34 M/s / 428 ns | 1.88 M/s / 531 ns |
| XOR _(obfuscation only)_ | 512 B | 549 K/s / 1.82 µs | 893 K/s / 1.12 µs |
| XOR _(obfuscation only)_ | 4 KB | 102 K/s / 9.86 µs | 181 K/s / 5.51 µs |

> AES and XOR string-path numbers shown (Redis L2). Buffer path (disk/snapshot) is 5–20% faster — no base64 overhead.  
> AES-128-GCM is 5–50% faster than AES-256-GCM depending on payload (gap widens at mid-range sizes on AES-NI hardware).  
> AES-128-CTR removes the GHASH MAC step: ~50% faster than AES-128-GCM at small payloads; use only when integrity is guaranteed by transport.  
> XOR numbers are for the buffer path (32-bit word-level XOR, 4 bytes/iteration). XOR dominates at small payloads (no cipher setup) and remains ~2× faster than AES at 4 KB.

Run `pnpm bench` for a full breakdown including bloom filter cost, compression trade-offs, eviction pressure, concurrency, and a realistic 80/15/5 read/miss/write workload.

---

## License

MIT
