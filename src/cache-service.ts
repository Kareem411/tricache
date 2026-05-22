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
import crypto from 'crypto';
import os    from 'os';
import fs    from 'fs';
import path  from 'path';
import { pack, unpack } from 'msgpackr';

import {
  CachePriority,
  CategoryLimit,
  SmartCacheEntry,
  DiskCacheEntry,
  CacheOptions,
  CacheMetrics,
  ILogger,
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
//  Priority inference — override by passing priority explicitly to get()
// ─────────────────────────────────────────────────────────────────────────────

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
  };
  /** Pre-computed once — opts.namespace never changes after construction. */
  private readonly _namespace:      string;
  /** Pre-computed once — disableRedis and redisHost never change after construction. */
  private readonly _redisDisabled:  boolean;
  private readonly inflight    = new Map<string, Promise<unknown>>();
  private readonly revalidating = new Set<string>();
  private redis:               RedisClient | null = null;
  private redisConnecting:     Promise<RedisClient> | null = null;
  private snapshotLoaded       = false;
  private cleanupInterval:     ReturnType<typeof setInterval> | null = null;
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
    this.enc = new CacheEncryption(encKeyRaw, logger, options.encryptionMode);

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
    };

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
      diskSpill:  (key: string, entry: SmartCacheEntry) => { void this.disk.save(key, entry as unknown as DiskCacheEntry); },
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

    // Periodic cleanup (5 min)
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.l1.cleanup();
      const diskPurged = this.disk.purgeExpired();
      if (cleaned > 0 || diskPurged > 0) {
        this.logger.debug('Periodic cache cleanup', { cleaned, diskPurged });
      }
    }, 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref(); // don't block process exit

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
      try {
        const msg = JSON.parse(message) as { op: 'del' | 'del-glob'; key: string; src: string };
        if (msg.src === this.instanceId) {
          this.counters.invSkipped++;
          return; // own message — our L1 is already current
        }
        this.counters.invReceived++;
        if (msg.op === 'del') {
          this.l1.delete(msg.key);
          this.disk.delete(msg.key);
        } else if (msg.op === 'del-glob') {
          this.l1.deletePattern(msg.key);
        }
        this.logger.debug('Backplane: peer invalidation applied', {
          op: msg.op, key: msg.key.slice(0, 60),
        });
      } catch { /* malformed message — ignore */ }
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
    if (this.redis?.status === 'ready') return this.redis as RedisClient;
    if (this.redisConnecting) return this.redisConnecting;

    this.redisConnecting = (async () => {
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

      this.redis = client;
      this.redisConnecting = null;
      return client;
    })();

    return this.redisConnecting;
  }

  // ── Snapshot (cold-start persistence) ────────────────────────────────────

  writeSnapshot(): void {
    try {
      const entries = this.l1.exportEntries(this.opts.forbiddenSnapshotPrefixes);
      if (entries.length === 0) return;

      const payload = { version: SNAPSHOT_VERSION, writtenAt: Date.now(), entries };
      const packed  = pack(payload);
      const final   = this.enc.isEnabled ? this.enc.encryptBuffer(packed) : packed;

      fs.writeFileSync(this.opts.snapshotPath, final, { mode: 0o600 });
      this.logger.info('Cache snapshot written', {
        path: this.opts.snapshotPath, entries: entries.length,
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
   * @param opts.priority - Override the auto-inferred eviction priority
   * @param opts.swr      - Stale-While-Revalidate grace seconds. When > 0 the entry stays
   *                        alive for this many extra seconds after TTL; callers get stale data
   *                        instantly while a background refresh runs. Default: 0 (disabled).
   */
  async get<T>(
    cacheKey:   string,
    fetchFn:    () => Promise<T>,
    ttlSeconds: number = 300,
    opts: {
      priority?: CachePriority;
      swr?:      number; // Stale-While-Revalidate grace period in seconds
    } = {},
  ): Promise<T> {
    const k = this.nk(cacheKey); // namespaced key used for all storage
    this.counters.gets++;

    // L1: in-memory (fastest path — defer inferPriority / ttlMs until we confirm a miss;
    // inferPriority runs 3 regex tests that are wasted work on every warm hit)
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
      }
      this.counters.l1Hits++;
      return l1Hit.value as T;
    }

    const ttlMs      = ttlSeconds * 1_000;
    const swrGraceMs = (opts.swr ?? 0) * 1_000;
    const priority   = opts.priority ?? inferPriority(cacheKey); // original key for correct prefix inference

    // L2: Redis (distributed, production-only by default)
    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const raw    = await client.get(k);
        if (raw) {
          const decrypted = this.enc.isEnabled ? this.enc.decrypt(raw) : raw;
          const parsed    = JSON.parse(decrypted) as T;
          this.l1.set(k, parsed, ttlMs, priority);
          this.counters.l2Hits++;
          this.logger.debug('L2 hit (Redis)', { cacheKey });
          return parsed;
        }
      } catch (err) {
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
          this.logger.debug('L1.5 hit (disk → L1)', { cacheKey });
          return l1Check.value as T;
        }
      }
    }

    // Cache MISS: thundering-herd prevention
    const existing = this.inflight.get(k);
    if (existing) {
      this.counters.stampedes++;
      this.logger.debug('Stampede prevented — coalescing onto inflight fetch', { cacheKey });
      return existing as Promise<T>;
    }

    const fetchPromise: Promise<T> = (async () => {
      try {
        this.counters.fetches++;
        const data     = await fetchFn();
        const staleAt  = swrGraceMs > 0 ? Date.now() + ttlMs : undefined;
        const storeTtl = swrGraceMs > 0 ? ttlMs + swrGraceMs : ttlMs;

        this.l1.set(k, data, storeTtl, priority, staleAt);

        if (!this._redisDisabled) {
          try {
            const client     = await this.getRedis();
            const serialized = JSON.stringify(data);
            const toStore    = this.enc.isEnabled ? this.enc.encrypt(serialized) : serialized;
            await client.setex(k, ttlSeconds, toStore);
            this.logger.debug('Cached L1+L2', { cacheKey, ttlSeconds, encrypted: this.enc.isEnabled });
          } catch {
            this.logger.debug('Cached L1 only (Redis unavailable)', { cacheKey });
          }
        } else {
          this.logger.debug('Cached L1', { cacheKey });
        }

        return data;
      } finally {
        this.inflight.delete(k);
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
      const data    = await fetchFn();
      const staleAt = Date.now() + ttlMs;
      this.l1.set(cacheKey, data, ttlMs + swrGraceMs, priority, staleAt);

      if (!this._redisDisabled) {
        try {
          const client = await this.getRedis();
          const s      = JSON.stringify(data);
          const stored = this.enc.isEnabled ? this.enc.encrypt(s) : s;
          await client.setex(cacheKey, Math.ceil(ttlMs / 1_000), stored);
        } catch { /* ok */ }
      }
      this.logger.debug('SWR: revalidation complete', { cacheKey });
    } catch (err) {
      this.logger.debug('SWR: revalidation failed', { cacheKey, error: (err as Error).message });
    } finally {
      this.revalidating.delete(cacheKey);
    }
  }

  // ── Explicit set / delete ─────────────────────────────────────────────────

  /** Explicitly write a value into L1 (+ L2 in production). */
  async set<T>(cacheKey: string, data: T, ttlSeconds = 300, priority?: CachePriority): Promise<void> {
    const ttlMs = ttlSeconds * 1_000;
    const p     = priority ?? inferPriority(cacheKey);
    const k     = this.nk(cacheKey);
    this.counters.sets++;
    this.l1.set(k, data, ttlMs, p);

    if (!this._redisDisabled) {
      try {
        const client = await this.getRedis();
        const s      = JSON.stringify(data);
        const stored = this.enc.isEnabled ? this.enc.encrypt(s) : s;
        await client.setex(k, ttlSeconds, stored);
      } catch (err) {
        this.logger.debug('set: Redis unavailable', { cacheKey, error: (err as Error).message });
      }
    }

    void this.publishInvalidation('del', k);
  }

  /**
   * Delete one key or a glob pattern (supports `*` wildcard).
   *
   * @example
   * await cache.delete('user:abc:profile');       // exact key
   * await cache.delete('user:abc:*');              // all keys for user abc
   */
  async delete(cacheKey: string): Promise<void> {
    const isPattern = cacheKey.includes('*');
    const k         = this.nk(cacheKey); // namespace-scoped key / pattern
    this.counters.deletes++;

    if (isPattern) {
      this.l1.deletePattern(k);
    } else {
      this.l1.delete(k);
      this.disk.delete(k);
    }

    if (!this._redisDisabled) {
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
      } catch (err) {
        this.logger.debug('delete: Redis unavailable', { cacheKey, error: (err as Error).message });
      }
    }

    void this.publishInvalidation(isPattern ? 'del-glob' : 'del', k);
  }

  // ── Counter (distributed rate limiting) ──────────────────────────────────

  /**
   * Atomically increment a counter in Redis. Returns the new value.
   * Returns 0 if Redis is disabled (safe fallback — rate limiting won't block in dev).
   */
  async increment(cacheKey: string, ttlSeconds?: number): Promise<number> {
    if (this._redisDisabled) return 0;
    const k = this.nk(cacheKey);
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

  // ── Stats ─────────────────────────────────────────────────────────────────

  stats() {
    return {
      l1:   this.l1.getStats(),
      disk: this.disk.stats,
    };
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
  static toPrometheusText(m: CacheMetrics, prefix = 'tricache'): string {
    const lbl  = m.namespace ? `{namespace="${m.namespace}"}` : '';
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
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.oomInterval)     clearInterval(this.oomInterval);
    if (this.metricsInterval) clearInterval(this.metricsInterval);
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