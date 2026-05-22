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

// ─── Constants ────────────────────────────────────────────────────────────────

/** Byte threshold above which entries are msgpackr-compressed */
export const COMPRESSION_THRESHOLD_BYTES = 512;

/** Fraction of candidates evicted in one pass when a limit is exceeded */
const EVICTION_BATCH_PERCENT = 0.2;

// ─── Pure-JS Bloom filter fallback ───────────────────────────────────────────

class JsBloomFilter {
  private bits: Buffer;
  private readonly numBits: number;
  private readonly k: number;

  constructor(numBits = 100_000, k = 7) {
    this.numBits = numBits;
    this.k = k;
    this.bits = Buffer.alloc(Math.ceil(numBits / 8), 0);
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
  }

  mightContain(key: string): boolean {
    const h1 = this.fnv1a32(key), h2 = this.djb2(key);
    for (let i = 0; i < this.k; i++) if (!this.getBit(((h1 + i * h2) >>> 0) % this.numBits)) return false;
    return true;
  }

  reset()                          { this.bits.fill(0); }
  rebuild(keys: Iterable<string>)  { this.bits.fill(0); for (const k of keys) this.add(k); }

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
  private readonly cache    = new Map<string, SmartCacheEntry>();
  private readonly opts:    SmartMemoryCacheOptions;
  private bloom:            AnyBloomFilter;
  private totalSize         = 0;
  private categoryCount     = new Map<string, number>();
  private categorySize      = new Map<string, number>();

  // ── Observability counters ──────────────────────────────────────────────────────
  private bloomChecks           = 0;
  private bloomFalsePos         = 0;
  private compressions          = 0;
  private uncompressedEntries   = 0;
  private compressionBytesSaved = 0;

  constructor(opts: SmartMemoryCacheOptions, existing?: Map<string, SmartCacheEntry>) {
    this.opts  = opts;
    this.bloom = createBloomFilter(opts.logger);

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
    for (const [key, entry] of this.cache) {
      this.totalSize += entry.size;
      const cat = this.getCategory(key);
      this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 0) + 1);
      this.categorySize.set(cat, (this.categorySize.get(cat) ?? 0) + entry.size);
    }
  }

  private getCategory(key: string): string {
    for (const prefix of Object.keys(this.opts.categories)) {
      if (prefix !== 'default' && key.startsWith(prefix)) return prefix;
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

  private smartEvict(targetCat: string, catOvf: boolean): void {
    const now = Date.now();
    const candidates: Array<{ key: string; score: number }> = [];
    for (const [key, entry] of this.cache) {
      if (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now) continue;
      const cat   = this.getCategory(key);
      const bonus = catOvf && cat === targetCat ? 100 : 0;
      candidates.push({ key, score: this.score(entry, bonus, now) });
    }
    candidates.sort((a, b) => a.score - b.score);
    const evictCount = Math.max(1, Math.floor(candidates.length * EVICTION_BATCH_PERCENT));
    let evicted = 0;
    for (const { key } of candidates.slice(0, evictCount)) {
      const entry = this.cache.get(key);
      if (entry && this.opts.diskSpill) this.opts.diskSpill(key, entry); // L1.5 spill
      this._delete(key);
      evicted++;
    }
    this.opts.logger.debug('SmartMemoryCache: eviction', {
      evicted, reason: catOvf ? 'category' : 'global', targetCat,
      remaining: this.cache.size, sizeKB: Math.round(this.totalSize / 1024),
    });
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get(key: string): CacheHit | null {
    this.bloomChecks++;
    if (!this.bloom.mightContain(key)) return null;
    const entry = this.cache.get(key);
    if (!entry) { this.bloomFalsePos++; return null; }
    if (entry.expiresAt < Date.now()) { this._delete(key); return null; }
    entry.hits++;
    entry.lastAccess = Date.now();
    const value = entry.isCompressed ? unpack(entry.data as Buffer) : JSON.parse(entry.data as string);
    const isStale = entry.staleAt !== undefined && Date.now() > entry.staleAt;
    return { value, isStale };
  }

  set(
    key: string,
    data: unknown,
    ttlMs: number,
    opts: { priority?: CachePriority; staleAt?: number } = {},
  ): void {
    const { priority = 2 /* NORMAL */, staleAt } = opts;
    const jsonStr       = JSON.stringify(data);
    const estimatedBytes = Buffer.byteLength(jsonStr, 'utf8');

    let entryData: string | Buffer;
    let size: number;
    let isCompressed: boolean;

    if (estimatedBytes >= COMPRESSION_THRESHOLD_BYTES) {
      const packed = pack(data);
      size          = Buffer.byteLength(packed);
      entryData     = packed;
      isCompressed  = true;
      this.compressions++;
      this.compressionBytesSaved += Math.max(0, estimatedBytes - size);
    } else {
      size         = estimatedBytes;
      entryData    = jsonStr;
      isCompressed = false;
      this.uncompressedEntries++;
    }

    const cat = this.getCategory(key);
    const lim = this.getCategoryLimit(cat);

    if (size > lim.maxSizeBytes * 0.5) {
      this.opts.logger.debug('SmartMemoryCache: entry too large, skipping', { key, sizeBytes: size });
      return;
    }

    if (this.cache.has(key)) this._delete(key);
    this.ensureCapacity(cat, size);

    this.cache.set(key, { data: entryData, isCompressed, expiresAt: Date.now() + ttlMs, staleAt, size, hits: 1, lastAccess: Date.now(), priority });
    this.bloom.add(key);
    this.totalSize += size;
    this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 0) + 1);
    this.categorySize.set(cat,  (this.categorySize.get(cat)  ?? 0) + size);
  }

  delete(key: string): boolean { return this._delete(key); }

  private keysMatchingPattern(pattern: string): string[] {
    if (!pattern.includes('*')) return this.cache.has(pattern) ? [pattern] : [];
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...this.cache.keys()].filter(k => re.test(k));
  }

  deletePattern(pattern: string): number {
    let n = 0;
    for (const key of this.keysMatchingPattern(pattern)) if (this._delete(key)) n++;
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
    if (cleaned > 0) this.bloom.rebuild(this.cache.keys());
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
      const data: string | Buffer = entry.isCompressed && entry.data instanceof Uint8Array
        ? Buffer.from(entry.data)
        : entry.data as string | Buffer;
      this.cache.set(key, { ...entry, data });
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
        uncompressed: this.uncompressedEntries,
        bytesSaved:   this.compressionBytesSaved,
      },
    };
  }

  bloomMightContain(key: string): boolean { return this.bloom.mightContain(key); }
  bloomStats() { return this.bloom.stats; }
}
