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
  if (/auth:|session:/.test(cacheKey))          return CachePriority.CRITICAL;
  if (/user:|org:|profile:/.test(cacheKey))      return CachePriority.HIGH;
  if (/analytics:|report:|stats:/.test(cacheKey)) return CachePriority.LOW;
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
  };
  private readonly inflight    = new Map<string, Promise<unknown>>();
  private readonly revalidating = new Set<string>();
  private redis:               RedisClient | null = null;
  private redisConnecting:     Promise<RedisClient> | null = null;
  private snapshotLoaded       = false;
  private cleanupInterval:     ReturnType<typeof setInterval> | null = null;

  // ── Constructor (use CacheService.create() for the recommended singleton) ──

  constructor(options: CacheOptions = {}) {
    const logger = options.logger ?? consoleLogger;
    this.logger  = logger;

    // Resolve namespace: trim whitespace, default to empty string
    const ns = options.namespace?.trim() ?? '';

    // Resolve encryption key: option > env var
    const encKeyRaw = options.encryptionKey ?? process.env.CACHE_ENCRYPTION_KEY;
    this.enc = new CacheEncryption(encKeyRaw, logger);

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
    const shutdown = () => { this.writeSnapshot(); process.exit(0); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT',  shutdown);

    // Periodic cleanup (5 min)
    this.cleanupInterval = setInterval(() => {
      const cleaned = this.l1.cleanup();
      const diskPurged = this.disk.purgeExpired();
      if (cleaned > 0 || diskPurged > 0) {
        this.logger.debug('Periodic cache cleanup', { cleaned, diskPurged });
      }
    }, 5 * 60 * 1000);
    if (this.cleanupInterval.unref) this.cleanupInterval.unref(); // don't block process exit
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
    return this.opts.namespace ? `${this.opts.namespace}:${key}` : key;
  }

  private isRedisDisabled(): boolean {
    if (this.opts.disableRedis) return true;
    if (!this.opts.redisHost)   return true;
    return false;
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
    const ttlMs        = ttlSeconds * 1_000;
    const swrGraceMs   = (opts.swr ?? 0) * 1_000;
    const priority     = opts.priority ?? inferPriority(cacheKey); // original key for correct prefix inference
    const k            = this.nk(cacheKey); // namespaced key used for all storage

    // L1: in-memory (fastest)
    const l1Hit = this.l1.get(k);
    if (l1Hit !== null) {
      if (l1Hit.isStale && swrGraceMs > 0 && !this.revalidating.has(k)) {
        this.revalidating.add(k);
        void this._revalidate(k, fetchFn, ttlMs, swrGraceMs, priority);
        this.logger.debug('SWR: serving stale, revalidating', { cacheKey });
      } else {
        this.logger.debug('L1 hit', { cacheKey });
      }
      return l1Hit.value as T;
    }

    // L2: Redis (distributed, production-only by default)
    if (!this.isRedisDisabled()) {
      try {
        const client = await this.getRedis();
        const raw    = await client.get(k);
        if (raw) {
          const decrypted = this.enc.isEnabled ? this.enc.decrypt(raw) : raw;
          const parsed    = JSON.parse(decrypted) as T;
          this.l1.set(k, parsed, ttlMs, { priority });
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
          this.logger.debug('L1.5 hit (disk → L1)', { cacheKey });
          return l1Check.value as T;
        }
      }
    }

    // Cache MISS: thundering-herd prevention
    const existing = this.inflight.get(k);
    if (existing) {
      this.logger.debug('Stampede prevented — coalescing onto inflight fetch', { cacheKey });
      return existing as Promise<T>;
    }

    const fetchPromise: Promise<T> = (async () => {
      try {
        const data     = await fetchFn();
        const staleAt  = swrGraceMs > 0 ? Date.now() + ttlMs : undefined;
        const storeTtl = swrGraceMs > 0 ? ttlMs + swrGraceMs : ttlMs;

        this.l1.set(k, data, storeTtl, { priority, staleAt });

        if (!this.isRedisDisabled()) {
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
      this.l1.set(cacheKey, data, ttlMs + swrGraceMs, { priority, staleAt });

      if (!this.isRedisDisabled()) {
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
    this.l1.set(k, data, ttlMs, { priority: p });

    if (!this.isRedisDisabled()) {
      try {
        const client = await this.getRedis();
        const s      = JSON.stringify(data);
        const stored = this.enc.isEnabled ? this.enc.encrypt(s) : s;
        await client.setex(k, ttlSeconds, stored);
      } catch (err) {
        this.logger.debug('set: Redis unavailable', { cacheKey, error: (err as Error).message });
      }
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
    const isPattern = cacheKey.includes('*');
    const k         = this.nk(cacheKey); // namespace-scoped key / pattern

    if (isPattern) {
      this.l1.deletePattern(k);
    } else {
      this.l1.delete(k);
      this.disk.delete(k);
    }

    if (!this.isRedisDisabled()) {
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
  }

  // ── Counter (distributed rate limiting) ──────────────────────────────────

  /**
   * Atomically increment a counter in Redis. Returns the new value.
   * Returns 0 if Redis is disabled (safe fallback — rate limiting won't block in dev).
   */
  async increment(cacheKey: string, ttlSeconds?: number): Promise<number> {
    if (this.isRedisDisabled()) return 0;
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

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Close Redis connection and stop the cleanup timer. */
  async destroy(): Promise<void> {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.redis) {
      try { await this.redis.disconnect(); } catch { /* ok */ }
      this.redis = null;
    }
  }

}
