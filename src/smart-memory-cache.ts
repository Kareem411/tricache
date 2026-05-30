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
import type { CacheHit, CachePriority, CategoryLimit, SmartCacheEntry, ILogger, EvictionReason } from './types';

// Reusable return object for get() — eliminates one heap allocation per hot read.
// Safe because JS is single-threaded: callers consume all fields before the next get().
const _hit: CacheHit = { value: undefined, isStale: false, expiresAt: 0, ttlMs: undefined, delta: undefined, fetchedAt: 0 };

/**
 * Packed-byte threshold above which the live JS object is NOT stored alongside the
 * serialised buffer.  For entries above this size, the double-heap overhead (both the
 * msgpackr Buffer and the deserialized object resident simultaneously) outweighs the
 * latency saved by skipping unpack on read.  Below the threshold the live object is
 * stored so hot reads skip deserialization entirely.
 *
 * 16 KiB is a conservative default: msgpackr unpacks a 16 KiB buffer in ~0.03 ms,
 * while storing the deserialized form of a 16 KiB payload typically costs 32–64 KiB
 * of additional heap depending on object shape.
 */
const LARGE_VALUE_BYTES = 16_384;
import { WasmBloomFilter } from './wasm/bloom-filter-wasm';



/** Fraction of candidates evicted in one pass when a limit is exceeded */
const EVICTION_BATCH_PERCENT = 0.2;
/** Reservoir sample window for smartEvict() — Redis-style. */
const EVICTION_SAMPLE = 16;
/** Number of lowest-scored candidates evicted per smartEvict() call. */
const EVICT_COUNT = Math.max(1, Math.ceil(EVICTION_SAMPLE * EVICTION_BATCH_PERCENT)); // 4

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

/**
 * Return a bloom filter sized for `maxEntries` at a ~1 % false-positive target.
 *
 * The WASM filter is hardcoded at 100 K bits (k = 7), which holds ≈ 10 400 entries
 * at 1 % FP.  For larger caches the filter saturates quickly, producing high FP rates
 * that force wasted Map.get() calls on every definite miss.  When `maxEntries` exceeds
 * the WASM filter's rated capacity, we instantiate a JS filter sized via the optimal
 * formula:  m = ⌈–n · ln p / (ln 2)²⌉  with  k = round(ln 2 · m / n)  clamped to [4, 10].
 */
function createBloomFilter(logger: ILogger, maxEntries: number): AnyBloomFilter {
  // Compute optimal bit-count for p = 1 % and the requested entry ceiling.
  const LN2_SQ       = Math.LN2 * Math.LN2;               // (ln 2)²  ≈ 0.4804
  const optimalBits  = Math.ceil(-maxEntries * Math.log(0.01) / LN2_SQ);
  const optimalK     = Math.max(4, Math.min(10, Math.round(Math.LN2 * optimalBits / maxEntries)));

  try {
    const wasm = new WasmBloomFilter();
    if (wasm.maxCapacity >= maxEntries) {
      logger.debug('SmartMemoryCache: WASM BloomFilter active');
      return wasm;
    }
    // WASM filter is undersized for this cache — fall through to right-sized JS filter.
    logger.debug('SmartMemoryCache: WASM BloomFilter capacity too small, using sized JS BloomFilter', {
      wasmCapacity: wasm.maxCapacity, maxEntries, optimalBits,
    });
  } catch (err) {
    logger.debug('SmartMemoryCache: WASM unavailable — using pure-JS BloomFilter', { reason: (err as Error).message });
  }
  return new JsBloomFilter(optimalBits, optimalK);
}

// ─── Count-Min Sketch ─────────────────────────────────────────────────────────
//
// Estimates historical access frequency across eviction boundaries — a per-entry
// `hits` counter resets to 1 whenever a key is re-admitted after eviction, but
// the sketch remembers the key's frequency in a fixed-size typed array that
// survives evictions. This closes the same-priority burst-flood gap: a key that
// has been accessed 80 times over the last hour but was evicted 5 minutes ago
// will score far above a brand-new burst key whose hits = 1.
//
// Dimensions: 4 rows × 512 counters (Uint16Array) — 4 KB total, fits in L1d.
// Hash: four independent Murmur3-fragment mixes of the key's FNV-1a digest.
// Decay: all counters halved when total insertions cross SKETCH_DECAY_THRESHOLD
//        (frequency-ageing prevents indefinitely growing hot-key counts).

const SKETCH_ROWS  = 4;
const SKETCH_WIDTH = 512;          // must be power of two
const SKETCH_MASK  = SKETCH_WIDTH - 1;
const SKETCH_DECAY_THRESHOLD = 100_000;

class CountMinSketch {
  private readonly table = new Uint16Array(SKETCH_ROWS * SKETCH_WIDTH);
  private inserts = 0;

  /** Inline FNV-1a for a string key → 32-bit unsigned integer. */
  private fnv32(key: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = (Math.imul(h, 0x01000193) >>> 0);
    }
    return h;
  }

  /** Record one access. Decays all counters when the insertion threshold is crossed. */
  increment(key: string): void {
    const h  = this.fnv32(key);
    const h1 = (h  ^ (h  >>> 16)) >>> 0;
    const h2 = (Math.imul(h1, 0x45d9f3b)  ^ (h1 >>> 16)) >>> 0;
    const h3 = (Math.imul(h2, 0x7fb9b7a1) ^ (h2 >>> 16)) >>> 0;
    const h4 = (Math.imul(h3, 0x1b873593) ^ (h3 >>> 16)) >>> 0;
    const t  = this.table;
    const i0 = h1 & SKETCH_MASK;
    const i1 = SKETCH_WIDTH       + (h2 & SKETCH_MASK);
    const i2 = 2 * SKETCH_WIDTH   + (h3 & SKETCH_MASK);
    const i3 = 3 * SKETCH_WIDTH   + (h4 & SKETCH_MASK);
    if (t[i0] < 0xffff) t[i0]++;
    if (t[i1] < 0xffff) t[i1]++;
    if (t[i2] < 0xffff) t[i2]++;
    if (t[i3] < 0xffff) t[i3]++;
    if (++this.inserts >= SKETCH_DECAY_THRESHOLD) this.decay();
  }

  /** Minimum-across-rows frequency estimate. */
  estimate(key: string): number {
    const h  = this.fnv32(key);
    const h1 = (h  ^ (h  >>> 16)) >>> 0;
    const h2 = (Math.imul(h1, 0x45d9f3b)  ^ (h1 >>> 16)) >>> 0;
    const h3 = (Math.imul(h2, 0x7fb9b7a1) ^ (h2 >>> 16)) >>> 0;
    const h4 = (Math.imul(h3, 0x1b873593) ^ (h3 >>> 16)) >>> 0;
    const t  = this.table;
    return Math.min(
      t[h1 & SKETCH_MASK],
      t[SKETCH_WIDTH       + (h2 & SKETCH_MASK)],
      t[2 * SKETCH_WIDTH   + (h3 & SKETCH_MASK)],
      t[3 * SKETCH_WIDTH   + (h4 & SKETCH_MASK)],
    );
  }

  /** Halve all counters — ages out old frequency so bursts don't hold indefinitely. */
  private decay(): void {
    for (let i = 0; i < this.table.length; i++) this.table[i] >>>= 1;
    this.inserts = 0;
  }
}

// ─── Glob matcher ───────────────────────────────────────────────────────────────

/**
 * Pure-string glob matcher — replaces RegExp on the deletePattern hot path.
 * Supports only '*' wildcards (any sequence, including empty).
 * No NFA/DFA state machine, no backtracking.
 *
 * Two-layer design to avoid per-key allocation in the inner loop:
 *   globMatch()      — public entry point; splits the pattern once.
 *   globMatchParts() — hot inner loop; receives the pre-split segments.
 *
 * Algorithm:
 *   1. First segment anchors the prefix  (startsWith, O(|first|)).
 *   2. Last  segment anchors the suffix  (endsWith,   O(|last|)).
 *   3. Middle segments are located left-to-right with indexOf (O(N) total, no re-scan).
 */
function globMatchParts(parts: string[], first: string, last: string, key: string): boolean {
  if (first.length > 0 && !key.startsWith(first)) return false;
  if (last.length  > 0 && !key.endsWith(last))    return false;
  if (first.length + last.length > key.length)     return false; // anchors overlap

  // Walk any middle segments left-to-right — indexOf never backtracks.
  let pos = first.length;
  const end = key.length - last.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (seg.length === 0) continue; // consecutive '*' — skip
    const idx = key.indexOf(seg, pos);
    if (idx === -1 || idx + seg.length > end) return false;
    pos = idx + seg.length;
  }
  return true;
}

function globMatch(pattern: string, key: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === key; // no wildcard — exact match
  return globMatchParts(parts, parts[0], parts[parts.length - 1], key);
}

// ─── SmartMemoryCache ─────────────────────────────────────────────────────────

export interface SmartMemoryCacheOptions {
  maxBytes:          number;
  maxEntries:        number;
  categories:        Record<string, CategoryLimit>;
  diskSpill?:        (key: string, entry: SmartCacheEntry) => void | Promise<void>;
  onEviction?:       (key: string, reason: EvictionReason) => void;
  logger:            ILogger;
  /** Fraction of maxEntries / maxBytes at which proactive eviction fires (default 0.9). */
  evictionWatermark?: number;
}

export class SmartMemoryCache {
  private readonly cache             = new Map<string, SmartCacheEntry>();
  private readonly opts:             SmartMemoryCacheOptions;
  private bloom:                     AnyBloomFilter;
  /** Non-default category prefixes pre-extracted to avoid Object.keys() allocation on every call. */
  private readonly categoryPrefixes: string[];
  /** Historical frequency sketch — survives eviction, closes same-priority burst-flood gap. */
  private readonly sketch = new CountMinSketch();
  private totalSize                  = 0;
  private categoryCount              = new Map<string, number>();
  private categorySize               = new Map<string, number>();
  /** Per-category key sets — enables O(catSize) Phase-1 reservoir sampling without an O(N) scan. */
  private categoryKeys               = new Map<string, Set<string>>();

  // ── Observability counters ──────────────────────────────────────────────────────
  private bloomChecks           = 0;
  private bloomFalsePos         = 0;
  private compressions          = 0;  private categoryHits          = new Map<string, number>();
  /** Counts every _delete() call — used to trigger bloom rebuild from ALL deletion paths. */
  private _bloomDirtyCount      = 0;

  /**
   * Pre-allocated eviction candidate pools — reused across every smartEvict() call to
   * eliminate per-call heap pressure.  Each slot holds a mutable {key, score} record
   * that is overwritten in-place rather than replaced with a new object literal.
   * Safe because JS is single-threaded: smartEvict() completes synchronously before
   * any other code can observe the pool state.
   */
  private readonly _evictPool:  Array<{ key: string; score: number }> =
    Array.from({ length: EVICTION_SAMPLE }, () => ({ key: '', score: 0 }));
  private readonly _evictGPool: Array<{ key: string; score: number }> =
    Array.from({ length: EVICTION_SAMPLE }, () => ({ key: '', score: 0 }));

  constructor(opts: SmartMemoryCacheOptions, existing?: Map<string, SmartCacheEntry>) {
    this.opts             = opts;
    this.bloom            = createBloomFilter(opts.logger, opts.maxEntries);
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

  private _delete(key: string, reason: EvictionReason = 'manual'): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    const cat = this.getCategory(key);
    this.totalSize -= entry.size;
    this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 1) - 1);
    this.categorySize.set(cat, (this.categorySize.get(cat) ?? entry.size) - entry.size);
    this.categoryKeys.get(cat)?.delete(key);
    this._bloomDirtyCount++;
    const deleted = this.cache.delete(key);
    if (deleted && this.opts.onEviction) {
      try { this.opts.onEviction(key, reason); } catch { /* never crash cache */ }
    }
    return deleted;
  }

  private ensureCapacity(category: string, neededSize: number): void {
    const lim    = this.getCategoryLimit(category);
    const catCnt = this.categoryCount.get(category) ?? 0;
    const catSz  = this.categorySize.get(category)  ?? 0;
    const catOvf = catCnt >= lim.maxEntries || catSz + neededSize > lim.maxSizeBytes;
    const glbOvf = this.cache.size >= this.opts.maxEntries || this.totalSize + neededSize > this.opts.maxBytes;
    if (!catOvf && !glbOvf) {
      // Proactive watermark: when either the global entry count OR total byte
      // usage crosses 90 % of its configured ceiling while there is still
      // headroom, run one eviction pass now — during the cheap headroom path —
      // so the hard cliffs at 100 % are rarely reached and writes at full
      // capacity become uncommon. Both dimensions are guarded so that
      // large-payload workloads (where maxBytes is the binding constraint)
      // benefit equally alongside entry-count-bound workloads.
      const wm = this.opts.evictionWatermark ?? 0.9;
      const entryWatermark = this.cache.size      >= Math.floor(this.opts.maxEntries * wm);
      const byteWatermark  = this.totalSize + neededSize >= Math.floor(this.opts.maxBytes  * wm);
      if (entryWatermark || byteWatermark) {
        this.smartEvict(category, false);
      }
      return;
    }
    this.smartEvict(category, catOvf);
  }

  private score(entry: SmartCacheEntry, catBonus: number, now: number, key: string): number {
    const age  = now - entry.lastAccess;
    const ttl  = Math.max(0, entry.expiresAt - now);
    // Use the sketch's cross-eviction frequency estimate when it exceeds the
    // entry's current-tenure hit count — protects long-resident keys that were
    // recently re-admitted (hits reset to 1) from same-priority burst floods.
    const freq = Math.min(Math.max(entry.hits, this.sketch.estimate(key)), 100);
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
    //
    // Dirty-count cap: bloom.maxCapacity grows proportionally with filter size, but
    // we want rebuild frequency to stay proportional to cache ENTRY count, not bit
    // count.  Without the cap a JS filter sized for 50 K entries allows ~12 500 ghost
    // entries before a rebuild — 5× longer than the old WASM filter, which let phantom
    // bits accumulate and raised the measured FP rate.  The cap restores the original
    // rebuild cadence: rebuild after ~5 % of maxEntries are deleted, with a 256 floor.
    const dirtyThreshold = Math.max(256, Math.min(this.bloom.maxCapacity >>> 2, Math.ceil(this.opts.maxEntries * 0.05)));
    if (this._bloomDirtyCount > dirtyThreshold ||
        this.bloom.insertions - this.cache.size > this.bloom.maxCapacity) {
      this.bloom.rebuild(this.cache.keys());
      this._bloomDirtyCount = 0;
    }
  }

  private smartEvict(targetCat: string, catOvf: boolean): void {
    const now    = Date.now();
    const pool   = this._evictPool;
    const gPool  = this._evictGPool;
    let   poolLen = 0;

    if (catOvf) {
      // Phase 1 — O(catSize) category-local reservoir sample.
      // Uses the categoryKeys index to iterate only the overflowing category's keys,
      // avoiding an O(N) scan of the entire cache. Guarantees at least
      // min(catSize, EVICT_COUNT) entries from the overflowing category in the pool so
      // the priority score ordering is always deterministic in practice.
      const catKeySet = this.categoryKeys.get(targetCat);
      if (catKeySet) {
        let catSeen = 0;
        for (const key of catKeySet) {
          const entry = this.cache.get(key);
          if (!entry || (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now)) continue;
          catSeen++;
          const s = this.score(entry, 100, now, key);
          if (poolLen < EVICT_COUNT) {
            pool[poolLen].key = key; pool[poolLen].score = s; poolLen++;
          } else {
            const j = Math.floor(Math.random() * catSeen);
            if (j < EVICT_COUNT) { pool[j].key = key; pool[j].score = s; }
          }
        }
      }
    }

    // Phase 2 — global reservoir sample fills remaining EVICTION_SAMPLE-poolLen slots.
    // Skipped entirely when Phase 1 already collected a full EVICT_COUNT-sized pool
    // (the common catOvf case — overflowing categories always have ≥ EVICT_COUNT entries).
    // Also the sole phase when !catOvf (global over-capacity, no preferred category).
    if (poolLen < EVICT_COUNT) {
      const remaining = EVICTION_SAMPLE - poolLen;
      let globalSeen  = 0;
      let gLen        = 0;
      for (const [key, entry] of this.cache) {
        if (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now) continue;
        if (catOvf && this.getCategory(key) === targetCat) continue; // already sampled above
        globalSeen++;
        const s = this.score(entry, 0, now, key);
        if (gLen < remaining) {
          gPool[gLen].key = key; gPool[gLen].score = s; gLen++;
        } else {
          const j = Math.floor(Math.random() * globalSeen);
          if (j < remaining) { gPool[j].key = key; gPool[j].score = s; }
        }
      }
      // Manual merge — no spread, no new array
      for (let i = 0; i < gLen; i++) {
        pool[poolLen].key = gPool[i].key; pool[poolLen].score = gPool[i].score; poolLen++;
      }
    }

    if (poolLen === 0) return;

    // Insertion sort — O(poolLen²) but poolLen ≤ EVICTION_SAMPLE=16 (max 256 comparisons).
    // Faster than Array.sort() at this scale: no comparator closure call overhead,
    // no timsort startup, no allocation. Sorts in-place within the pre-allocated pool.
    for (let i = 1; i < poolLen; i++) {
      const sk = pool[i].key, ss = pool[i].score;
      let j = i - 1;
      while (j >= 0 && pool[j].score > ss) {
        pool[j + 1].key = pool[j].key; pool[j + 1].score = pool[j].score; j--;
      }
      pool[j + 1].key = sk; pool[j + 1].score = ss;
    }

    const toEvict = Math.min(EVICT_COUNT, poolLen);
    for (let i = 0; i < toEvict; i++) {
      const key   = pool[i].key;
      const entry = this.cache.get(key);
      if (entry && this.opts.diskSpill) this.opts.diskSpill(key, entry); // L1.5 spill
      this._delete(key, 'capacity');
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  get(key: string): CacheHit | null {
    this.bloomChecks++;
    if (!this.bloom.mightContain(key)) return null;
    const entry = this.cache.get(key);
    if (!entry) { this.bloomFalsePos++; return null; }
    const now = Date.now();
    if (entry.expiresAt < now) { this._delete(key, 'ttl'); return null; }
    entry.hits++;
    entry.lastAccess = now;
    // Sample sketch at 25 % — eviction scoring only needs relative frequency, not exact counts.
    if ((entry.hits & 3) === 0) this.sketch.increment(key);
    // value is cached at write time — hot reads return the live object directly,
    // skipping unpack. Falls back to decode for entries restored from disk/snapshot.
    const value = entry.value !== undefined ? entry.value : unpack(entry.data as Buffer);
    _hit.value    = value;
    _hit.isStale  = entry.staleAt !== undefined && now > entry.staleAt;
    _hit.expiresAt = entry.expiresAt;
    _hit.ttlMs    = entry.ttlMs;
    _hit.delta    = entry.delta;
    _hit.fetchedAt = now;
    return _hit;
  }

  set(
    key: string,
    data: unknown,
    ttlMs: number,
    priority: CachePriority = 2 /* NORMAL */,
    staleAt?: number,
    delta?: number,
  ): void {
    // Single serialization pass — always msgpackr. Eliminates the prior JSON.stringify
    // "size probe" that was discarded for large payloads (the double-pass).
    const packed = pack(data);
    const size   = packed.byteLength;
    this.compressions++;
    this.sketch.increment(key);

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
    // Only cache the live object for small entries — large entries would store the packed
    // buffer AND a potentially much-larger deserialized object simultaneously (double-heap).
    // For large entries, get() falls back to the unpack() path transparently.
    const liveValue = size <= LARGE_VALUE_BYTES ? data : undefined;
    this.cache.set(key, { data: packed, value: liveValue, isCompressed: true, expiresAt: now + ttlMs, staleAt, size, hits: 1, lastAccess: now, priority, ttlMs, delta, setAt: now });
    // Only add new keys to the bloom — overwrites already have their bits set.
    // Re-adding inflates the insertions counter, delaying trigger-2 phantom detection.
    if (!existingEntry) this.bloom.add(key);
    this.maybeRebuildBloom();
    this.totalSize += size;
    this.categoryCount.set(cat, (this.categoryCount.get(cat) ?? 0) + 1);
    this.categorySize.set(cat,  (this.categorySize.get(cat)  ?? 0) + size);
    let ks = this.categoryKeys.get(cat);
    if (!ks) { ks = new Set(); this.categoryKeys.set(cat, ks); }
    ks.add(key);
  }

  delete(key: string): boolean {
    const deleted = this._delete(key, 'manual');
    if (deleted) this.maybeRebuildBloom();
    return deleted;
  }

  private keysMatchingPattern(pattern: string): string[] {
    if (!pattern.includes('*')) return this.cache.has(pattern) ? [pattern] : [];

    // Fast path: trailing-only wildcard whose prefix exactly matches a configured
    // category (e.g. deletePattern('user:*') when 'user:' is a category).
    // categoryKeys already indexes all live keys per category prefix in O(1),
    // so we skip the O(N) Map scan and regex evaluation entirely.
    // We snapshot via Array.from() before returning so _delete() mutations to
    // the Set during the subsequent iteration are safe.
    if (pattern.endsWith('*') && pattern.indexOf('*') === pattern.length - 1) {
      const prefix = pattern.slice(0, -1);
      const catKeys = this.categoryKeys.get(prefix);
      if (catKeys !== undefined) return Array.from(catKeys);
    }

    // Fast path: exactly one '*' that is NOT at the end (e.g. "user:*:profile").
    // AOT detection lets us avoid globMatchParts dispatch and its empty middle-
    // segment loop — keys only need startsWith + endsWith + length checks inline.
    const firstStar = pattern.indexOf('*');
    if (firstStar === pattern.lastIndexOf('*')) {
      const prefix  = pattern.slice(0, firstStar);
      const suffix  = pattern.slice(firstStar + 1);   // empty when star is last char
      const minLen  = prefix.length + suffix.length;
      const out: string[] = [];
      for (const k of this.cache.keys()) {
        if (k.length >= minLen && k.startsWith(prefix) && k.endsWith(suffix)) out.push(k);
      }
      return out;
    }

    // General case: multiple '*' wildcards — split once, then scan.
    const parts = pattern.split('*');
    const first = parts[0];
    const last  = parts[parts.length - 1];
    const out: string[] = [];
    for (const k of this.cache.keys()) if (globMatchParts(parts, first, last, k)) out.push(k);
    return out;
  }

  deletePattern(pattern: string): number {
    let n = 0;
    for (const key of this.keysMatchingPattern(pattern)) if (this._delete(key, 'manual')) n++;
    if (n > 0) this.maybeRebuildBloom();
    return n;
  }

  /** Flush all entries, or only those whose key starts with `prefix`. */
  clear(prefix?: string): number {
    if (prefix) {
      const pattern = prefix.includes('*') ? prefix : `${prefix}*`;
      return this.deletePattern(pattern);
    }
    const count = this.cache.size;
    this.cache.clear();
    this.totalSize = 0;
    this.categoryCount.clear();
    this.categorySize.clear();
    this.categoryKeys.clear();
    this.categoryHits.clear();
    this.bloom.reset();
    this._bloomDirtyCount = 0;
    return count;
  }

  /**
   * Evict entries that violate current category or global limits.
   * Returns the number of entries evicted.
   */
  rebalance(): number {
    const now = Date.now();
    let evicted = 0;

    for (const [cat, limit] of Object.entries(this.opts.categories)) {
      const catKeys = this.categoryKeys.get(cat);
      if (!catKeys || catKeys.size === 0) continue;

      let catCnt = this.categoryCount.get(cat) ?? 0;
      let catSz  = this.categorySize.get(cat)  ?? 0;
      if (catCnt <= limit.maxEntries && catSz <= limit.maxSizeBytes) continue;

      const candidates: Array<{ key: string; score: number }> = [];
      for (const key of catKeys) {
        const entry = this.cache.get(key);
        if (!entry) continue;
        if (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > now) continue;
        candidates.push({ key, score: this.score(entry, 0, now, key) });
      }
      candidates.sort((a, b) => a.score - b.score);

      for (const { key } of candidates) {
        catCnt = this.categoryCount.get(cat) ?? 0;
        catSz  = this.categorySize.get(cat)  ?? 0;
        if (catCnt <= limit.maxEntries && catSz <= limit.maxSizeBytes) break;
        const entry = this.cache.get(key);
        if (entry && this.opts.diskSpill) this.opts.diskSpill(key, entry);
        this._delete(key, 'rebalance');
        evicted++;
      }
    }

    // Global limits
    while (this.cache.size > this.opts.maxEntries || this.totalSize > this.opts.maxBytes) {
      const before = this.cache.size;
      this.smartEvict('default', false);
      if (this.cache.size >= before) break; // only CRITICAL entries remain
      evicted += before - this.cache.size;
    }

    if (evicted > 0) this.maybeRebuildBloom();
    return evicted;
  }

  /**
   * Return remaining TTL in seconds for a key in L1, or null if absent/expired.
   * Only reflects L1 state — does not query Redis or disk.
   */
  ttl(key: string): number | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    const remaining = entry.expiresAt - Date.now();
    return remaining > 0 ? Math.ceil(remaining / 1000) : null;
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
      candidates.push({ key, score: this.score(entry, 0, now, key) });
    }
    candidates.sort((a, b) => a.score - b.score);
    const count = Math.max(1, Math.ceil(candidates.length * pct));
    let evicted = 0;
    for (const { key } of candidates.slice(0, count)) {
      const entry = this.cache.get(key);
      if (entry && this.opts.diskSpill) this.opts.diskSpill(key, entry);
      this._delete(key, 'oom');
      evicted++;
    }
    return evicted;
  }

  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache) if (entry.expiresAt < now) { this._delete(key, 'ttl'); cleaned++; }
    if (cleaned > 0) { this.bloom.rebuild(this.cache.keys()); this._bloomDirtyCount = 0; }
    return cleaned;
  }

  /**
   * Evict all non-CRITICAL L1 entries that were written before `cutoffMs`.
   *
   * Called by the backplane staleness fence when the Pub/Sub subscriber
   * reconnects after a disconnect gap that exceeded `backplaneMaxStalenessMs`.
   * Entries written before the disconnect started may have been invalidated by
   * peers while the backplane was down; evicting them forces a controlled
   * cold-start re-fetch from L2 rather than serving silently stale data.
   *
   * Write-time is read from `entry.setAt` (set by `SmartMemoryCache.set()` since v0.7.0).
   * Older snapshot entries without `setAt` fall back to approximating via `expiresAt - ttlMs`;
   * entries with neither field are treated as potentially stale and evicted conservatively.
   *
   * @param cutoffMs - Unix timestamp in milliseconds; entries written before
   *                   this time are evicted.
   * @returns Number of entries evicted.
   */
  evictSetBefore(cutoffMs: number): number {
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      // Never evict live CRITICAL entries — auth tokens, active sessions, etc.
      if (entry.priority === 4 /* CRITICAL */ && entry.expiresAt > Date.now()) continue;

      // Prefer the explicit setAt timestamp; fall back to approximation for older entries.
      const setAt = entry.setAt ?? (entry.ttlMs != null ? entry.expiresAt - entry.ttlMs : 0);

      if (setAt < cutoffMs) {
        this._delete(key, 'manual');
        evicted++;
      }
    }
    if (evicted > 0) {
      this.bloom.rebuild(this.cache.keys());
      this._bloomDirtyCount = 0;
    }
    return evicted;
  }



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
      // Cache the live object for small entries only — large entries skip double-heap storage.
      const value = entry.size <= LARGE_VALUE_BYTES ? unpack(data) : undefined;
      this.cache.set(key, { ...entry, data, value, isCompressed: true });
      this.bloom.add(key);
      loaded++;
    }
    this.recalculateStats();
    return loaded;
  }

  // ── Iterators ─────────────────────────────────────────────────────────────

  /**
   * Lazily yields every [key, entry] pair whose TTL has not yet expired.
   * Expired entries that are still in the Map (awaiting background cleanup)
   * are silently skipped.
   */
  *liveEntries(): Generator<[string, SmartCacheEntry]> {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt > now) yield [key, entry];
    }
  }

  /**
   * Non-generator bulk scan over all live entries.
   *
   * Faster than the generator-based iterators for bulk operations because:
   *  - No generator state-machine overhead (no yield/resume suspend points).
   *  - No per-entry tuple allocation (compare `liveEntries()` which yields `[key, entry]`).
   *  - The same Map call-site is used by a single plain `for` loop instead of being
   *    shared across three competing generator functions, giving V8's IC a cleaner
   *    monomorphic profile for this path.
   *
   * The callback receives the raw (namespaced) key and a `prefixLen` offset so the
   * caller can call `key.slice(prefixLen)` only when it actually needs the stripped
   * key, avoiding the allocation entirely for callers that don't.
   *
   * @param fn        Called once per live entry.
   * @param prefixLen Number of bytes to skip to reach the un-namespaced portion of the key.
   *                  Pass 0 when no namespace is configured.
   */
  scan(fn: (key: string, entry: SmartCacheEntry, prefixLen: number) => void, prefixLen: number): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt > now) fn(key, entry, prefixLen);
    }
  }

  /**
   * Yields only the keys of live entries — no intermediate tuple allocation.
   * Use this instead of liveEntries() when you only need keys.
   */
  *liveKeys(): Generator<string> {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt > now) yield key;
    }
  }

  /**
   * Yields only the resolved values of live entries.
   * Iterates Map.values() so the key is never loaded into the yielded path.
   * Returns the deserialized value — identical semantics to get() but without bloom/hit tracking.
   */
  *liveValues(): Generator<unknown> {
    const now = Date.now();
    for (const entry of this.cache.values()) {
      if (entry.expiresAt > now)
        yield this.resolveValue(entry);
    }
  }

  /**
   * Returns the deserialized value for an entry, unpacking from the msgpackr buffer
   * if the live object was not cached (large-entry optimisation or disk-restored entry).
   */
  resolveValue(entry: SmartCacheEntry): unknown {
    return entry.value !== undefined ? entry.value : unpack(entry.data as Buffer);
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  get size():        number { return this.cache.size; }
  get memoryUsage(): number { return this.totalSize; }

  getStats() {
    const categories: Record<string, { entries: number; hits: number }> = {};
    for (const [cat, cnt] of this.categoryCount) {
      categories[cat] = { entries: cnt, hits: this.categoryHits.get(cat) ?? 0 };
    }
    return {
      entries:   this.cache.size,
      sizeBytes: this.totalSize,
      sizeKB:    Math.round(this.totalSize / 1024),
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

  /**
   * Return the raw cache entry for a key, or `undefined` if absent/expired.
   * Does NOT count as a hit or perform SWR logic.
   */
  getEntry(key: string): SmartCacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) return undefined;
    return entry;
  }

  /**
   * Return true if the key exists in L1 and has not expired.
   * Uses the bloom filter as a fast negative check.
   */
  has(key: string): boolean {
    if (!this.bloom.mightContain(key)) return false;
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this._delete(key, 'ttl');
      return false;
    }
    return true;
  }

  /**
   * Extend the TTL of an existing key. Returns `false` if the key is absent or expired.
   * @param newTtlMs - New TTL from now, in milliseconds.
   */
  touch(key: string, newTtlMs: number): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    const now = Date.now();
    if (entry.expiresAt <= now) { this._delete(key, 'ttl'); return false; }
    entry.expiresAt = now + newTtlMs;
    return true;
  }

  /**
   * Add additional milliseconds to a key's existing expiry (for stale-if-error).
   * Returns `false` if the key is absent or already expired.
   */
  bumpExpiry(key: string, additionalMs: number): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) return false;
    entry.expiresAt += additionalMs;
    return true;
  }

  bloomMightContain(key: string): boolean { return this.bloom.mightContain(key); }
  bloomStats() { return this.bloom.stats; }

  /**
   * Return the top-N live L1 keys by historical access frequency (Count-Min Sketch estimate).
   * Includes evicted-then-readmitted keys whose sketch frequency exceeds their current hit count.
   * Useful for diagnosing which keys are driving cache pressure.
   *
   * @param n - Maximum number of entries to return. Default: 10.
   */
  hotKeys(n: number): Array<{ key: string; hits: number; sizeBytes: number }> {
    const now = Date.now();
    const out: Array<{ key: string; hits: number; sizeBytes: number }> = [];
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) continue;
      out.push({ key, hits: this.sketch.estimate(key), sizeBytes: entry.size });
    }
    out.sort((a, b) => b.hits - a.hits);
    return out.slice(0, n);
  }
}
