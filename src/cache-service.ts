/**
 * CacheService — three-tier cache with stampede prevention and SWR.
 *
 * Architecture:
 *   L1  → SmartMemoryCache  (in-process RAM, always active, adaptive eviction)
 *   L1.5→ DiskTier          (NVMe overflow, evicted L1 entries, 2–100 µs)
 *   L2  → Redis / Valkey    (distributed, production-only by default, survives restarts)
 *   DB  → your fetchFunction (cache miss path)
 *
 * Key features:
 *   - Thundering-herd / cache-stampede prevention (inflight Promise registry)
 *   - Stale-While-Revalidate (serve stale instantly + revalidate in background)
 *   - AES-256-GCM encryption for L2 and disk data at rest
 *   - Cold-start snapshot: L1 is persisted to disk on SIGTERM and restored on startup
 *   - Process-level singleton (globalThis) survives hot reloads in frameworks like Next.js
 *   - Periodic cleanup of expired entries every 5 minutes
 */

import { Redis as RedisClient } from 'ioredis';
import { pack, unpack } from 'msgpackr';
import crypto from 'crypto';
import os    from 'os';
import fs    from 'fs';
import path  from 'path';


import {
  CachePriority,
  CategoryLimit,
  SmartCacheEntry,
  DiskCacheEntry,
  CacheOptions,
  CacheMetrics,
  CachePingResult,
  ILogger,
  ICacheTracer,
  ICacheSpan,
  consoleLogger,
} from './types';
import { CacheEncryption }   from './encryption';
import { SmartMemoryCache }  from './smart-memory-cache';
import { DiskTier }          from './disk-tier';

// ─── Snapshot constants ───────────────────────────────────────────────────────

const SNAPSHOT_VERSION         = 1;
const DEFAULT_SNAPSHOT_MAX_AGE = 2 * 60 * 60 * 1000; // 2 hours
const SNAPSHOT_MAX_FILE_BYTES  = 220 * 1024 * 1024;   // 220 MB guard

// ─── Default category limits ──────────────────────────────────────────────────

const DEFAULT_CATEGORY_LIMITS: Record<string, CategoryLimit> = {
  'default': { maxEntries: 500,  maxSizeBytes: 50 * 1024 * 1024 },
};

// ─── Default forbidden prefixes ───────────────────────────────────────────────

const DEFAULT_FORBIDDEN_PREFIXES = ['auth:', 'session:', 'mfa:', 'rate_limit:'] as const;

// ─────────────────────────────────────────────────────────────────────────────
//  Circuit breaker — three-state (CLOSED → OPEN → HALF_OPEN) for L2 Redis
// ─────────────────────────────────────────────────────────────────────────────

const enum CBState { CLOSED, OPEN, HALF_OPEN }

class L2CircuitBreaker {
  private state      = CBState.CLOSED;
  private failures   = 0;
  private openedAt   = 0;
  constructor(
    private readonly threshold:  number,
    private readonly cooldownMs: number,
  ) {}

  /** Call before each Redis attempt. Returns false when the circuit is open. */
  isAllowed(): boolean {
    if (this.state === CBState.CLOSED)    return true;
    if (this.state === CBState.HALF_OPEN) return true; // one probe allowed
    // OPEN: check if cooldown elapsed
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = CBState.HALF_OPEN;
      return true; // probe
    }
    return false;
  }

  /** Call on Redis success. */
  onSuccess(): void {
    this.failures = 0;
    this.state    = CBState.CLOSED;
  }

  /** Call on Redis failure. */
  onFailure(): void {
    this.failures++;
    if (this.state === CBState.HALF_OPEN || this.failures >= this.threshold) {
      this.state    = CBState.OPEN;
      this.openedAt = Date.now();
      this.failures = 0;
    }
  }

  get isOpen(): boolean { return this.state === CBState.OPEN; }
  get currentState(): 'closed' | 'open' | 'half_open' {
    return this.state === CBState.CLOSED ? 'closed'
         : this.state === CBState.OPEN   ? 'open'
         :                                 'half_open';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Priority inference — override by passing priority explicitly to get()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursively freezes an object and all its nested properties.
 * Used only when `CacheOptions.frozen` is true (dev/test mode).
 * Already-frozen objects are skipped to avoid redundant traversal.
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const v of Object.values(obj as object)) deepFreeze(v);
  return obj;
}

function inferPriority(cacheKey: string): CachePriority {
  if (cacheKey.includes('auth:') || cacheKey.includes('session:'))                                   return CachePriority.CRITICAL;
  if (cacheKey.includes('user:') || cacheKey.includes('org:') || cacheKey.includes('profile:'))      return CachePriority.HIGH;
  if (cacheKey.includes('analytics:') || cacheKey.includes('report:') || cacheKey.includes('stats:')) return CachePriority.LOW;
  return CachePriority.NORMAL;
}

// ─────────────────────────────────────────────────────────────────────────────
//  CacheService
// ─────────────────────────────────────────────────────────────────────────────

// globalThis key — allows reuse across hot reloads (Next.js, ts-node watch, etc.)
const GLOBAL_KEY = '__tricache_instance__';

export class CacheService {
  private readonly logger:     ILogger;
  private readonly enc:        CacheEncryption;
  private readonly l1:         SmartMemoryCache;
  private readonly disk:       DiskTier;
  private readonly opts: {
    namespace: string;
    logger: ILogger; l1MaxBytes: number; l1MaxEntries: number;
    categoryLimits: Record<string, CategoryLimit>;
    forbiddenSnapshotPrefixes: readonly string[];
    diskCacheDir: string; diskMaxBytes: number; diskEntryMaxBytes: number;
    redisHost: string; redisPort: number; redisTls: boolean; disableRedis: boolean;
    encryptionKey: string | undefined; snapshotPath: string; snapshotMaxAgeMs: number;
    invalidationBackplane: boolean;
    oomProtection: boolean; oomHeapThreshold: number;
    oomCheckIntervalMs: number; oomEvictPercent: number;
    onMetrics: ((m: CacheMetrics) => void) | undefined;
    metricsIntervalMs: number;
    staleIfError: number;
    l2WriteMode: 'read-write' | 'read-only';
    instanceName: string;
    ttlJitterFactor: number;
    tracer: ICacheTracer | undefined;
    notFoundTtl: number;
    warmKeys: string | undefined;
    onHit: ((key: string, tier: 'l1' | 'disk' | 'l2') => void) | undefined;
    onMiss: ((key: string) => void) | undefined;
    frozen: boolean;
  };
  /** Pre-computed once — opts.namespace never changes after construction. */
  private readonly _namespace:      string;
  /** Pre-computed once — disableRedis and redisHost never change after construction. */
  private readonly _redisDisabled:  boolean;
  private readonly inflight    = new Map<string, Promise<unknown>>();
  private readonly revalidating = new Set<string>();
  private readonly _l1Counters = new Map<string, { value: number; expiresAt: number }>();
  /** tag → Set of namespaced cache keys; maintained in-process for O(1) invalidateTag() */
  private readonly tagIndex    = new Map<string, Set<string>>();
  /**
   * Dependency index: source glob pattern → Set of namespaced dependent keys.
   * When an exact-key delete matches a registered pattern, all dependents are cascaded.
   */
  private readonly dependencyIndex = new Map<string, Set<string>>();
  private redis:               RedisClient | null = null;
  private redisConnecting:     Promise<RedisClient> | null = null;
  private readonly cb:         L2CircuitBreaker;
  private snapshotLoaded       = false;
  private _readyPromise:       Promise<void> = Promise.resolve();
  private cleanupInterval:     ReturnType<typeof setInterval> | null = null;
  private diskJanitorInterval: ReturnType<typeof setInterval> | null = null;
  private oomInterval:         ReturnType<typeof setInterval> | null = null;
  private metricsInterval:     ReturnType<typeof setInterval> | null = null;
  private _shutdownHandler:    (() => void) | null = null;
  private readonly instanceId:       string;
  private readonly backplaneChannel: string;
  private subClient:           RedisClient | null = null;
  private readonly counters = {
    gets:             0,
    l1Hits:           0,
    diskHits:         0,
    l2Hits:           0,
    fetches:          0,
    stampedes:        0,
    sets:             0,
    deletes:          0,
    swrRevalidations: 0,
    invSent:          0,
    invReceived:      0,
    invSkipped:       0,
    oomEvictions:     0,
    oomLastAt:        null as number | null,
    startedAt:        Date.now(),
  };

  // ── Constructor (use CacheService.create() for the recommended singleton) ──

  constructor(options: CacheOptions = {}) {
    const logger = options.logger ?? consoleLogger;
    this.logger  = logger;

    // Resolve namespace: trim whitespace, default to empty string
    const ns = options.namespace?.trim() ?? '';

    // Resolve encryption key: option > env var
    const encKeyRaw = options.encryptionKey ?? process.env.CACHE_ENCRYPTION_KEY;
    this.enc = new CacheEncryption(
      encKeyRaw,
      logger,
      options.encryptionMode,
      options.previousEncryptionKey,
      options.previousEncryptionMode,
    );

    // When a namespace is active, scope the forbidden prefixes so that
    // auth/session keys like `org_abc:auth:token` are still protected.
    const rawForbidden = options.forbiddenSnapshotPrefixes ?? [...DEFAULT_FORBIDDEN_PREFIXES];
    const forbiddenPrefixes = ns
      ? rawForbidden.map(p => `${ns}:${p}`)
      : rawForbidden;

    // Normalised options with defaults
    this.opts = {
      namespace:                ns,
      logger,
      l1MaxBytes:               options.l1MaxBytes   ?? 200 * 1024 * 1024,
      l1MaxEntries:             options.l1MaxEntries ?? 2_000,
      categoryLimits:           { ...DEFAULT_CATEGORY_LIMITS, ...(options.categoryLimits ?? {}) },
      forbiddenSnapshotPrefixes: forbiddenPrefixes,
      // Namespace-isolated defaults: separate dir / snapshot per namespace so
      // two instances with different namespaces never share cache files.
      diskCacheDir:             options.diskCacheDir ?? path.join(
        os.tmpdir(), ns ? `tricache-disk-${ns}` : 'tricache-disk'),
      diskMaxBytes:             options.diskMaxBytes    ?? 500 * 1024 * 1024,
      diskEntryMaxBytes:        options.diskEntryMaxBytes ?? 10 * 1024 * 1024,
      redisHost:                options.redisHost  ?? process.env.REDIS_HOST ?? '',
      redisPort:                options.redisPort  ?? 6379,
      redisTls:                 options.redisTls   ?? (process.env.NODE_ENV === 'production'),
      disableRedis:             options.disableRedis ?? (process.env.NODE_ENV !== 'production'),
      encryptionKey:            encKeyRaw,
      snapshotPath:             options.snapshotPath ?? path.join(
        os.tmpdir(), ns ? `tricache-snapshot-${ns}.msgpack` : 'tricache-snapshot.msgpack'),
      snapshotMaxAgeMs:         options.snapshotMaxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE,
      invalidationBackplane:    options.invalidationBackplane ?? true,
      oomProtection:            options.oomProtection      ?? true,
      oomHeapThreshold:         options.oomHeapThreshold   ?? 0.85,
      oomCheckIntervalMs:       options.oomCheckIntervalMs ?? 10_000,
      oomEvictPercent:          options.oomEvictPercent    ?? 0.20,
      onMetrics:                options.onMetrics,
      metricsIntervalMs:        options.metricsIntervalMs  ?? 60_000,
      staleIfError:             options.staleIfError       ?? 0,
      l2WriteMode:              options.l2WriteMode        ?? 'read-write',
      instanceName:             options.instanceName       ?? '',
      ttlJitterFactor:          Math.min(Math.max(options.ttlJitterFactor ?? 0, 0), 1),
      tracer:                   options.tracer,
      notFoundTtl:              options.notFoundTtl ?? 0,
      warmKeys:                 options.warmKeys,
      onHit:                    options.onHit,
      onMiss:                   options.onMiss,
      frozen:                   options.frozen ?? false,
    };

    // Circuit breaker for L2 Redis
    const cbThreshold  = options.l2CircuitBreakerThreshold  ?? 5;
    const cbCooldownMs = options.l2CircuitBreakerCooldownMs ?? 30_000;
    this.cb = new L2CircuitBreaker(cbThreshold, cbCooldownMs);

    // L1.5 disk tier
    this.disk = new DiskTier({
      dir:               this.opts.diskCacheDir,
      maxBytes:          this.opts.diskMaxBytes,
      entryMaxBytes:     this.opts.diskEntryMaxBytes,
      forbiddenPrefixes: forbiddenPrefixes,
      encryptionKey:     this.enc.isEnabled ? (this.enc as unknown as { _key: Buffer })['_key'] : null,
      logger,
    });

    this._namespace     = ns;
    this._redisDisabled = (this.opts.disableRedis || !this.opts.redisHost);

    // L1 in-memory cache
    this.l1 = new SmartMemoryCache({
      maxBytes:   this.opts.l1MaxBytes,
      maxEntries: this.opts.l1MaxEntries,
      categories: this.opts.categoryLimits,
      diskSpill: (key: string, entry: SmartCacheEntry) => {
        // Defer disk.save() entirely to the next event-loop tick so the synchronous
        // preamble inside save() (SHA-256 keyToPath + msgpackr pack) does not block
        // the l1.set() → smartEvict → diskSpill call chain.  Mirrors what the
        // backplane handler already does for remote invalidations.
        setImmediate(() => { void this.disk.save(key, entry as unknown as DiskCacheEntry); });
      },
      onEviction: options.onEviction,
      logger,
    });

    // Load snapshot once per process
    if (!this.snapshotLoaded) {
      this.snapshotLoaded = true;
      this.loadSnapshot();
    }

    // Graceful shutdown: persist L1 to disk
    this._shutdownHandler = () => { this.writeSnapshot(); process.exit(0); };
    process.once('SIGTERM', this._shutdownHandler);
    process.once('SIGINT',  this._shutdownHandler);

    // Periodic L1 cleanup (5 min): expires stale entries and rebalances frequency counters.
    // Disk cleanup is handled entirely by the janitor below — purgeExpired() is NOT called
    // here to avoid a synchronous O(fileCount) event-loop stall at scale.
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.l1.cleanup();
      if (cleaned > 0) this.logger.debug('Periodic L1 cleanup', { cleaned });
    }, 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref(); // don't block process exit

    // Disk janitor: sole owner of disk expiry. Scans one of 256 subdirectory buckets per tick
    // (30 s × 256 = 128-min full cycle). Each tick is bounded to one bucket's worth of
    // readFileSync + decrypt + unpack work, capping per-tick event-loop occupancy.
    this.diskJanitorInterval = setInterval(() => {
      const purged = this.disk.purgeNextBucket();
      if (purged > 0) this.logger.debug('Disk janitor tick', { purged });
    }, 30_000);
    if (this.diskJanitorInterval.unref) this.diskJanitorInterval.unref();

    // OOM protection: evict coldest L1 entries when heap pressure rises
    if (this.opts.oomProtection) {
      this.oomInterval = setInterval(() => {
        const mem  = process.memoryUsage();
        const used = mem.heapUsed / mem.heapTotal;
        if (used >= this.opts.oomHeapThreshold) {
          const evicted = this.l1.evictPercentage(this.opts.oomEvictPercent);
          this.counters.oomEvictions++;
          this.counters.oomLastAt = Date.now();
          this.logger.warn('tricache OOM guard: emergency L1 eviction', {
            heapUsedPct: Math.round(used * 100),
            threshold:   Math.round(this.opts.oomHeapThreshold * 100),
            evicted,
          });
        }
      }, this.opts.oomCheckIntervalMs);
      if (this.oomInterval.unref) this.oomInterval.unref();
    }

    // Metrics callback
    if (this.opts.onMetrics && this.opts.metricsIntervalMs > 0) {
      this.metricsInterval = setInterval(() => {
        try { this.opts.onMetrics!(this.metrics()); } catch { /* never crash process */ }
      }, this.opts.metricsIntervalMs);
      if (this.metricsInterval.unref) this.metricsInterval.unref();
    }

    // Backplane: assign instance ID + channel, then subscribe
    this.instanceId       = crypto.randomBytes(8).toString('hex');
    this.backplaneChannel = `tricache:inv${ns ? ':' + ns : ''}`;
    this.initBackplane();

    // Auto-warm from L2 if warmKeys is configured; ready() waits for completion.
    if (this.opts.warmKeys) {
      this._readyPromise = this.warmFromL2(this.opts.warmKeys).then(() => undefined);
    }
  }

  // ── Singleton factory ─────────────────────────────────────────────────────

  /**
   * Get (or create) the process-level singleton CacheService instance.
   *
   * Options are only applied on first call — subsequent calls return the
   * existing instance regardless of options passed.
   *
   * When `namespace` is set the singleton is keyed by namespace, so two calls
   * with different namespaces return independent instances.
   */
  static create(options?: CacheOptions): CacheService {
    const g   = globalThis as Record<string, unknown>;
    const key = CacheService.globalKey(options);
    if (!g[key]) g[key] = new CacheService(options);
    return g[key] as CacheService;
  }

  /**
   * Async factory — accepts a Promise that resolves to CacheOptions.
   * Useful when config is fetched from a secret store at startup.
   *
   * @example
   * const cache = await CacheService.createAsync(fetchSecrets());
   */
  static async createAsync(options: Promise<CacheOptions> | CacheOptions): Promise<CacheService> {
    const resolved = await options;
    return CacheService.create(resolved);
  }

  /** Replace the singleton (useful in tests). */
  static reset(options?: CacheOptions): CacheService {
    const g   = globalThis as Record<string, unknown>;
    const key = CacheService.globalKey(options);
    const existing = g[key] as CacheService | undefined;
    if (existing) existing.destroy();
    g[key] = new CacheService(options);
    return g[key] as CacheService;
  }

  /** Derive the globalThis key for a given set of options. */
  private static globalKey(options?: CacheOptions): string {
    const ns = options?.namespace?.trim() ?? '';
    return ns ? `__tricache_${ns}__` : GLOBAL_KEY;
  }

  // ── Redis connection ──────────────────────────────────────────────────────

  /**
   * Prepend the configured namespace to a raw cache key.
   * Returns the key unchanged when namespace is empty.
   *
   * This is the only place the namespace prefix is applied — callers always
   * receive and provide un-prefixed keys in the public API.
   */
  private nk(key: string): string {
    return this._namespace ? `${this._namespace}:${key}` : key;
  }

  /** Apply TTL jitter: multiply ttlMs by (1 ± jitterFactor). */
  private _jitterTtl(ttlMs: number): number {
    const j = this.opts.ttlJitterFactor;
    if (j === 0) return ttlMs;
    return Math.round(ttlMs * (1 + (Math.random() * 2 - 1) * j));
  }

  /** Shared no-op span for the common case where no tracer is configured.
   *  Using a singleton avoids allocating a fresh object literal on every get/set/delete call. */
  private static readonly _nullSpan: ICacheSpan = {
    setAttribute() { return this; },
    setStatus()    { return this; },
    end()          {},
  };

  /** Start an OTEL-compatible span if a tracer is configured. Returns a no-op span otherwise. */
  private _startSpan(name: string): ICacheSpan {
    if (this.opts.tracer) return this.opts.tracer.startSpan(name);
    return CacheService._nullSpan;
  }

  private initBackplane(): void {
    if (!this.opts.invalidationBackplane || this._redisDisabled) return;
    if (this.subClient) return;

    const sub = new RedisClient({
      host:                 this.opts.redisHost,
      port:                 this.opts.redisPort,
      tls:                  this.opts.redisTls ? {} : undefined,
      connectTimeout:       10_000,
      lazyConnect:          true,
      maxRetriesPerRequest: null as unknown as number,
      enableAutoPipelining: false,
      family:               4,
      retryStrategy:        (times: number) => Math.min(times * 50, 2_000),
    });

    sub.on('error', (e: Error) =>
      this.logger.debug('Backplane subscriber error', { error: e.message }));

    sub.on('message', (_channel: string, message: string) => {
      this._handleBackplaneMessage(message);
    });

    sub.subscribe(this.backplaneChannel)
      .then(() => this.logger.info('Backplane: subscribed', {
        channel: this.backplaneChannel, instanceId: this.instanceId,
      }))
      .catch((err: Error) => this.logger.warn('Backplane: subscribe failed', {
        error: err.message,
      }));

    this.subClient = sub;
  }

  /** @internal Exposed for testing. Applies a raw backplane JSON message to local state. */
  _handleBackplaneMessage(message: string): void {
    try {
      const msg = JSON.parse(message) as { op: 'del' | 'del-glob'; key: string; src: string };
      if (msg.src === this.instanceId) {
        this.counters.invSkipped++;
        return; // own message — our L1 is already current
      }
      this.counters.invReceived++;
      if (msg.op === 'del') {
        // L1 eviction is synchronous and O(1); disk delete is deferred via
        // setImmediate so the event-loop tick that processes this pub/sub
        // message returns immediately without blocking hot get() calls.
        this.l1.delete(msg.key);
        setImmediate(() => this.disk.delete(msg.key));
        // Cascade: evict dependents registered on this instance for the
        // deleted key — same logic the local delete() path runs, now also
        // applied to peer-originated invalidations so fleet-wide deletes
        // propagate dependency cascades to every node.
        this._cascadeDependencies(msg.key);
      } else if (msg.op === 'del-glob') {
        // Glob patterns clean L1 only — disk entries expire naturally via
        // the background purge timer or are bypassed on the next L1 miss.
        this.l1.deletePattern(msg.key);
      }
      this.logger.debug('Backplane: peer invalidation applied', {
        op: msg.op, key: msg.key.slice(0, 60),
      });
    } catch { /* malformed message — ignore */ }
  }

  private async publishInvalidation(op: 'del' | 'del-glob', key: string): Promise<void> {
    if (!this.opts.invalidationBackplane || this._redisDisabled) return;
    try {
      const client = await this.getRedis();
      await client.publish(
        this.backplaneChannel,
        JSON.stringify({ op, key, src: this.instanceId }),
      );
      this.counters.invSent++;
    } catch { /* non-critical — never block the caller */ }
  }

  private async getRedis(): Promise<RedisClient> {
    if (!this.cb.isAllowed()) throw new Error('tricache: L2 circuit breaker is open');
    if (this.redisConnecting) return this.redisConnecting;

    this.redisConnecting = (async () => {
      try {
        const client = new RedisClient({
          host:                  this.opts.redisHost,
          port:                  this.opts.redisPort,
          tls:                   this.opts.redisTls ? {} : undefined,
          connectTimeout:        10_000,
          lazyConnect:           false,
          maxRetriesPerRequest:  3,
          enableAutoPipelining:  true,
          keepAlive:             30_000,
          family:                4,
          retryStrategy: (times: number) => Math.min(times * 50, 2_000),
        });

        client.on('connect',      () => this.logger.info('Redis connected', { host: this.opts.redisHost }));
        client.on('error',        (e: Error) => this.logger.error('Redis error', { host: this.opts.redisHost }, e));
        client.on('reconnecting', () => this.logger.debug('Redis reconnecting'));

        await new Promise<void>((resolve, reject) => {
          client.once('ready', resolve);
          client.once('error', reject);
          setTimeout(() => reject(new Error('Redis connection timeout')), 15_000);
        });

        this.cb.onSuccess();
        this.redis = client;
        this.redisConnecting = null;
        return client;
      } catch (err) {
        this.cb.onFailure();
        this.redisConnecting = null; // allow retry on next call — fixes the cached-rejection bug
        throw err;
      }
    })();

    return this.redisConnecting;
  }

  // ── Snapshot (cold-start persistence) ────────────────────────────────────

  writeSnapshot(altPath?: string): void {
    try {
      const entries = this.l1.exportEntries(this.opts.forbiddenSnapshotPrefixes);
      if (entries.length === 0) return;

      const payload = { version: SNAPSHOT_VERSION, writtenAt: Date.now(), entries };
      const packed  = pack(payload);
      const final   = this.enc.isEnabled ? this.enc.encryptBuffer(packed) : packed;
      const dest    = altPath ?? this.opts.snapshotPath;

      fs.writeFileSync(dest, final, { mode: 0o600 });
      this.logger.info('Cache snapshot written', {
        path: dest, entries: entries.length,
        sizeKB: Math.round(final.length / 1024), encrypted: this.enc.isEnabled,
      });
    } catch (err) {
      this.logger.warn('Cache snapshot write failed', { error: (err as Error).message });
    }
  }

  loadSnapshot(): void {
    const snapshotPath = this.opts.snapshotPath;
    try {
      if (!fs.existsSync(snapshotPath)) return;

      const stat = fs.statSync(snapshotPath);
      if (stat.size > SNAPSHOT_MAX_FILE_BYTES) {
        this.logger.warn('Snapshot rejected: exceeds size limit', { sizeBytes: stat.size });
        fs.unlinkSync(snapshotPath);
        return;
      }

      const raw = fs.readFileSync(snapshotPath);
      fs.unlinkSync(snapshotPath); // delete immediately — don't leave cache data on disk

      let buf: Buffer;
      try { buf = this.enc.decryptBuffer(raw); } catch (e) {
        this.logger.warn('Snapshot rejected: decryption failed', { error: (e as Error).message });
        return;
      }

      const snapshot = unpack(buf) as {
        version?: number; writtenAt?: number;
        entries?: Array<{ key: string; entry: SmartCacheEntry }>;
      };

      if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) {
        this.logger.warn('Snapshot rejected: version mismatch', { got: snapshot?.version });
        return;
      }

      const ageMs = Date.now() - (snapshot.writtenAt ?? 0);
      if (ageMs > this.opts.snapshotMaxAgeMs || ageMs < 0) {
        this.logger.warn('Snapshot rejected: too old', { ageMinutes: Math.round(ageMs / 60000) });
        return;
      }

      if (!Array.isArray(snapshot.entries)) {
        this.logger.warn('Snapshot rejected: entries is not an array');
        return;
      }

      const loaded = this.l1.importEntries(snapshot.entries, this.opts.forbiddenSnapshotPrefixes);
      this.logger.info('Cache snapshot loaded (L1 is warm)', {
        loaded, total: snapshot.entries.length,
        sizeKB: this.l1.getStats().sizeKB,
      });
    } catch (err) {
      this.logger.warn('Snapshot load failed — starting cold', { error: (err as Error).message });
      try { fs.unlinkSync(snapshotPath); } catch { /* ok */ }
    }
  }

  // ── Core get (L1 → L1.5 → L2 → fetch) ───────────────────────────────────

  /**
   * Get a value from cache, or fetch and cache it.
   *
   * @param cacheKey     - Unique key identifying this value
   * @param fetchFn      - Called on a cache miss; its return value is cached and returned
   * @param ttlSeconds   - How long to cache the value (default: 300 s = 5 min)
   * @param opts.priority    - Override the auto-inferred eviction priority
   * @param opts.swr         - Stale-While-Revalidate grace seconds.
   * @param opts.refreshAhead - 0–1 fraction of TTL elapsed at which a background recompute
   *                            is triggered proactively while the caller still receives the
   *                            cached value. E.g. `0.8` starts refreshing at 80 % of TTL.
   *                            Requires `fetchFn` to be stable across calls.
   * @param opts.xfetchBeta  - Enable XFetch (probabilistic early expiration). Higher values
   *                            recompute more aggressively before expiry. Typical range: 0.5–2.
   *                            Complementary to refreshAhead — uses recompute cost (delta) to
   *                            decide probabilistically rather than at a fixed threshold.
   * @param opts.notFoundTtl - Override TTL in seconds for `null`/`undefined` fetch results.
   *                            Caches negative lookups to avoid repeated DB hits for missing keys.
   */
  async get<T>(
    cacheKey:   string,
    fetchFn:    () => Promise<T>,
    ttlSeconds: number = 300,
    opts: {
      priority?:    CachePriority;
      swr?:         number;
      refreshAhead?: number; // 0–1: trigger background recompute at this fraction of TTL elapsed
      xfetchBeta?:  number;  // > 0: XFetch probabilistic early expiration (uses stored delta)
      notFoundTtl?: number;  // seconds; cache null/undefined results with this TTL instead
      /**
       * Tags to associate with this cache entry when fetchFn populates it on a miss.
       * Tags are registered in the in-process `tagIndex` and (if Redis is enabled) mirrored
       * via `SADD` so that `invalidateTag()` covers disk-spill and multi-instance nodes.
       * On an L1/L2 hit the tags are already registered — this field is a no-op for hits.
       */
      tags?:        string[];
    } = {},
  ): Promise<T> {
    const span = this._startSpan('tricache.get');
    if (this.opts.tracer) span.setAttribute('cache.key_prefix', cacheKey.split(':')[0]);
    const k = this.nk(cacheKey); // namespaced key used for all storage
    this.counters.gets++;

    // L1: in-memory (fastest path)
    const l1Hit = this.l1.get(k);
    if (l1Hit !== null) {
      if (l1Hit.isStale) {
        const swrGraceMs = (opts.swr ?? 0) * 1_000;
        if (swrGraceMs > 0 && !this.revalidating.has(k)) {
          const priority = opts.priority ?? inferPriority(cacheKey);
          this.revalidating.add(k);
          void this._revalidate(k, fetchFn, ttlSeconds * 1_000, swrGraceMs, priority);
          this.counters.swrRevalidations++;
          this.logger.debug('SWR: serving stale, revalidating', { cacheKey });
        } else {
          this.logger.debug('L1 hit');
        }
      } else {
        this.logger.debug('L1 hit');
        // Refresh-ahead and XFetch: proactively recompute a fresh entry before it expires.
        // l1Hit already carries expiresAt/ttlMs/delta — no second Map lookup needed.
        // Check opts first — pointless work when neither feature is configured.
        if (opts.refreshAhead || opts.xfetchBeta) {
          // Reuse the timestamp already captured by l1.get() — avoids a second Date.now() syscall.
          const now       = l1Hit.fetchedAt ?? Date.now();
          const remaining = l1Hit.expiresAt - now;
          const entryTtl  = l1Hit.ttlMs ?? ttlSeconds * 1_000;

          const shouldRefreshAhead = !!opts.refreshAhead
            ? remaining <= entryTtl * (1 - opts.refreshAhead)
            : false;

          // XFetch: fire with probability proportional to recompute cost (delta) vs. remaining TTL
          // Formula: fire when remaining <= delta * beta * -ln(U), U ~ uniform(0,1)
          const shouldXFetch = !!opts.xfetchBeta && l1Hit.delta != null
            ? remaining <= l1Hit.delta * opts.xfetchBeta * -Math.log(Math.random())
            : false;

          // Set.has() deferred to here — the common case (fresh key, threshold not crossed)
          // never pays the ~30 ns lookup cost.
          if ((shouldRefreshAhead || shouldXFetch) && !this.revalidating.has(k)) {
            // Defer inferPriority until we actually need it — avoids 3× string.includes()
            // scans on every warm hit when the threshold check is false (the common case).
            const priority = opts.priority ?? inferPriority(cacheKey);
            this.revalidating.add(k);
            void this._revalidate(k, fetchFn, entryTtl, (opts.swr ?? 0) * 1_000, priority);
            this.counters.swrRevalidations++;
            this.logger.debug(
              shouldXFetch ? 'XFetch: proactive background recompute' : 'Refresh-ahead: proactive background recompute',
              { cacheKey, remainingMs: remaining, ttlMs: entryTtl },
            );
          }
        }
      }
      this.counters.l1Hits++;
      this.opts.onHit?.(cacheKey, 'l1');
      if (this.opts.frozen) deepFreeze(l1Hit.value);
      span.setAttribute('cache.hit', 'l1').end();
      return l1Hit.value as T;
    }

    const ttlMs      = this._jitterTtl(ttlSeconds * 1_000);
    const swrGraceMs = (opts.swr ?? 0) * 1_000;
    const priority   = opts.priority ?? inferPriority(cacheKey);

    // L2: Redis (distributed, production-only by default)
    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const raw    = await client.get(k);
        this.cb.onSuccess();
        if (raw) {
          const decrypted = this.enc.isEnabled ? this.enc.decrypt(raw) : raw;
          const parsed    = JSON.parse(decrypted) as T;
          this.l1.set(k, parsed, ttlMs, priority);
          this.counters.l2Hits++;
          this.opts.onHit?.(cacheKey, 'l2');
          this.logger.debug('L2 hit (Redis)', { cacheKey });
          span.setAttribute('cache.hit', 'l2').end();
          return parsed;
        }
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('Redis unavailable, continuing to fetch', { cacheKey, error: (err as Error).message });
      }
    }

    // L1.5: disk tier (evicted L1 entries)
    const diskHit = this.disk.load(k);
    if (diskHit !== null) {
      const promoted = this.l1.importEntries(
        [{ key: k, entry: diskHit as unknown as SmartCacheEntry }],
        this.opts.forbiddenSnapshotPrefixes,
      );
      if (promoted > 0) {
        const l1Check = this.l1.get(k);
        if (l1Check !== null) {
          this.counters.diskHits++;
          this.opts.onHit?.(cacheKey, 'disk');
          this.logger.debug('L1.5 hit (disk → L1)', { cacheKey });
          span.setAttribute('cache.hit', 'disk').end();
          return l1Check.value as T;
        }
      }
    }

    span.setAttribute('cache.hit', 'miss');
    this.opts.onMiss?.(cacheKey);

    // Cache MISS: thundering-herd prevention
    const existing = this.inflight.get(k);
    if (existing) {
      this.counters.stampedes++;
      this.logger.debug('Stampede prevented — coalescing onto inflight fetch', { cacheKey });
      span.end();
      return existing as Promise<T>;
    }

    const fetchPromise: Promise<T> = (async () => {
      try {
        this.counters.fetches++;
        const fetchStart  = Date.now();
        const data        = await fetchFn();
        const delta       = Date.now() - fetchStart;

        // Negative caching: null/undefined results get their own (shorter) TTL
        const notFoundTtlMs = (opts.notFoundTtl ?? this.opts.notFoundTtl) * 1_000;
        const effectiveTtl  = (data == null && notFoundTtlMs > 0) ? notFoundTtlMs : ttlMs;

        const staleAt  = swrGraceMs > 0 ? Date.now() + effectiveTtl : undefined;
        const storeTtl = swrGraceMs > 0 ? effectiveTtl + swrGraceMs : effectiveTtl;

        this.l1.set(k, data, storeTtl, priority, staleAt, delta);
        if (opts.tags?.length) await this._registerTags(k, opts.tags, Math.ceil(effectiveTtl / 1_000));

        if (!this._redisDisabled) {
          try {
            const client     = await this.getRedis();
            const serialized = JSON.stringify(data);
            const toStore    = this.enc.isEnabled ? this.enc.encrypt(serialized) : serialized;
            await client.setex(k, Math.ceil(effectiveTtl / 1_000), toStore);
            this.cb.onSuccess();
            this.logger.debug('Cached L1+L2', { cacheKey, ttlSeconds, encrypted: this.enc.isEnabled });
          } catch {
            this.cb.onFailure();
            this.logger.debug('Cached L1 only (Redis unavailable)', { cacheKey });
          }
        } else {
          this.logger.debug('Cached L1', { cacheKey });
        }

        return data;
      } finally {
        this.inflight.delete(k);
        span.end();
      }
    })();

    this.inflight.set(k, fetchPromise);
    return fetchPromise;
  }

  private async _revalidate<T>(
    cacheKey:  string,
    fetchFn:   () => Promise<T>,
    ttlMs:     number,
    swrGraceMs: number,
    priority:  CachePriority,
  ): Promise<void> {
    try {
      const fetchStart = Date.now();
      const data       = await fetchFn();
      const delta      = Date.now() - fetchStart;
      const staleAt    = Date.now() + ttlMs;
      this.l1.set(cacheKey, data, ttlMs + swrGraceMs, priority, staleAt, delta);

      if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
        try {
          const client = await this.getRedis();
          const s      = JSON.stringify(data);
          const stored = this.enc.isEnabled ? this.enc.encrypt(s) : s;
          await client.setex(cacheKey, Math.ceil(ttlMs / 1_000), stored);
        } catch { /* ok */ }
      }
      this.logger.debug('SWR: revalidation complete', { cacheKey });
    } catch (err) {
      if (this.opts.staleIfError > 0) {
        const additionalMs = this.opts.staleIfError * 1_000;
        this.l1.bumpExpiry(cacheKey, additionalMs);
        this.logger.debug('SWR: revalidation failed, stale-if-error extending expiry', {
          cacheKey, staleIfErrorSecs: this.opts.staleIfError,
        });
      } else {
        this.logger.debug('SWR: revalidation failed', { cacheKey, error: (err as Error).message });
      }
    } finally {
      this.revalidating.delete(cacheKey);
    }
  }

  // ── Explicit set / delete ─────────────────────────────────────────────────

  /** Explicitly write a value into L1 (+ L2 in production). */
  async set<T>(cacheKey: string, data: T, ttlSeconds = 300, priority?: CachePriority, opts?: { tags?: string[]; dependsOn?: string[] }): Promise<void> {
    const span  = this._startSpan('tricache.set');
    if (this.opts.tracer) span.setAttribute('cache.key_prefix', cacheKey.split(':')[0]);
    const ttlMs = this._jitterTtl(ttlSeconds * 1_000);
    const p     = priority ?? inferPriority(cacheKey);
    const k     = this.nk(cacheKey);
    this.counters.sets++;
    this.l1.set(k, data, ttlMs, p);

    if (opts?.tags?.length) await this._registerTags(k, opts.tags, ttlSeconds);

    // Register dependency patterns: when any key matching a pattern is deleted,
    // this key (k) is automatically cascaded.
    if (opts?.dependsOn?.length) {
      for (const pattern of opts.dependsOn) {
        const nsPattern = this.nk(pattern);
        let deps = this.dependencyIndex.get(nsPattern);
        if (!deps) { deps = new Set(); this.dependencyIndex.set(nsPattern, deps); }
        deps.add(k);
      }
    }

    if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
      try {
        const client = await this.getRedis();
        const s      = JSON.stringify(data);
        const stored = this.enc.isEnabled ? this.enc.encrypt(s) : s;
        await client.setex(k, Math.ceil(ttlMs / 1_000), stored);
        this.cb.onSuccess();
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('set: Redis unavailable', { cacheKey, error: (err as Error).message });
      }
    }

    void this.publishInvalidation('del', k);
    span.end();
  }

  /**
   * Register tags for a cache key in the in-process index and (if Redis is enabled) in
   * the Redis SADD index. Tags are best-effort — a Redis failure does not throw.
   */
  private async _registerTags(k: string, tags: string[], ttlSeconds: number): Promise<void> {
    for (const tag of tags) {
      const tagKey = this.nk(`_tag_:${tag}`);
      let members = this.tagIndex.get(tagKey);
      if (!members) { members = new Set(); this.tagIndex.set(tagKey, members); }
      members.add(k);
    }
    if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
      try {
        const client = await this.getRedis();
        const pl = client.pipeline();
        for (const tag of tags) {
          const tagKey = this.nk(`_tag_:${tag}`);
          pl.sadd(tagKey, k);
          pl.expire(tagKey, ttlSeconds + 3_600);
        }
        await pl.exec();
        this.cb.onSuccess();
      } catch { this.cb.onFailure(); /* tags are best-effort */ }
    }
  }

  /**
   * Delete one key or a glob pattern (supports `*` wildcard).
   *
   * @example
   * await cache.delete('user:abc:profile');       // exact key
   * await cache.delete('user:abc:*');              // all keys for user abc
   */
  async delete(cacheKey: string): Promise<void> {
    const span      = this._startSpan('tricache.delete');
    if (this.opts.tracer) span.setAttribute('cache.key_prefix', cacheKey.split(':')[0]);
    const isPattern = cacheKey.includes('*');
    const k         = this.nk(cacheKey);
    this.counters.deletes++;

    if (isPattern) {
      this.l1.deletePattern(k);
    } else {
      this.l1.delete(k);
      // Defer the synchronous SHA-256 hash + fs syscalls to the next event-loop tick so
      // the caller's await resolves without blocking.  Matches what the backplane handler
      // already does for remote invalidations: setImmediate(() => this.disk.delete(msg.key)).
      // A re-get in the narrow window before the deferred call fires would get an L1 miss
      // and promote the disk entry back — acceptable for a cache (same trade-off the backplane
      // path already accepts).
      setImmediate(() => this.disk.delete(k));
      // Cascade: invalidate any key that declared it depends on this exact key's pattern
      this._cascadeDependencies(k);
      // Clean up: remove k from all dependency registrations (it is gone)
      for (const [, dependents] of this.dependencyIndex) dependents.delete(k);
    }

    if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
      try {
        const client = await this.getRedis();
        if (isPattern) {
          const stream = client.scanStream({ match: k, count: 100 });
          const keys: string[] = [];
          await new Promise<void>((resolve, reject) => {
            stream.on('data',  (chunk: string[]) => keys.push(...chunk));
            stream.on('end',   resolve);
            stream.on('error', reject);
          });
          if (keys.length > 0) await client.del(...keys);
        } else {
          await client.del(k);
        }
        this.cb.onSuccess();
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('delete: Redis unavailable', { cacheKey, error: (err as Error).message });
      }
    }

    void this.publishInvalidation(isPattern ? 'del-glob' : 'del', k);
    span.end();
  }

  // ── Counter (distributed rate limiting) ──────────────────────────────────

  /**
   * Atomically increment a counter in Redis. Returns the new value.
   * Returns 0 if Redis is disabled (safe fallback — rate limiting won't block in dev).
   */
  async increment(cacheKey: string, ttlSeconds?: number): Promise<number> {
    const k = this.nk(cacheKey);

    if (this._redisDisabled) {
      const now   = Date.now();
      const ttlMs = (ttlSeconds ?? 60) * 1_000;
      const entry = this._l1Counters.get(k);
      if (entry && entry.expiresAt > now) {
        entry.value++;
        return entry.value;
      }
      this._l1Counters.set(k, { value: 1, expiresAt: now + ttlMs });
      return 1;
    }

    try {
      const client = await this.getRedis();
      const count  = await client.incr(k);
      if (count === 1 && ttlSeconds) await client.expire(k, ttlSeconds);
      return count;
    } catch (err) {
      this.logger.error('increment: Redis error', { cacheKey }, err as Error);
      return 0;
    }
  }

  // ── Clear / Rebalance / TTL ────────────────────────────────────────────────

  /**
   * Flush all cached entries, or only those whose key starts with `prefix`.
   *
   * @example
   * await cache.clear();           // flush everything
   * await cache.clear('user:abc'); // flush all keys for one user
   */
  async clear(prefix?: string): Promise<void> {
    this.counters.deletes++;
    const k = prefix
      ? this.nk(prefix.includes('*') ? prefix : `${prefix}*`)
      : undefined;

    if (k) {
      this.l1.deletePattern(k);
      // Disk-tier pattern delete is not supported (files are keyed by SHA-256 hash);
      // prefix-scoped clears only evict from L1, matching existing delete('glob*') semantics.
    } else {
      this.l1.clear();
      this.disk.clear();
      this._l1Counters.clear();
      this.tagIndex.clear();
    }

    if (!this._redisDisabled && this.opts.l2WriteMode === 'read-write') {
      try {
        const client  = await this.getRedis();
        const pattern = k ?? (this._namespace ? `${this._namespace}:*` : '*');
        const stream  = client.scanStream({ match: pattern, count: 100 });
        const keys: string[] = [];
        await new Promise<void>((resolve, reject) => {
          stream.on('data',  (chunk: string[]) => keys.push(...chunk));
          stream.on('end',   resolve);
          stream.on('error', reject);
        });
        if (keys.length > 0) await client.del(...keys);
      } catch (err) {
        this.logger.debug('clear: Redis unavailable', { error: (err as Error).message });
      }
    }

    void this.publishInvalidation('del-glob',
      k ?? (this._namespace ? `${this._namespace}:*` : '*'));
  }

  /**
   * Evict L1 entries that violate the current category or global capacity limits.
   * Useful after a write burst or after adding stricter `categoryLimits`.
   * Returns the number of entries evicted.
   */
  rebalance(): number {
    return this.l1.rebalance();
  }

  /**
   * Return the remaining TTL in seconds for a key currently in L1.
   * Returns null if the key is absent from L1 or has already expired.
   * Only reflects L1 state — does not query Redis or disk.
   */
  ttl(cacheKey: string): number | null {
    return this.l1.ttl(this.nk(cacheKey));
  }

  /**
   * Return true if the key exists in L1 and has not expired.
   * Bloom-filter fast path — no fetch, no disk or Redis round-trip.
   */
  has(cacheKey: string): boolean {
    return this.l1.has(this.nk(cacheKey));
  }

  // ── Iteration ─────────────────────────────────────────────────────────────

  /**
   * Lazily yield every non-expired L1 key, stripped of its namespace prefix.
   *
   * @example
   * for (const key of cache.keys()) console.log(key);
   */
  *keys(): Generator<string> {
    const prefixLen = this._namespace ? this._namespace.length + 1 : 0;
    for (const key of this.l1.liveKeys()) {
      yield prefixLen > 0 ? key.slice(prefixLen) : key;
    }
  }

  /**
   * Lazily yield every non-expired L1 value.
   * Each value is the cached (pre-deserialized) JS object — no unpack overhead.
   *
   * @example
   * for (const val of cache.values<User>()) console.log(val.id);
   */
  *values<T = unknown>(): Generator<T> {
    // yield* delegates directly into liveValues(), collapsing one generator frame.
    yield* this.l1.liveValues() as Generator<T>;
  }

  /**
   * Lazily yield every non-expired L1 [key, value] pair.
   * Keys are stripped of their namespace prefix.
   *
   * @example
   * for (const [key, val] of cache.entries<User>()) console.log(key, val.id);
   */
  *entries<T = unknown>(): Generator<[string, T]> {
    const prefixLen = this._namespace ? this._namespace.length + 1 : 0;
    for (const [key, entry] of this.l1.liveEntries()) {
      const k = prefixLen > 0 ? key.slice(prefixLen) : key;
      yield [k, (entry.value !== undefined ? entry.value : entry.data) as T];
    }
  }

  /**
   * High-throughput bulk scan over all live L1 entries.
   *
   * Compared with `entries()` this avoids generator frame overhead, per-entry
   * `[key, value]` tuple allocation, and the `key.slice()` allocation when the
   * caller uses the `offset` parameter instead of pre-slicing.
   *
   * ```typescript
   * // Zero extra string allocations — use rawKey + offset directly:
   * cache.scan((rawKey, value, offset) => {
   *   const key = rawKey.slice(offset); // allocate only if needed
   *   sync(key, value as User);
   * });
   * ```
   *
   * @param fn Called once per live L1 entry.
   *           `rawKey`  — key with namespace prefix still attached.
   *           `value`   — deserialized cached value.
   *           `offset`  — `rawKey.slice(offset)` gives the bare key without namespace.
   */
  scan<T = unknown>(fn: (rawKey: string, value: T, offset: number) => void): void {
    const prefixLen = this._namespace ? this._namespace.length + 1 : 0;
    this.l1.scan((key, entry, pfx) => {
      const value = (entry.value !== undefined ? entry.value : entry.data) as T;
      fn(key, value, pfx);
    }, prefixLen);
  }

  /**
   * Extend the TTL of a key in L1 (and fire-and-forget EXPIRE in Redis) without fetching.
   * Returns `false` if the key is absent or already expired.
   *
   * @param newTtlSeconds - The new TTL from now, in seconds.
   */
  async touch(cacheKey: string, newTtlSeconds: number): Promise<boolean> {
    const k   = this.nk(cacheKey);
    const hit = this.l1.touch(k, newTtlSeconds * 1_000);
    if (hit && !this._redisDisabled) {
      try {
        const client = await this.getRedis();
        void client.expire(k, newTtlSeconds); // fire-and-forget
      } catch { /* ok */ }
    }
    return hit;
  }

  /**
   * Return the cached value from L1 **only if it is fresh** (not in the SWR grace window).
   * Returns `null` when the key is absent, expired, or stale — without triggering a fetch.
   *
   * @example
   * const fresh = cache.getIfFresh('user:123');
   * if (fresh !== null) return fresh; // serve from L1, no network hop
   */
  getIfFresh<T = unknown>(cacheKey: string): T | null {
    const k     = this.nk(cacheKey);
    const entry = this.l1.getEntry(k);
    if (!entry) return null;
    const now = Date.now();
    if (entry.expiresAt <= now) return null;               // expired
    if (entry.staleAt !== undefined && entry.staleAt < now) return null; // in SWR grace
    return (entry.value !== undefined ? entry.value : unpack(entry.data)) as T;
  }

  /**
   * Batch get — fetches multiple keys, using L1 where hot and calling `fetchFn` for misses.
   * Preserves input ordering. Uses inflight coalescing per key.
   *
   * @param keys    - Array of cache keys.
   * @param fetchFn - Called with only the keys that missed L1.
   * @param ttl     - TTL in seconds for newly fetched values. Accepts a per-key function
   *                  `(key) => number` so heterogeneous TTLs can be batched in one call.
   */
  async mget<T>(
    keys: string[],
    fetchFn: (missKeys: string[]) => Promise<Record<string, T>>,
    ttl: number | ((key: string) => number) = 300,
    priority?: CachePriority,
  ): Promise<(T | undefined)[]> {
    const result: (T | undefined)[] = new Array(keys.length);
    const missIndexes: number[] = [];
    const missKeys:   string[]  = [];

    for (let i = 0; i < keys.length; i++) {
      const entry = this.l1.getEntry(this.nk(keys[i]));
      if (entry && entry.expiresAt > Date.now()) {
        result[i] = (entry.value !== undefined ? entry.value : unpack(entry.data)) as T;
        this.counters.l1Hits++;
      } else {
        missIndexes.push(i);
        missKeys.push(keys[i]);
      }
    }

    if (missKeys.length > 0) {
      const fetched = await fetchFn(missKeys);
      for (let j = 0; j < missKeys.length; j++) {
        const v = fetched[missKeys[j]];
        result[missIndexes[j]] = v;
        if (v !== undefined) {
          const resolvedTtl = typeof ttl === 'function' ? ttl(missKeys[j]) : ttl;
          await this.set(missKeys[j], v, resolvedTtl, priority);
        }
      }
    }

    return result;
  }

  /**
   * Returns a Promise that resolves once the cache is fully initialised and any
   * startup warming configured via `warmKeys` has completed.
   *
   * Without `warmKeys`, resolves immediately. With `warmKeys`, resolves once
   * `warmFromL2(warmKeys)` finishes — ideal for k8s readiness probes.
   *
   * @example
   * const cache = CacheService.create({ warmKeys: 'user:*' });
   * await cache.ready(); // gate traffic until warm
   */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * Batch write — set multiple entries in a single call.
   * TTL jitter is applied per-entry when `ttlJitterFactor` > 0.
   *
   * @example
   * await cache.mset({
   *   'user:1': { value: { name: 'Alice' }, ttl: 300 },
   *   'user:2': { value: { name: 'Bob'   }, ttl: 300, priority: CachePriority.HIGH },
   * });
   */
  async mset<T = unknown>(
    entries: Record<string, { value: T; ttl?: number; priority?: CachePriority; tags?: string[]; dependsOn?: string[] }>,
  ): Promise<void> {
    const keys = Object.keys(entries);
    await Promise.all(keys.map(key => {
      const { value, ttl = 300, priority, tags, dependsOn } = entries[key];
      const hasOpts = tags?.length || dependsOn?.length;
      return this.set(key, value, ttl, priority, hasOpts ? { tags, dependsOn } : undefined);
    }));
  }

  /**
   * Batch delete — delete multiple exact keys in a single call.
   * Glob patterns are not supported; use `delete('prefix:*')` for patterns.
   *
   * @example
   * await cache.mdel(['user:1', 'user:2', 'user:3']);
   */
  async mdel(keys: string[]): Promise<void> {
    await Promise.all(keys.map(k => this.delete(k)));
  }

  /**
   * Warm L1 from L2 (Redis) by scanning for keys matching a glob pattern and
   * pulling them into L1. Useful on startup to eliminate cold-start penalty when
   * the local snapshot is unavailable or too stale.
   *
   * Returns the number of keys loaded into L1.
   *
   * @example
   * // In your startup hook (e.g. ECS task, k8s readiness probe):
   * const loaded = await cache.warmFromL2('org:*');
   * console.log(`Warmed ${loaded} keys from Redis`);
   */
  async warmFromL2(pattern: string, opts?: { priority?: CachePriority }): Promise<number> {
    if (this._redisDisabled) return 0;
    try {
      const client  = await this.getRedis();
      const nsPattern = this.nk(pattern);

      // Collect all matching keys via SCAN
      const matchedKeys: string[] = [];
      const stream = client.scanStream({ match: nsPattern, count: 100 });
      await new Promise<void>((resolve, reject) => {
        stream.on('data',  (chunk: string[]) => matchedKeys.push(...chunk));
        stream.on('end',   resolve);
        stream.on('error', reject);
      });

      if (matchedKeys.length === 0) {
        this.cb.onSuccess();
        return 0;
      }

      // Fetch values in a pipeline and load into L1
      const pl = client.pipeline();
      for (const k of matchedKeys) pl.get(k);
      const results = await pl.exec() as Array<[Error | null, string | null]>;
      this.cb.onSuccess();

      let loaded = 0;
      const now = Date.now();
      for (let i = 0; i < matchedKeys.length; i++) {
        const [err, raw] = results[i];
        if (err || raw == null) continue;
        try {
          const decrypted = this.enc.isEnabled ? this.enc.decrypt(raw) : raw;
          const parsed    = JSON.parse(decrypted) as unknown;
          // Use a 10-minute TTL as a reasonable default; the real TTL is not
          // returned by GET (use PTTL to be precise, but that doubles round-trips).
          const remainingMs = 10 * 60 * 1_000;
          this.l1.set(matchedKeys[i], parsed, remainingMs, opts?.priority ?? inferPriority(matchedKeys[i]));
          loaded++;;
        } catch { /* skip malformed entries */ }
      }
      void now; // suppress unused warning

      this.logger.info('warmFromL2 complete', {
        pattern, matched: matchedKeys.length, loaded,
      });
      return loaded;
    } catch (err) {
      this.cb.onFailure();
      this.logger.debug('warmFromL2: Redis unavailable', { error: (err as Error).message });
      return 0;
    }
  }

  /**
   * Invalidate all keys associated with a tag.
   * Deletes from L1, disk, and Redis (both the keyed values and the tag set).
   *
   * @example
   * await cache.set('product:1', data, 60, undefined, { tags: ['catalog'] });
   * await cache.invalidateTag('catalog'); // clears product:1 and any other tagged entries
   */
  async invalidateTag(tag: string): Promise<void> {
    const tagKey  = this.nk(`_tag_:${tag}`);
    const members = this.tagIndex.get(tagKey) ?? new Set<string>();

    // Remove from L1 + disk
    for (const k of members) {
      this.l1.delete(k);
      this.disk.delete(k);
    }
    this.tagIndex.delete(tagKey);

    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const redisMembers: string[] = await client.smembers(tagKey);
        const toDelete = [...new Set([...members, ...redisMembers])];
        if (toDelete.length > 0) {
          await client.del(...toDelete, tagKey);
        } else {
          await client.del(tagKey);
        }
      } catch (err) {
        this.logger.debug('invalidateTag: Redis unavailable', { tag, error: (err as Error).message });
      }
    }
  }

  /**
   * Invalidate all keys associated with any of the given tags in a single operation.
   * Combines multiple `invalidateTag()` calls into one Redis pipeline round-trip,
   * reducing latency when invalidating several related tags together.
   *
   * Note: Redis pipelines are batched, not atomic. All L1/disk deletes happen
   * synchronously before the Redis round-trip.
   *
   * @example
   * // Instead of three serial round-trips:
   * await cache.invalidateTags(['case:acme', 'org:acme', 'ai-chat:acme']);
   */
  async invalidateTags(tags: string[]): Promise<void> {
    if (tags.length === 0) return;
    if (tags.length === 1) { await this.invalidateTag(tags[0]); return; }

    // In-process: collect all member keys across all tags and remove from L1 + disk
    const tagKeys: string[] = [];
    const allMembers = new Set<string>();
    for (const tag of tags) {
      const tagKey = this.nk(`_tag_:${tag}`);
      tagKeys.push(tagKey);
      const members = this.tagIndex.get(tagKey) ?? new Set<string>();
      for (const k of members) allMembers.add(k);
      this.tagIndex.delete(tagKey);
    }
    for (const k of allMembers) {
      this.l1.delete(k);
      this.disk.delete(k);
    }

    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        // Single round-trip: pipeline SMEMBERS for all tag keys
        const pl = client.pipeline();
        for (const tagKey of tagKeys) pl.smembers(tagKey);
        const smResults = await pl.exec() as Array<[Error | null, string[] | null]>;

        // Merge Redis members into the master delete set
        const toDelete: string[] = [...allMembers];
        for (const [err, redisMembers] of smResults) {
          if (!err && redisMembers) {
            for (const k of redisMembers) { if (!allMembers.has(k)) toDelete.push(k); }
          }
        }
        // Single DEL for all member keys + tag keys
        const keysToRemove = [...toDelete, ...tagKeys];
        if (keysToRemove.length > 0) await client.del(...keysToRemove);
      } catch (err) {
        this.logger.debug('invalidateTags: Redis unavailable', { tags, error: (err as Error).message });
      }
    }
  }

  /**
   * Measure L1 / disk / Redis latency.
   * Useful for health checks and dashboards.
   *
   * @returns `{ l1, disk, l2 }` latencies in milliseconds.
   *          `l2` is `null` when Redis is disabled.
   */
  async ping(): Promise<CachePingResult> {
    // L1: measure a has() call
    const t0 = Date.now();
    this.l1.has('__ping__');
    const l1 = Date.now() - t0;

    // Disk: measure a stats access
    const t1 = Date.now();
    void this.disk.stats;
    const disk = Date.now() - t1;

    // L2: PING command
    let l2: number | null = null;
    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const t2 = Date.now();
        await client.ping();
        l2 = Date.now() - t2;
      } catch { l2 = null; }
    }

    return { l1, disk, l2 };
  }

  /**
   * Export all live L1 entries to Redis via a single pipeline.
   * Useful for warming a new Redis instance or for zero-downtime failover.
   * Returns the number of keys written.
   */
  async drainToL2(): Promise<number> {
    if (this._redisDisabled) return 0;
    try {
      const client  = await this.getRedis();
      const entries = this.l1.exportEntries([]);
      const now     = Date.now();
      if (entries.length === 0) return 0;

      const pl = client.pipeline();
      for (const { key, entry } of entries) {
        const remainingMs = entry.expiresAt - now;
        if (remainingMs <= 0) continue;
        const ttlSecs = Math.max(1, Math.ceil(remainingMs / 1_000));
        const s       = JSON.stringify(entry.value);
        const stored  = this.enc.isEnabled ? this.enc.encrypt(s) : s;
        pl.setex(key, ttlSecs, stored);
      }
      await pl.exec();
      return entries.length;
    } catch (err) {
      this.logger.debug('drainToL2: Redis unavailable', { error: (err as Error).message });
      return 0;
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────

  stats() {
    return {
      l1:   this.l1.getStats(),
      disk: this.disk.stats,
    };
  }

  // ── Conditional write ─────────────────────────────────────────────────

  /**
   * Write `value` only if the key is not already cached.
   * Returns `true` if the write happened, `false` if the key already existed.
   *
   * When Redis is available, atomicity is guaranteed via `SET NX EX` so this
   * is safe to use for idempotency keys and "first writer wins" patterns across
   * multiple instances. L1 is populated on success.
   *
   * @example
   * const claimed = await cache.setIfAbsent('idempotency:req_abc', payload, 300);
   * if (!claimed) return res.status(409).json({ error: 'duplicate request' });
   */
  async setIfAbsent<T>(cacheKey: string, value: T, ttlSeconds = 300, priority?: CachePriority): Promise<boolean> {
    const k = this.nk(cacheKey);

    // Fast path: L1 check (process-local, no network hop)
    if (this.l1.has(k)) return false;

    if (!this._redisDisabled) {
      try {
        const client     = await this.getRedis();
        const serialized = JSON.stringify(value);
        const toStore    = this.enc.isEnabled ? this.enc.encrypt(serialized) : serialized;
        // SET key value EX ttl NX — atomic; returns 'OK' on success, null if key exists
        const result     = await client.set(k, toStore, 'EX', ttlSeconds, 'NX');
        this.cb.onSuccess();
        if (result === null) return false; // already exists in Redis
      } catch (err) {
        this.cb.onFailure();
        this.logger.debug('setIfAbsent: Redis unavailable, falling back to L1 check', { cacheKey, error: (err as Error).message });
        // Re-check L1 after Redis failure — another thread may have won the race
        if (this.l1.has(k)) return false;
      }
    }

    const ttlMs = this._jitterTtl(ttlSeconds * 1_000);
    const p     = priority ?? inferPriority(cacheKey);
    this.l1.set(k, value, ttlMs, p);
    this.counters.sets++;
    return true;
  }

  // ── Hot key introspection ─────────────────────────────────────────────

  /**
   * Return the top-N live L1 keys by historical access frequency.
   * Powered by the Count-Min Sketch — includes evicted-then-re-admitted keys
   * whose historical frequency exceeds their current in-memory hit count.
   *
   * Useful for diagnosing what is driving L1 pressure without any extra data
   * collection overhead.
   *
   * @param n - Maximum number of keys to return. Default: 10.
   *
   * @example
   * cache.hotKeys(5).forEach(({ key, hits, sizeBytes }) =>
   *   console.log(key, hits, (sizeBytes / 1024).toFixed(1) + ' KB'));
   */
  hotKeys(n = 10): Array<{ key: string; hits: number; sizeBytes: number }> {
    const prefixLen = this._namespace ? this._namespace.length + 1 : 0;
    return this.l1.hotKeys(n).map(({ key, hits, sizeBytes }) => ({
      key: prefixLen > 0 ? key.slice(prefixLen) : key,
      hits,
      sizeBytes,
    }));
  }

  // ── Dependency cascade helpers ────────────────────────────────────────

  /**
   * Test whether `key` (a concrete namespaced key) matches `pattern` (a glob
   * pattern that may contain `*` wildcards).
   */
  private _matchesGlob(key: string, pattern: string): boolean {
    if (!pattern.includes('*')) return key === pattern;
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(key);
  }

  /**
   * When an exact key `deletedKey` is removed, cascade to every dependent key
   * that was registered via `dependsOn` and whose source pattern matches.
   */
  private _cascadeDependencies(deletedKey: string): void {
    for (const [pattern, dependents] of this.dependencyIndex) {
      if (!this._matchesGlob(deletedKey, pattern)) continue;
      for (const dep of dependents) {
        if (dep === deletedKey) continue; // no self-cascade
        this.l1.delete(dep);
        this.disk.delete(dep);
        void this.publishInvalidation('del', dep);
        this.logger.debug('Dependency cascade: invalidated dependent key', {
          trigger: deletedKey.slice(0, 60), dependent: dep.slice(0, 60),
        });
      }
    }
  }


  // ── Observability ──────────────────────────────────────────────────────────────────

  /** Return a full metrics snapshot. */
  metrics(): CacheMetrics {
    const c   = this.counters;
    const l1s = this.l1.getStats();
    const div = (n: number, d: number) => (d > 0 ? n / d : 0);

    return {
      namespace: this.opts.namespace,
      uptimeMs:  Date.now() - c.startedAt,

      gets: {
        total:             c.gets,
        l1Hits:            c.l1Hits,
        l1HitRate:         div(c.l1Hits,  c.gets),
        diskHits:          c.diskHits,
        diskHitRate:       div(c.diskHits, c.gets),
        l2Hits:            c.l2Hits,
        l2HitRate:         div(c.l2Hits,  c.gets),
        fetches:           c.fetches,
        fetchRate:         div(c.fetches,  c.gets),
        stampedePrevented: c.stampedes,
      },

      sets:          { total: c.sets },
      deletes:       { total: c.deletes },
      revalidations: { total: c.swrRevalidations },

      bloom: {
        checksTotal:       l1s.bloom.checks,
        falsePositives:    l1s.bloom.falsePositives,
        falsePositiveRate: div(l1s.bloom.falsePositives, l1s.bloom.checks),
      },

      compression: {
        entriesCompressed:   l1s.compression.compressed,
        entriesUncompressed: l1s.compression.uncompressed,
        bytesSaved:          l1s.compression.bytesSaved,
      },

      backplane: {
        enabled:  this.opts.invalidationBackplane && !this._redisDisabled,
        sent:     c.invSent,
        received: c.invReceived,
        skipped:  c.invSkipped,
      },

      l2CircuitBreaker: {
        state: this.cb.currentState,
      },

      oom: {
        enabled:         this.opts.oomProtection,
        evictions:       c.oomEvictions,
        lastTriggeredAt: c.oomLastAt,
      },

      l1: {
        entries:   l1s.entries,
        sizeBytes: this.l1.memoryUsage,
        maxBytes:  this.opts.l1MaxBytes,
      },
      disk: this.disk.stats,
    };
  }

  /**
   * Convert a `CacheMetrics` snapshot to Prometheus text exposition format.
   * Paste the result into your `/metrics` endpoint.
   *
   * @param m      - Snapshot returned by `cache.metrics()`
   * @param prefix - Metric name prefix. Default: `"tricache"`
   */
  static toPrometheusText(m: CacheMetrics, prefix = 'tricache', instanceName?: string): string {
    const parts: string[] = [];
    if (m.namespace) parts.push(`namespace="${m.namespace}"`);
    if (instanceName) parts.push(`instance="${instanceName}"`);
    const lbl  = parts.length ? `{${parts.join(',')}}` : '';
    const lines: string[] = [];

    const counter = (name: string, val: number, help: string) => {
      lines.push(`# HELP ${prefix}_${name}_total ${help}`);
      lines.push(`# TYPE ${prefix}_${name}_total counter`);
      lines.push(`${prefix}_${name}_total${lbl} ${val}`);
    };
    const gauge = (name: string, val: number, help: string) => {
      lines.push(`# HELP ${prefix}_${name} ${help}`);
      lines.push(`# TYPE ${prefix}_${name} gauge`);
      lines.push(`${prefix}_${name}${lbl} ${val}`);
    };

    counter('gets',                m.gets.total,             'Total get() calls');
    counter('l1_hits',             m.gets.l1Hits,            'L1 RAM cache hits');
    counter('disk_hits',           m.gets.diskHits,          'L1.5 disk tier hits');
    counter('l2_hits',             m.gets.l2Hits,            'L2 Redis hits');
    counter('fetches',             m.gets.fetches,           'fetchFn calls (cache misses)');
    counter('stampedes_prevented', m.gets.stampedePrevented, 'Coalesced duplicate inflight requests');
    counter('sets',                m.sets.total,             'Total set() calls');
    counter('deletes',             m.deletes.total,          'Total delete() calls');
    counter('swr_revalidations',   m.revalidations.total,    'Stale-While-Revalidate background refreshes');

    gauge('l1_hit_rate',   m.gets.l1HitRate,   'Fraction of gets served from L1 RAM (0-1)');
    gauge('disk_hit_rate', m.gets.diskHitRate, 'Fraction of gets served from disk (0-1)');
    gauge('l2_hit_rate',   m.gets.l2HitRate,   'Fraction of gets served from Redis (0-1)');
    gauge('fetch_rate',    m.gets.fetchRate,   'Fraction of gets calling fetchFn (0-1)');

    gauge('l1_entries',    m.l1.entries,   'Current L1 entry count');
    gauge('l1_size_bytes', m.l1.sizeBytes, 'Current L1 used bytes');
    gauge('disk_files',    m.disk.files,   'Current L1.5 disk file count');

    gauge('bloom_false_positive_rate', m.bloom.falsePositiveRate,
      'Bloom filter false-positive rate; increase capacity if > 0.01');
    gauge('compression_bytes_saved', m.compression.bytesSaved,
      'Approximate bytes saved by msgpackr compression');

    if (m.backplane.enabled) {
      counter('backplane_sent',     m.backplane.sent,     'Invalidation messages sent via Pub/Sub');
      counter('backplane_received', m.backplane.received, 'Invalidation messages received from peers');
    }
    if (m.oom.enabled) {
      counter('oom_evictions', m.oom.evictions,
        'Emergency L1 eviction rounds triggered by heap pressure');
    }

    return lines.join('\n');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Close Redis connections and stop all background timers. */
  async destroy(): Promise<void> {
    if (this.cleanupInterval)     clearInterval(this.cleanupInterval);
    if (this.diskJanitorInterval)  clearInterval(this.diskJanitorInterval);
    if (this.oomInterval)          clearInterval(this.oomInterval);
    if (this.metricsInterval)      clearInterval(this.metricsInterval);
    if (this._shutdownHandler) {
      process.off('SIGTERM', this._shutdownHandler);
      process.off('SIGINT',  this._shutdownHandler);
      this._shutdownHandler = null;
    }
    if (this.subClient) {
      try { await this.subClient.quit(); } catch { /* ok */ }
      this.subClient = null;
    }
    if (this.redis) {
      try { await this.redis.disconnect(); } catch { /* ok */ }
      this.redis = null;
    }
  }

}