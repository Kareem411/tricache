/**
 * tricache — shared types and interfaces
 */

// ─── Logger ─────────────────────────────────────────────────────────────────

// ─── OpenTelemetry tracer interface ──────────────────────────────────────────

/**
 * Minimal span interface — structurally compatible with `@opentelemetry/api` Span.
 * Pass your existing OTEL tracer; no extra package required.
 */
export interface ICacheSpan {
  setAttribute(key: string, value: string | number | boolean): this;
  setStatus(status: { code: 0 | 1 | 2; message?: string }): this;
  end(): void;
}

/**
 * Minimal tracer interface — structurally compatible with `@opentelemetry/api` Tracer.
 */
export interface ICacheTracer {
  startSpan(name: string): ICacheSpan;
}

/** Minimal logger interface — plug in any logger (pino, winston, console, etc.) */
export interface ILogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>, err?: Error): void;
}

/** Default no-op logger — swap out via CacheService options */
export const consoleLogger: ILogger = {
  debug: (msg, meta) => {},
  info:  (msg, meta) => console.info('[tricache]', msg, meta ?? ''),
  warn:  (msg, meta) => console.warn('[tricache]', msg, meta ?? ''),
  error: (msg, meta, err) => console.error('[tricache]', msg, meta ?? '', err ?? ''),
};

// ─── Eviction reason ────────────────────────────────────────────────────────

/**
 * Reason passed to the `onEviction` callback.
 * - `'capacity'`  — L1 over-capacity; evicted during a `set()` call
 * - `'category'`  — Per-category limit exceeded
 * - `'rebalance'` — `cache.rebalance()` was called
 * - `'oom'`       — OOM guard emergency eviction
 * - `'ttl'`       — Entry expired during periodic cleanup
 * - `'manual'`    — Explicit `cache.delete()` call
 */
export type EvictionReason = 'capacity' | 'category' | 'rebalance' | 'oom' | 'ttl' | 'manual';

// ─── Ping result ─────────────────────────────────────────────────────────────

/** Per-tier latency returned by `cache.ping()`. */
export interface CachePingResult {
  /** L1 RAM check latency in milliseconds */
  l1:   number;
  /** L1.5 disk stats access in milliseconds */
  disk: number;
  /** L2 Redis PING round-trip in milliseconds, or `null` when Redis is disabled */
  l2:   number | null;
}

// ─── Cache priorities ────────────────────────────────────────────────────────

/** Priority levels for L1 eviction — higher = less likely to be evicted */
export enum CachePriority {
  LOW      = 1, // Easily regenerated (analytics, reports)
  NORMAL   = 2, // General data
  HIGH     = 3, // Frequently accessed (profiles, config)
  CRITICAL = 4, // Must never be evicted unless expired (auth tokens, active sessions)
}

// ─── Internal L1 entry shape ─────────────────────────────────────────────────

/** Internal representation of a single cache entry in the L1 Map */
export interface SmartCacheEntry {
  /** msgpackr-packed binary payload — used for disk spill and snapshot serialization */
  data: Buffer;
  /**
   * Deserialized JS value, cached at write time so hot reads skip the unpack step entirely.
   * Undefined for entries restored from disk/snapshot (populated lazily on first access).
   * NOTE: returned by reference — callers should treat the value as immutable.
   */
  value?: unknown;
  /** always true for entries written by the current code;
   *  may be false in legacy snapshots/disk files — handled transparently on import */
  isCompressed: boolean;
  /** Hard expiry — entry is deleted after this timestamp */
  expiresAt: number;
  /** SWR soft expiry — serve stale + revalidate in background when past this */
  staleAt?: number;
  /** Exact byte size of the stored value */
  size: number;
  /** Access count (LFU numerator) */
  hits: number;
  /** Last access timestamp (LRU comparator) */
  lastAccess: number;
  /** Eviction priority */
  priority: CachePriority;
  /** Original TTL in ms at write time — used by refresh-ahead to compute the proactive refresh threshold. */
  ttlMs?: number;
  /** Milliseconds taken to fetch/compute this value — used by XFetch probabilistic early expiration. */
  delta?: number;
}

/** Returned by SmartMemoryCache.get() — distinguishes "cached null" from a real miss */
export interface CacheHit {
  value: unknown;
  /** true = past soft TTL (staleAt) but within hard expiry → SWR path */
  isStale: boolean;
  /** Hard expiry timestamp — lets CacheService.get() do refresh-ahead / XFetch math
   *  without a second Map lookup (eliminates the duplicate l1.getEntry() call). */
  expiresAt: number;
  /** Original TTL in ms stored at write time — for refresh-ahead fraction calculation */
  ttlMs?: number;
  /** Fetch duration in ms stored at write time — for XFetch probabilistic threshold */
  delta?: number;
  /** Timestamp (Date.now()) recorded inside SmartMemoryCache.get() — lets CacheService
   *  reuse this value for refresh-ahead/XFetch math instead of making a second syscall. */
  fetchedAt?: number;
}

// ─── Disk tier ───────────────────────────────────────────────────────────────

/** On-disk entry shape (mirrors SmartCacheEntry — Uint8Array accepted for msgpack round-trips;
 *  legacy disk files written by older versions may have a JSON string in data) */
export interface DiskCacheEntry {
  data: string | Buffer | Uint8Array;
  isCompressed: boolean;
  expiresAt: number;
  staleAt?: number;
  size: number;
  hits: number;
  lastAccess: number;
  priority: number;
}

// ─── Metrics snapshot ────────────────────────────────────────────────────────

/**
 * Snapshot of runtime metrics for a CacheService instance.
 * Returned by `CacheService.metrics()` and passed to the `onMetrics` callback.
 * Convert to Prometheus text with `CacheService.toPrometheusText(metrics)`.
 */
export interface CacheMetrics {
  /** Configured namespace (empty string = no namespace) */
  namespace: string;
  /** Milliseconds since the CacheService instance was constructed */
  uptimeMs:  number;

  gets: {
    total:             number;
    l1Hits:            number;
    /** Fraction of gets served from L1 RAM cache (0–1) */
    l1HitRate:         number;
    diskHits:          number;
    /** Fraction of gets served from L1.5 disk tier (0–1) */
    diskHitRate:       number;
    l2Hits:            number;
    /** Fraction of gets served from L2 Redis (0–1) */
    l2HitRate:         number;
    /** fetchFn calls (cache misses that fell through to the DB) */
    fetches:           number;
    /** Fraction of gets that called fetchFn (0–1) */
    fetchRate:         number;
    /** Concurrent get() calls deduplicated by the stampede guard */
    stampedePrevented: number;
  };

  sets:          { total: number };
  deletes:       { total: number };
  revalidations: { total: number };

  bloom: {
    /** Total bloom-filter checks (get() calls that passed prefix filter) */
    checksTotal:       number;
    /**
     * Times the filter said "might contain" but the key was absent in L1.
     * A high rate suggests the bloom filter capacity needs increasing.
     */
    falsePositives:    number;
    /** falsePositives / checksTotal (0–1; ideal < 0.01) */
    falsePositiveRate: number;
  };

  compression: {
    entriesCompressed:   number;
    entriesUncompressed: number;
    /** Approximate bytes saved by msgpackr vs raw JSON */
    bytesSaved:          number;
  };

  /** Pub/Sub invalidation backplane statistics */
  backplane: {
    enabled:  boolean;
    /** Invalidation messages published to other instances */
    sent:     number;
    /** Invalidation messages received from other instances */
    received: number;
    /** Own messages silently skipped (prevents double-eviction) */
    skipped:  number;
  };

  /** L2 Redis circuit breaker state */
  l2CircuitBreaker: {
    /** `'closed'` = normal; `'open'` = Redis paused; `'half_open'` = probing recovery */
    state: 'closed' | 'open' | 'half_open';
  };

  /** OOM guard statistics */
  oom: {
    enabled:         boolean;
    /** Number of emergency L1 eviction rounds triggered */
    evictions:       number;
    /** Timestamp of the most recent OOM eviction, or null */
    lastTriggeredAt: number | null;
  };

  l1:   { entries: number; sizeBytes: number; maxBytes: number };
  disk: { files: number; sizeKB: number; maxKB: number; disabled: boolean };

  /** Adaptive TTL statistics — present only when `adaptiveTtl` is enabled */
  adaptiveTtl?: {
    enabled: true;
    /** Number of unique keys currently tracked in the latency ring buffers */
    trackedKeys: number;
    /**
     * Top-20 slowest keys by p95 fetch latency, sorted descending.
     * Keys are shown without the instance namespace prefix.
     * Only keys with ≥ 5 recorded samples appear here.
     */
    slowestKeys: Array<{ key: string; p95Ms: number; adaptedTtlSec: number }>;
  };
}

// ─── Configuration ───────────────────────────────────────────────────────────

/** Per-category memory limits for L1 */
export interface CategoryLimit {
  maxEntries: number;
  maxSizeBytes: number;
}

/**
 * Options accepted by CacheService.create()
 *
 * All fields are optional — sensible defaults are used when omitted.
 */
export interface CacheOptions {
  /**
   * Plug in your own logger (pino, winston, bunyan, …).
   * Defaults to a minimal console logger that only prints warn/error.
   */
  logger?: ILogger;

  // ── L1 (in-memory) ────────────────────────────────────────────────────────
  /** Max total bytes held in L1 RAM cache. Default: 200 MB */
  l1MaxBytes?: number;
  /** Max total entries in L1. Default: 2000 */
  l1MaxEntries?: number;
  /**
   * Fraction of `l1MaxEntries` / `l1MaxBytes` at which proactive eviction fires
   * before the hard limit is reached. Range: 0–1. Default: 0.9.
   * Lower (e.g. 0.8) reduces GC pressure at the cost of slightly more eviction work.
   */
  l1EvictionWatermark?: number;
  /**
   * Per-category limits keyed by the key prefix (e.g. `'org:'`).
   * Merged over the built-in defaults.
   */
  categoryLimits?: Record<string, CategoryLimit>;
  /**
   * Key prefixes that are never written to disk snapshots or the disk tier.
   * Default: ['auth:', 'session:', 'mfa:', 'rate_limit:']
   */
  forbiddenSnapshotPrefixes?: string[];

  // ── L1.5 (disk tier) ────────────────────────────────────────────────────
  /** Directory used for L1.5 disk-spill files. Default: os.tmpdir()/tricache-disk */
  diskCacheDir?: string;
  /** Max total bytes for the disk tier. Default: 500 MB */
  diskMaxBytes?: number;
  /** Max bytes for a single disk entry. Default: 10 MB */
  diskEntryMaxBytes?: number;

  // ── L2 (Redis) ────────────────────────────────────────────────────────────
  /**
   * Redis/Valkey hostname (no `redis://` prefix).
   * Falls back to the `REDIS_HOST` environment variable.
   * When neither is provided, L2 is disabled.
   */
  redisHost?: string;
  /** Redis port. Default: 6379 */
  redisPort?: number;
  /**
   * Whether to enable TLS for the Redis connection. Default: true in production,
   * false otherwise.
   */
  redisTls?: boolean;
  /**
   * Set to `true` to disable L2 Redis entirely (e.g. when running single-process
   * services that don't need distributed caching). Default: false in production,
   * true in development.
   */
  disableRedis?: boolean;

  // ── Encryption ────────────────────────────────────────────────────────────
  /**
   * Base64-encoded 32-byte AES-256-GCM key for encrypting L2 (Redis) values and
   * disk-tier files at rest. Falls back to `CACHE_ENCRYPTION_KEY` env var.
   * If not provided in production, a warning is logged and data is stored plaintext.
   */
  encryptionKey?: string;
  /**
   * Encryption algorithm used for L2 (Redis) values and disk-tier files.
   * - `'aes-256-gcm'` — default. 32-byte key. Authenticated encryption (AEAD).
   * - `'aes-128-gcm'` — 16-byte key. ~10% faster on non-AES-NI hardware. AEAD.
   * - `'xor'`         — XOR obfuscation ONLY. NOT cryptographic security.
   *                     Any key length (minimum 16 bytes recommended).
   *                     Use for dev environments or non-sensitive data only.
   * Default: `'aes-256-gcm'`
   */
  encryptionMode?: 'aes-256-gcm' | 'aes-128-gcm' | 'aes-128-ctr' | 'xor';
  /**
   * Fallback encryption key for zero-downtime key rotation.
   * On every read, tricache tries the current `encryptionKey` first.
   * If decryption fails (wrong key), it retries with `previousEncryptionKey`.
   * All writes always use the current `encryptionKey`.
   * Remove this field once you are confident all data has been re-encrypted.
   */
  previousEncryptionKey?: string;
  /** Encryption mode that was used with `previousEncryptionKey`. Defaults to `encryptionMode`. */
  previousEncryptionMode?: 'aes-256-gcm' | 'aes-128-gcm' | 'aes-128-ctr' | 'xor';

  // ── Snapshot ────────────────────────────────────────────────────────────
  /**
   * Path where the cold-start snapshot is written on SIGTERM/SIGINT and loaded
   * on startup. Default: os.tmpdir()/tricache-snapshot.msgpack
   */
  snapshotPath?: string;
  /**
   * Max age (ms) of a snapshot file before it is rejected. Default: 2 hours
   */
  snapshotMaxAgeMs?: number;

  /**
   * Optional namespace prefix for all cache keys.
   *
   * When set, every key is transparently stored as `${namespace}:${key}` in
   * L1, L1.5 (disk), and L2 (Redis). This enables:
   *  - **Multi-tenant isolation**: `CacheService.create({ namespace: 'org_abc' })`
   *    — tenants sharing the same Redis instance or disk dir are fully isolated.
   *  - **Environment separation**: `CacheService.create({ namespace: 'staging' })`
   *  - **Service-level scoping**: microservices sharing one Redis without key collisions.
   *
   * Consumers never see the prefix — `get('user:1')` behaves identically
   * whether namespaced or not. Glob deletes (`delete('user:*')`) automatically
   * scope to the namespace.
   *
   * The process-level singleton, disk cache directory, and cold-start snapshot
   * path are all scoped per namespace, so two `CacheService.create()` calls
   * with different namespaces return completely independent instances.
   *
   * Default: `''` (no prefix)
   */
  namespace?: string;

  /**
   * Seconds to extend a stale SWR entry's life when background revalidation fails.
   * Without this, a failed revalidation leaves the entry stale until its hard TTL
   * expires, after which the next caller blocks. With `staleIfError`, tricache bumps
   * the expiry by this many seconds on every failed revalidation, keeping the stale
   * value available while the underlying service is degraded.
   * Default: `0` (disabled — entry expires normally on revalidation failure).
   */
  staleIfError?: number;

  /**
   * Called after every L1 eviction. Receives the raw (namespaced) key and the reason.
   * Useful for diagnosing cache pressure and tuning `categoryLimits`.
   */
  onEviction?: (key: string, reason: EvictionReason) => void;

  /**
   * Human-readable name for this CacheService instance. Added as an `instance` label
   * to all Prometheus metrics emitted by `CacheService.toPrometheusText()`.
   * Required when multiple CacheService instances share a process — without it,
   * metric names from different instances collide.
   * Default: `''` (no label).
   */
  instanceName?: string;

  /**
   * Controls whether writes are propagated to L2 (Redis).
   * - `'read-write'` (default): read from and write to L2.
   * - `'read-only'`:  read from L2 but never write, delete, or expire keys in Redis.
   *   Use for shared read replicas or external Redis clusters you do not own.
   */
  l2WriteMode?: 'read-write' | 'read-only';

  // ── Invalidation backplane (Redis Pub/Sub) ──────────────────────────────
  /**
   * Enable Redis Pub/Sub invalidation backplane so every running instance
   * evicts a key from its L1 when any peer calls `set()` or `delete()`.
   *
   * Gives you sub-microsecond in-process cache speed with cluster-wide
   * consistency across all your app servers.
   *
   * Default: `true` (auto-activates when Redis is available).
   * Set to `false` for single-process services or eventual-consistency scenarios.
   */
  invalidationBackplane?: boolean;

  // ── OOM protection ──────────────────────────────────────────────────────
  /**
   * Enable the GC-aware OOM guard. When heap utilisation crosses
   * `oomHeapThreshold`, a fraction of the coldest L1 entries are
   * emergency-evicted to L1.5 disk, preventing Node.js OOM crashes inside
   * Docker/Kubernetes containers with tight memory limits.
   *
   * Default: `true`
   */
  oomProtection?: boolean;
  /**
   * Heap-used / heap-total ratio that triggers emergency eviction.
   * Default: `0.85` (85 %)
   */
  oomHeapThreshold?: number;
  /** Milliseconds between heap-pressure checks. Default: 10 000 ms (10 s) */
  oomCheckIntervalMs?: number;
  /** Fraction of L1 entries to evict per OOM round. Default: `0.20` (20 %) */
  oomEvictPercent?: number;

  // ── Metrics / observability ─────────────────────────────────────────────
  /**
   * Callback invoked periodically with a `CacheMetrics` snapshot.
   * Wire up to OpenTelemetry, Prometheus push gateway, Datadog, etc.
   *
   * @example
   * onMetrics: (m) => statsd.gauge('cache.l1_hit_rate', m.gets.l1HitRate)
   */
  onMetrics?: (metrics: CacheMetrics) => void;
  /** How often the `onMetrics` callback fires (ms). Default: 60 000 ms */
  metricsIntervalMs?: number;

  /**
   * OpenTelemetry-compatible tracer. When provided, `get()`, `set()`, and
   * `delete()` are each wrapped in a span with attributes:
   * - `cache.hit`         — `'l1' | 'disk' | 'l2' | 'miss'`
   * - `cache.key_prefix`  — first path segment of the key (e.g. `'user'`)
   *
   * Pass your existing `@opentelemetry/api` Tracer directly — no extra
   * dependency required; the interface is structurally compatible.
   *
   * @example
   * import { trace } from '@opentelemetry/api';
   * tracer: trace.getTracer('tricache')
   */
  tracer?: ICacheTracer;

  // ── TTL jitter ─────────────────────────────────────────────────────────────
  /**
   * Randomise every stored TTL by ± `ttlJitterFactor × ttl` seconds.
   * Prevents thundering-herd cache stampedes when thousands of entries share
   * the same TTL and expire simultaneously.
   *
   * A factor of `0.15` spreads a 300 s TTL uniformly over [255 s, 345 s].
   * Default: `0` (disabled — TTLs are stored exactly as given).
   */
  ttlJitterFactor?: number;

  // ── L2 circuit breaker ─────────────────────────────────────────────────────
  /**
   * Default TTL in seconds for `null` or `undefined` results from `fetchFn`.
   * Caches negative results so a non-existent key (deleted user, bad ID) does not
   * hit the DB on every request. Can be overridden per-call via `get(..., { notFoundTtl }).
   * Default: `0` (disabled — null/undefined uses the normal TTL).
   */
  notFoundTtl?: number;

  /**
   * Number of consecutive Redis errors before the circuit opens (stops
   * attempting Redis until the cooldown elapses).
   * Default: `5`.
   */
  l2CircuitBreakerThreshold?: number;
  /**
   * Milliseconds the circuit stays open before transitioning to half-open
   * (allows a single probe request to test recovery).
   * Default: `30 000` ms (30 s).
   */
  l2CircuitBreakerCooldownMs?: number;
  /**
   * Redis key pattern to automatically warm L1 from at startup (e.g. `'user:*'`).
   * `cache.ready()` returns a Promise that resolves once this warm-up completes.
   * No-op when Redis is disabled or unreachable — safe to set unconditionally.
   */
  warmKeys?: string;

  /**
   * Called on every L1, disk, or L2 cache hit. Receives the caller-facing key (no
   * namespace prefix) and the tier that served it. Useful for per-route hit-rate
   * metrics without waiting for the `onMetrics` interval.
   *
   * @example
   * onHit: (key, tier) => cloudwatch.putMetricData({ key, tier })
   */
  onHit?: (key: string, tier: 'l1' | 'disk' | 'l2') => void;

  /**
   * Called on every cache miss (after L1, disk, and L2 are all exhausted).
   * Receives the caller-facing key (no namespace prefix).
   *
   * @example
   * onMiss: (key) => cloudwatch.putMetricData({ key })
   */
  onMiss?: (key: string) => void;

  /**
   * When `true`, every value returned from an L1 cache hit is recursively
   * frozen with `Object.freeze()` before being handed to the caller.
   * Any attempt to mutate the returned object throws a `TypeError` immediately,
   * catching reference-semantic corruption bugs that would otherwise silently
   * corrupt the cached entry.
   *
   * **Do not enable in production** — use `process.env.NODE_ENV !== 'production'`.
   * Deep-freezing large objects has measurable overhead per hit.
   *
   * @example
   * frozen: process.env.NODE_ENV !== 'production'
   */
  frozen?: boolean;

  // ── Adaptive TTL ──────────────────────────────────────────────────────────

  /**
   * When `true`, tricache tracks per-key fetch latency in a rolling ring buffer
   * and automatically derives an optimal TTL from the p95 fetch duration:
   *
   * ```
   * adaptedTtl = clamp(p95LatencyMs × adaptiveTtlMultiplier, adaptiveTtlMin, adaptiveTtlMax)
   * ```
   *
   * The caller-supplied `ttlSeconds` is used until at least 5 samples are collected
   * for a key, then the library takes over TTL management autonomously.
   *
   * Expensive keys (slow DB queries) get cached longer; cheap keys stay close to
   * their base TTL. Callers no longer need to reason about individual TTL values.
   *
   * Default: `false`.
   */
  adaptiveTtl?: boolean;

  /**
   * Minimum TTL (seconds) the adaptive tuner will ever assign.
   * Guards against extremely fast fetches producing near-zero TTLs.
   * Default: `10`.
   */
  adaptiveTtlMin?: number;

  /**
   * Maximum TTL (seconds) the adaptive tuner will ever assign.
   * Guards against pathologically slow fetches producing indefinite caching.
   * Default: `86400` (24 hours).
   */
  adaptiveTtlMax?: number;

  /**
   * `p95FetchLatencyMs × adaptiveTtlMultiplier = adaptedTtlSeconds`.
   *
   * Intuition: a 200 ms p95 fetch with the default multiplier of 20 yields a
   * 4-second TTL. A 2 000 ms fetch yields 40 seconds. Increase the multiplier
   * if you want the cache to absorb more upstream pressure.
   *
   * Default: `20`.
   */
  adaptiveTtlMultiplier?: number;

  /**
   * Number of fetch duration samples kept per key in the ring buffer.
   * Larger values smooth out latency spikes but use slightly more memory
   * (~8 bytes × samples per tracked key).
   * Default: `32`.
   */
  adaptiveTtlSamples?: number;

  /**
   * Maximum number of distinct keys tracked by the adaptive TTL system.
   * When the cap is reached, the oldest-tracked key is evicted from the
   * ring-buffer store to make room for the new key.
   * Default: `5000`.
   */
  adaptiveTtlMaxKeys?: number;

  // ── Worker-thread serialization offload ────────────────────────────────────
  /**
   * When `true`, tricache spawns a pool of worker threads and offloads AES-GCM
   * encryption and decryption for large payloads to those threads, keeping the
   * V8 main event loop free for concurrent HTTP requests.
   *
   * Only takes effect when `encryptionKey` is set — plaintext payloads are never
   * serialized off-thread because `JSON.stringify/parse` is already fast.
   *
   * Default: `false`. Enable in long-running servers that write multi-megabyte
   * encrypted payloads and observe event-loop latency spikes.
   */
  workerThreads?: boolean;
  /**
   * Byte threshold above which an L2 payload is offloaded to a worker thread
   * for encryption / decryption. Payloads smaller than this are processed
   * synchronously (IPC overhead would exceed the savings).
   * Default: `131072` (128 KB).
   */
  workerThresholdBytes?: number;
  /**
   * Number of worker threads in the pool.
   * Default: `Math.min(4, os.availableParallelism())`.
   */
  workerPoolSize?: number;

  // ── Backplane staleness fence ───────────────────────────────────────────────
  /**
   * Maximum milliseconds the Redis Pub/Sub subscriber is allowed to be
   * disconnected before tricache considers its L1 entries potentially stale.
   *
   * When the subscriber reconnects after a gap longer than this value, all L1
   * entries that were written *before* the disconnect started are evicted.
   * This prevents the instance from silently serving data that peers may have
   * invalidated while the backplane connection was down.
   *
   * Set to `0` to disable the fence entirely (accept eventual-consistency drift).
   * Default: `5000` (5 seconds).
   */
  backplaneMaxStalenessMs?: number;

  // ── Disk tier ─────────────────────────────────────────────────────────────
  /**
   * Explicitly disable the L1.5 disk spill tier and cold-start snapshots.
   *
   * Tricache auto-detects common serverless / ephemeral-filesystem runtimes
   * (AWS Lambda, Google Cloud Run, Google Cloud Functions, Azure Functions,
   * Fly.io) and disables the disk tier automatically. Set this to `false` to
   * override that detection and force the disk tier on regardless of runtime.
   *
   * When disabled:
   *  - L1 evictions are dropped instead of being spilled to disk.
   *  - Cold-start snapshot persistence is skipped.
   *  - The `disk` metrics field still appears but shows zeroed counters.
   *
   * Default: `undefined` (auto-detect).
   */
  disableDisk?: boolean;

  // ── Redis Cluster / Sentinel ───────────────────────────────────────────────
  /**
   * Redis Cluster node list. When provided, tricache connects using ioredis
   * `Cluster` mode with automatic slot routing and multi-node connection
   * pooling — no external proxy required.
   *
   * Takes precedence over `redisHost`/`redisPort`.
   *
   * @example
   * redisClusterNodes: [
   *   { host: 'redis-1.internal', port: 6379 },
   *   { host: 'redis-2.internal', port: 6379 },
   *   { host: 'redis-3.internal', port: 6379 },
   * ]
   */
  redisClusterNodes?: Array<{ host: string; port: number }>;

  /**
   * Redis Sentinel configuration for high-availability setups.
   * When provided, tricache connects through Sentinel for automatic
   * primary failover — no static `redisHost` / `redisPort` needed.
   *
   * Takes precedence over `redisHost`/`redisPort` (but not over `redisClusterNodes`).
   *
   * @example
   * redisSentinel: {
   *   name: 'mymaster',
   *   sentinels: [
   *     { host: 'sentinel-1.internal', port: 26379 },
   *     { host: 'sentinel-2.internal', port: 26379 },
   *   ],
   * }
   */
  redisSentinel?: {
    /** Logical name of the monitored master. Must match the Sentinel `monitor` config. */
    name:      string;
    sentinels: Array<{ host: string; port: number }>;
  };
}
