/**
 * SmartMemoryCache — L1 in-process cache with adaptive LFU/LRU hybrid eviction.
 *
 * Features:
 *  - WASM Bloom filter for O(k) guaranteed-miss detection (pure-JS fallback)
 *  - msgpackr compression for entries ≥ 512 bytes
 *  - Category-aware capacity limits (prevents any single key prefix from monopolising RAM)
 *  - Priority-weighted adaptive eviction (LFU × LRU × priority score)
 *  - Stale-While-Revalidate soft-expiry support (isStale flag on get())
 *  - L1.5 disk-spill on eviction — evicted entries are sent to DiskTier before deletion
 *  - Periodic cleanup of hard-expired entries + bloom filter rebuild
 *  - Process-level singleton via globalThis (survives Next.js hot reloads)
 */

import { pack, unpack } from 'msgpackr';
import type { CacheHit, CachePriority, CategoryLimit, SmartCacheEntry, ILogger } from './types';
import { WasmBloomFilter } from './wasm/bloom-filter-wasm';



/** Fraction of candidates evicted in one pass when a limit is exceeded */
const EVICTION_BATCH_PERCENT = 0.2;

// ─── Pure-JS Bloom filter fallback ───────────────────────────────────────────

class JsBloomFilter {
  private bits: Buffer;
  private readonly numBits: number;
  private readonly k: number;
  /** Pre-computed — numBits and k are constant, no need to recalculate on every probe. */
  private readonly _maxCapacity: number;
  /** Tracks total add() calls so we know when phantom bits have saturated the filter. */
  private _insertionCount = 0;

  constructor(numBits = 100_000, k = 7) {
    this.numBits = numBits;
    this.k = k;
    this.bits = Buffer.alloc(Math.ceil(numBits / 8), 0);
    const p = 0.01;
    this._maxCapacity = Math.floor(-numBits * Math.log(1 - Math.pow(p, 1 / k)) / k);
  }

  private fnv1a32(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }

  private djb2(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }

  private setBit(i: number)          { this.bits[i >>> 3] |= 1 << (i & 7); }
  private getBit(i: number): boolean { return (this.bits[i >>> 3] & (1 << (i & 7))) !== 0; }

  add(key: string): void {
    const h1 = this.fnv1a32(key), h2 = this.djb2(key);
    for (let i = 0; i < this.k; i++) this.setBit(((h1 + i * h2) >>> 0) % this.numBits);
    this._insertionCount++;
  }

  mightContain(key: string): boolean {
    const h1 = this.fnv1a32(key), h2 = this.djb2(key);
    for (let i = 0; i < this.k; i++) if (!this.getBit(((h1 + i * h2) >>> 0) % this.numBits)) return false;
    return true;
  }

  reset()                          { this.bits.fill(0); this._insertionCount = 0; }
  rebuild(keys: Iterable<string>)  { this.bits.fill(0); this._insertionCount = 0; for (const k of keys) this.add(k); }

  /** Number of add() calls since last reset/rebuild. */
  get insertions(): number { return this._insertionCount; }

  /**
   * Maximum safe insertions before false-positive rate exceeds ~1 %.
   * Exact formula for the configured k and target p=1 %:
   *   n_max = -m * ln(1 - p^(1/k)) / k
   */
  get maxCapacity(): number { return this._maxCapacity; }

  get stats(): { bitsSet: number; fillFactor: number } {
    let bitsSet = 0;
    for (const byte of this.bits) { let b = byte; while (b) { bitsSet++; b &= b - 1; } }
    return { bitsSet, fillFactor: bitsSet / this.numBits };
  }
}

type AnyBloomFilter = JsBloomFilter | WasmBloomFilter;

function createBloomFilter(logger: ILogger): AnyBloomFilter {
  try {
    const wasm = new WasmBloomFilter();
    logger.debug('SmartMemoryCache: WASM BloomFilter active');
    return wasm;
  } catch (err) {
    logger.debug('SmartMemoryCache: WASM unavailable — using pure-JS BloomFilter', { reason: (err as Error).message });
    return new JsBloomFilter();
  }
}

// ─── SmartMemoryCache ─────────────────────────────────────────────────────────

export interface SmartMemoryCacheOptions {
  maxBytes:    number;
  maxEntries:  number;
  categories:  Record<string, CategoryLimit>;
  diskSpill?:  (key: string, entry: SmartCacheEntry) => void | Promise<void>;
  logger:      ILogger;
}

export class SmartMemoryCache {
  private readonly cache             = new Map<string, SmartCacheEntry>();
  private readonly opts:             SmartMemoryCacheOptions;
  private bloom:                     AnyBloomFilter;
  /** Non-default category prefixes pre-extracted to avoid Object.keys() allocation on every call. */
  private readonly categoryPrefixes: string[];
  private totalSize                  = 0;
  private categoryCount              = new Map<string, number>();
  private categorySize               = new Map<string, number>();
  /** Per-category key sets — enables O(catSize) Phase-1 reservoir sampling without an O(N) scan. */
  private categoryKeys               = new Map<string, Set<string>>();

  // ── Observability counters ──────────────────────────────────────────────────────
  private bloomChecks           = 0;
  private bloomFalsePos         = 0;
  private compressions          = 0;

  /** Counts every _delete() call — used to trigger bloom rebuild from ALL deletion paths. */
  private _bloomDirtyCount      = 0;

  constructor(opts: SmartMemoryCacheOptions, existing?: Map<string, SmartCacheEntry>) {
    this.opts             = opts;
    this.bloom            = createBloomFilter(opts.logger);
    this.categoryPrefixes = Object.keys(opts.categories).filter(k => k !== 'default');

    if (existing) {
      for (const [k, v] of existing) this.cache.set(k, v);
      this.recalculateStats();
      for (const key of this.cache.keys()) this.bloom.add(key);
    }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private recalculateStats(): void {
    this.totalSize = 0;
    this.categoryCount.clear();
    this.categorySize.clear();
    this.categoryKeys.clear();
    for (const [key, entry] of this.cache) {
      this.totalSize += entry.size;
      const cat = this.getCategory(key);
      this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 0) + 1);
      this.categorySize.set(cat, (this.categorySize.get(cat) ?? 0) + entry.size);
      let ks = this.categoryKeys.get(cat);
      if (!ks) { ks = new Set(); this.categoryKeys.set(cat, ks); }
      ks.add(key);
    }
  }

  private getCategory(key: string): string {
    for (const prefix of this.categoryPrefixes) {
      if (key.startsWith(prefix)) return prefix;
    }
    return 'default';
  }

  private getCategoryLimit(cat: string): CategoryLimit {
    return this.opts.categories[cat] ?? this.opts.categories['default'] ?? { maxEntries: 500, maxSizeBytes: 50 * 1024 * 1024 };
  }

  private _delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    const cat = this.getCategory(key);
    this.totalSize -= entry.size;
    this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 1) - 1);
    this.categorySize.set(cat, (this.categorySize.get(cat) ?? entry.size) - entry.size);
    this.categoryKeys.get(cat)?.delete(key);
    this._bloomDirtyCount++;
    return this.cache.delete(key);
  }

  private ensureCapacity(category: string, neededSize: number): void {
    const lim    = this.getCategoryLimit(category);
    const catCnt = this.categoryCount.get(category) ?? 0;
    const catSz  = this.categorySize.get(category)  ?? 0;
    const catOvf = catCnt >= lim.maxEntries || catSz + neededSize > lim.maxSizeBytes;
    const glbOvf = this.cache.size >= this.opts.maxEntries || this.totalSize + neededSize > this.opts.maxBytes;
    if (!catOvf && !glbOvf) return;
    this.smartEvict(category, catOvf);
  }

  private score(entry: SmartCacheEntry, catBonus: number, now: number): number {
    const age  = now - entry.lastAccess;
    const ttl  = Math.max(0, entry.expiresAt - now);
    const freq = Math.min(entry.hits, 100);
    return entry.priority * 1000 + freq * 10 + ttl / 60000 - age / 60000 - catBonus;
  }

  /**
   * Rebuild the bloom filter when phantom bits from deleted/expired keys have
   * saturated the filter past its ~1 % FP capacity.
   *
   * Trigger: (insertions − live entries) > maxCapacity
   *
   * Using the phantom count (insertions − cache.size) instead of raw insertions
   * prevents an O(cache.size) rebuild from re-firing on every set() when the
   * cache holds more entries than the filter's rated capacity — which would
   * stall the write path entirely.
   *
   * After rebuild: insertions = cache.size → phantoms = 0 → no immediate re-trigger.
   */
  private maybeRebuildBloom(): void {
    // Two independent triggers — whichever fires first:
    //   1. Phantom count (insertions of dead keys since last rebuild)
    //   2. Deletion count (ANY _delete() call — expiry, eviction, or explicit)
    // Trigger 2 uses maxCapacity>>>2 (~4500) so eviction/expiry cycling doesn't
    // accumulate stale bits for thousands of ops before trigger 1 fires.
    if (this._bloomDirtyCount > (this.bloom.maxCapacity >>> 2) ||
        this.bloom.insertions - this.cache.size > this.bloom.maxCapacity) {
      this.bloom.rebuild(this.cache.keys());
      this._bloomDirtyCount = 0;
    }
  }

  private smartEvict(targetCat: string, catOvf: boolean): void {
    const now    = Date.now();
    const SAMPLE = 16; // Redis-style sample window
    const EVICT  = Math.max(1, Math.ceil(SAMPLE * EVICTION_BATCH_PERCENT)); // ~4

    const pool: Array<{ key: string; score: number }> = [];

    if (catOvf) {
      // Phase 1 — O(catSize) category-local reservoir sample.
      // Uses the categoryKeys index to iterate only the overflowing category's keys,
      // avoiding an O(N) scan of the entire cache. Guarantees at least
      // min(catSize, EVICT) entries from the overflowing category in the pool so
      // the priority score ordering is always deterministic in practice.
      const catKeySet = this.categoryKeys.get(targetCat);
      if (catKeySet) {
        let catSeen = 0;
        for (const key of catKeySet) {
          const entry = this.cache.get(key);
          if (!entry || (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now)) continue;
          catSeen++;
          const s = this.score(entry, 100, now);
          if (pool.length < EVICT) {
            pool.push({ key, score: s });
          } else {
            const j = Math.floor(Math.random() * catSeen);
            if (j < EVICT) pool[j] = { key, score: s };
          }
        }
      }
    }

    // Phase 2 — global reservoir sample fills remaining SAMPLE-pool.length slots.
    // Skipped entirely when Phase 1 already collected a full EVICT-sized pool
    // (the common catOvf case — overflowing categories always have ≥ EVICT entries).
    // Also the sole phase when !catOvf (global over-capacity, no preferred category).
    if (pool.length < EVICT) {
      const remaining = SAMPLE - pool.length;
      let globalSeen  = 0;
      const globalPool: Array<{ key: string; score: number }> = [];
      for (const [key, entry] of this.cache) {
        if (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now) continue;
        if (catOvf && this.getCategory(key) === targetCat) continue; // already sampled above
        globalSeen++;
        const s = this.score(entry, 0, now);
        if (globalPool.length < remaining) {
          globalPool.push({ key, score: s });
        } else {
          const j = Math.floor(Math.random() * globalSeen);
          if (j < remaining) globalPool[j] = { key, score: s };
        }
      }
      pool.push(...globalPool);
    }

    if (pool.length === 0) return;

    // Sort only the tiny merged pool (O(SAMPLE * log(SAMPLE)) ≈ 64 comparisons)
    pool.sort((a, b) => a.score - b.score);
    for (const { key } of pool.slice(0, EVICT)) {
      const entry = this.cache.get(key);
      if (entry && this.opts.diskSpill) this.opts.diskSpill(key, entry); // L1.5 spill
      this._delete(key);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get(key: string): CacheHit | null {
    this.bloomChecks++;
    if (!this.bloom.mightContain(key)) return null;
    const entry = this.cache.get(key);
    if (!entry) { this.bloomFalsePos++; return null; }
    const now = Date.now();
    if (entry.expiresAt < now) { this._delete(key); return null; }
    entry.hits++;
    entry.lastAccess = now;
    const value = unpack(entry.data as Buffer);
    const isStale = entry.staleAt !== undefined && now > entry.staleAt;
    return { value, isStale };
  }

  set(
    key: string,
    data: unknown,
    ttlMs: number,
    priority: CachePriority = 2 /* NORMAL */,
    staleAt?: number,
  ): void {
    // Single serialization pass — always msgpackr. Eliminates the prior JSON.stringify
    // "size probe" that was discarded for large payloads (the double-pass).
    const packed = pack(data);
    const size   = packed.byteLength;
    this.compressions++;

    const cat = this.getCategory(key);
    const lim = this.getCategoryLimit(cat);

    if (size > lim.maxSizeBytes * 0.5) {
      this.opts.logger.debug('SmartMemoryCache: entry too large, skipping', { key, sizeBytes: size });
      return;
    }

    // Single Map.get replaces Map.has + _delete's Map.get (saves one lookup on overwrite).
    const existingEntry = this.cache.get(key);
    if (existingEntry) {
      this.totalSize -= existingEntry.size;
      this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 1) - 1);
      this.categorySize.set(cat, (this.categorySize.get(cat) ?? existingEntry.size) - existingEntry.size);
      this.cache.delete(key);
    }
    this.ensureCapacity(cat, size);

    const now = Date.now();
    this.cache.set(key, { data: packed, isCompressed: true, expiresAt: now + ttlMs, staleAt, size, hits: 1, lastAccess: now, priority });
    this.bloom.add(key);
    this.maybeRebuildBloom();
    this.totalSize += size;
    this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 0) + 1);
    this.categorySize.set(cat,  (this.categorySize.get(cat)  ?? 0) + size);
    let ks = this.categoryKeys.get(cat);
    if (!ks) { ks = new Set(); this.categoryKeys.set(cat, ks); }
    ks.add(key);
  }

  delete(key: string): boolean {
    const deleted = this._delete(key);
    if (deleted) this.maybeRebuildBloom();
    return deleted;
  }

  private keysMatchingPattern(pattern: string): string[] {
    if (!pattern.includes('*')) return this.cache.has(pattern) ? [pattern] : [];
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    const out: string[] = [];
    for (const k of this.cache.keys()) if (re.test(k)) out.push(k);
    return out;
  }

  deletePattern(pattern: string): number {
    let n = 0;
    for (const key of this.keysMatchingPattern(pattern)) if (this._delete(key)) n++;
    if (n > 0) this.maybeRebuildBloom();
    return n;
  }

  /**
   * Forcibly evict the coldest `pct` fraction of non-CRITICAL L1 entries,
   * spilling each to L1.5 disk. Called by the OOM guard when heap pressure
   * exceeds the configured threshold.
   *
   * @param pct - Fraction to evict (0–1), e.g. 0.2 = 20 %
   * @returns   Number of entries evicted
   */
  evictPercentage(pct: number): number {
    if (pct <= 0 || this.cache.size === 0) return 0;
    const now = Date.now();
    const candidates: Array<{ key: string; score: number }> = [];
    for (const [key, entry] of this.cache) {
      if (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now) continue;
      candidates.push({ key, score: this.score(entry, 0, now) });
    }
    candidates.sort((a, b) => a.score - b.score);
    const count = Math.max(1, Math.ceil(candidates.length * pct));
    let evicted = 0;
    for (const { key } of candidates.slice(0, count)) {
      const entry = this.cache.get(key);
      if (entry && this.opts.diskSpill) this.opts.diskSpill(key, entry);
      this._delete(key);
      evicted++;
    }
    return evicted;
  }

  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache) if (entry.expiresAt < now) { this._delete(key); cleaned++; }
    if (cleaned > 0) { this.bloom.rebuild(this.cache.keys()); this._bloomDirtyCount = 0; }
    return cleaned;
  }

  // ── Snapshot import/export ────────────────────────────────────────────────

  exportEntries(forbiddenPrefixes: readonly string[]): Array<{ key: string; entry: SmartCacheEntry }> {
    const now = Date.now();
    const out: Array<{ key: string; entry: SmartCacheEntry }> = [];
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) continue;
      if (entry.priority === 4 /* CRITICAL */) continue;
      if (forbiddenPrefixes.some(p => key.startsWith(p))) continue;
      out.push({ key, entry: { ...entry } });
    }
    return out;
  }

  importEntries(entries: Array<{ key: string; entry: SmartCacheEntry }>, forbiddenPrefixes: readonly string[]): number {
    const now = Date.now();
    let loaded = 0;
    for (const { key, entry } of entries) {
      if (entry.expiresAt <= now) continue;
      if (forbiddenPrefixes.some(p => key.startsWith(p))) continue;
      if (this.cache.has(key)) continue;
      const rawData = entry.data;
      // Handle both legacy (isCompressed=false, data=JSON string) and current (data=Buffer) formats.
      const data: Buffer = !entry.isCompressed
        ? pack(JSON.parse(rawData as unknown as string))  // legacy: re-encode JSON → msgpackr
        : rawData instanceof Uint8Array
          ? Buffer.from(rawData)                          // msgpackr Uint8Array → Buffer
          : rawData as Buffer;                            // already a Buffer
      this.cache.set(key, { ...entry, data, isCompressed: true });
      this.bloom.add(key);
      loaded++;
    }
    this.recalculateStats();
    return loaded;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  get size():        number { return this.cache.size; }
  get memoryUsage(): number { return this.totalSize; }

  getStats() {
    const categories: Record<string, number> = {};
    for (const [cat, cnt] of this.categoryCount) categories[cat] = cnt;
    return {
      entries:  this.cache.size,
      sizeKB:   Math.round(this.totalSize / 1024),
      categories,
      bloom: {
        checks:         this.bloomChecks,
        falsePositives: this.bloomFalsePos,
      },
      compression: {
        compressed:   this.compressions,
        uncompressed: 0,              // all entries are now msgpackr-packed
        bytesSaved:   0,              // no longer tracked (unified format removes the split path)
      },
    };
  }

  bloomMightContain(key: string): boolean { return this.bloom.mightContain(key); }
  bloomStats() { return this.bloom.stats; }
}
