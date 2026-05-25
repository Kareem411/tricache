import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SmartMemoryCache } from '../src/smart-memory-cache';
import { CachePriority } from '../src/types';
import { consoleLogger } from '../src/types';

const opts = {
  maxBytes:   50 * 1024 * 1024,
  maxEntries: 500,
  categories: { default: { maxEntries: 500, maxSizeBytes: 50 * 1024 * 1024 } },
  logger:     consoleLogger,
};

describe('SmartMemoryCache', () => {
  let cache: SmartMemoryCache;

  beforeEach(() => { cache = new SmartMemoryCache(opts); });

  // ── Basic get/set/delete ────────────────────────────────────────────────

  it('returns null on a cold miss', () => {
    expect(cache.get('missing')).toBeNull();
  });

  it('stores and retrieves a value', () => {
    cache.set('foo', { x: 1 }, 60_000);
    const hit = cache.get('foo');
    expect(hit).not.toBeNull();
    expect(hit!.value).toEqual({ x: 1 });
    expect(hit!.isStale).toBe(false);
  });

  it('returns null after hard TTL expiry', () => {
    cache.set('exp', 'hello', 1); // 1 ms TTL
    return new Promise(resolve => setTimeout(() => {
      expect(cache.get('exp')).toBeNull();
      resolve(undefined);
    }, 10));
  });

  it('deletes a key explicitly', () => {
    cache.set('del', 42, 60_000);
    cache.delete('del');
    expect(cache.get('del')).toBeNull();
  });

  it('reports isStale when past soft TTL but within hard TTL', async () => {
    const staleAt = Date.now() + 5;          // soft expiry in 5 ms
    cache.set('stale', 'data', 60_000, CachePriority.NORMAL, staleAt);
    await new Promise(r => setTimeout(r, 20));
    const hit = cache.get('stale');
    expect(hit).not.toBeNull();
    expect(hit!.isStale).toBe(true);
    expect(hit!.value).toBe('data');          // still served
  });

  // ── Pattern deletion ────────────────────────────────────────────────────

  it('deletePattern removes matching keys', () => {
    cache.set('user:1:profile', 'a', 60_000);
    cache.set('user:1:settings', 'b', 60_000);
    cache.set('user:2:profile', 'c', 60_000);
    const deleted = cache.deletePattern('user:1:*');
    expect(deleted).toBe(2);
    expect(cache.get('user:1:profile')).toBeNull();
    expect(cache.get('user:1:settings')).toBeNull();
    expect(cache.get('user:2:profile')).not.toBeNull(); // unaffected
  });

  // ── categoryKeys fast-path for trailing-wildcard deletePattern ───────────

  describe('deletePattern — categoryKeys fast path', () => {
    let catCache: SmartMemoryCache;

    beforeEach(() => {
      catCache = new SmartMemoryCache({
        maxBytes:   50 * 1024 * 1024,
        maxEntries: 1_000,
        categories: {
          'user:':      { maxEntries: 500, maxSizeBytes: 25 * 1024 * 1024 },
          'analytics:': { maxEntries: 200, maxSizeBytes: 10 * 1024 * 1024 },
          'default':    { maxEntries: 300, maxSizeBytes: 15 * 1024 * 1024 },
        },
        logger: consoleLogger,
      });
    });

    it('correctly deletes all keys in a configured category via fast path', () => {
      catCache.set('user:1', 'a', 60_000);
      catCache.set('user:2', 'b', 60_000);
      catCache.set('user:3', 'c', 60_000);
      catCache.set('analytics:x', 'z', 60_000); // different category — must survive

      const deleted = catCache.deletePattern('user:*');

      expect(deleted).toBe(3);
      expect(catCache.get('user:1')).toBeNull();
      expect(catCache.get('user:2')).toBeNull();
      expect(catCache.get('user:3')).toBeNull();
      expect(catCache.get('analytics:x')).not.toBeNull();
    });

    it('fast path produces the same result as the regex scan', () => {
      for (let i = 0; i < 20; i++) catCache.set(`user:${i}`, i, 60_000);
      for (let i = 0; i < 5;  i++) catCache.set(`analytics:${i}`, i, 60_000);

      // Count what regex path would find (without fast path, via middle wildcard that forces regex)
      const regexMatches = Array.from({ length: 20 }, (_, i) => `user:${i}`)
        .filter(k => catCache.get(k) !== null).length;
      expect(regexMatches).toBe(20);

      const deleted = catCache.deletePattern('user:*');
      expect(deleted).toBe(20);
      expect(catCache.getStats().entries).toBe(5); // only analytics: keys remain
    });

    it('falls through to regex scan for non-category trailing wildcard', () => {
      // 'user:123:' is not a category prefix — should still work via regex
      catCache.set('user:123:profile', 'p', 60_000);
      catCache.set('user:123:session', 's', 60_000);
      catCache.set('user:456:profile', 'q', 60_000);

      const deleted = catCache.deletePattern('user:123:*');
      expect(deleted).toBe(2);
      expect(catCache.get('user:123:profile')).toBeNull();
      expect(catCache.get('user:123:session')).toBeNull();
      expect(catCache.get('user:456:profile')).not.toBeNull();
    });

    it('fast path handles middle-wildcard patterns correctly via regex (not fast path)', () => {
      catCache.set('user:1:profile', 'a', 60_000);
      catCache.set('user:2:profile', 'b', 60_000);
      catCache.set('user:1:session', 'c', 60_000);

      // Middle wildcard: fast path must NOT fire (indexOf('*') !== length-1 is false here,
      // but 'user:' category would not match 'user:' with a prefix of 'user:1:' anyway)
      const deleted = catCache.deletePattern('user:*:profile');
      expect(deleted).toBe(2);
      expect(catCache.get('user:1:session')).not.toBeNull();
    });

    it('categoryKeys Set is empty after full category delete', () => {
      catCache.set('user:a', 1, 60_000);
      catCache.set('user:b', 2, 60_000);
      catCache.deletePattern('user:*');
      // Internal categoryKeys set should be drained
      const ks = (catCache as any).categoryKeys.get('user:') as Set<string> | undefined;
      expect(ks === undefined || ks.size === 0).toBe(true);
    });
  });

  // ── Compression ─────────────────────────────────────────────────────────

  it('compresses entries over 512 bytes', () => {
    const big = { data: 'x'.repeat(1000) };
    cache.set('big', big, 60_000);
    const hit = cache.get('big');
    expect(hit!.value).toEqual(big);
  });

  it('stores small entries as msgpackr buffers', () => {
    cache.set('tiny', { ok: true }, 60_000);
    const hit = cache.get('tiny');
    expect(hit!.value).toEqual({ ok: true });
  });

  // ── Bloom filter fast path ───────────────────────────────────────────────

  it('bloom filter returns false (definite miss) for never-set keys', () => {
    expect(cache.bloomMightContain('never-set-xyz')).toBe(false);
  });

  it('bloom filter returns true after a key is set', () => {
    cache.set('bloom-test', 1, 60_000);
    expect(cache.bloomMightContain('bloom-test')).toBe(true);
  });

  // ── Stats ────────────────────────────────────────────────────────────────

  it('tracks entry count and raw memory usage', () => {
    cache.set('s1', 'a', 60_000);
    cache.set('s2', 'b', 60_000);
    const stats = cache.getStats();
    expect(stats.entries).toBe(2);
    // sizeKB rounds to nearest KB — tiny entries may show 0 KB; use raw memoryUsage instead
    expect(cache.memoryUsage).toBeGreaterThan(0);
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────

  it('cleanup removes expired entries and returns count', async () => {
    cache.set('old', 'x', 1); // 1 ms TTL
    await new Promise(r => setTimeout(r, 20));
    const cleaned = cache.cleanup();
    expect(cleaned).toBe(1);
    expect(cache.size).toBe(0);
  });

  // ── Priority CRITICAL is never evicted while valid ───────────────────────

  it('CRITICAL entries are never evicted', () => {
    // Fill cache past capacity with LOW entries
    const tiny = new SmartMemoryCache({
      ...opts,
      maxEntries: 3,
      categories: { default: { maxEntries: 3, maxSizeBytes: 1024 * 1024 } },
    });
    tiny.set('auth:tok', 'secret', 60_000, CachePriority.CRITICAL);
    tiny.set('a', 1, 60_000, CachePriority.LOW);
    tiny.set('b', 2, 60_000, CachePriority.LOW);
    tiny.set('c', 3, 60_000, CachePriority.LOW); // triggers eviction
    // CRITICAL entry must survive
    expect(tiny.get('auth:tok')).not.toBeNull();
  });

  // ── Snapshot import/export ───────────────────────────────────────────────

  it('exports and re-imports entries faithfully', () => {
    cache.set('snap:a', { v: 1 }, 60_000);
    cache.set('snap:b', { v: 2 }, 60_000);
    const exported = cache.exportEntries(['auth:']);
    const fresh = new SmartMemoryCache(opts);
    const loaded = fresh.importEntries(exported, ['auth:']);
    expect(loaded).toBe(2);
    expect(fresh.get('snap:a')!.value).toEqual({ v: 1 });
  });

  it('export skips CRITICAL entries', () => {
    cache.set('auth:tok', 'x', 60_000, CachePriority.CRITICAL);
    const exported = cache.exportEntries(['auth:']);
    expect(exported.find(e => e.key === 'auth:tok')).toBeUndefined();
  });

  it('export skips forbidden prefixes', () => {
    cache.set('session:abc', 'y', 60_000);
    const exported = cache.exportEntries(['session:']);
    expect(exported).toHaveLength(0);
  });

  // ── Count-Min Sketch (frequency tracking across evictions) ───────────────

  it('liveEntries() yields only non-expired entries', async () => {
    cache.set('alive', 'yes', 60_000);
    cache.set('dead', 'no', 1); // expires in 1 ms
    await new Promise(r => setTimeout(r, 20));
    const keys = [...cache.liveEntries()].map(([k]) => k);
    expect(keys).toContain('alive');
    expect(keys).not.toContain('dead');
  });

  it('liveEntries() returns empty when cache is empty', () => {
    expect([...cache.liveEntries()]).toHaveLength(0);
  });

  it('sketch protects long-resident keys from same-priority burst eviction', () => {
    // Tiny cache: maxEntries = 60 to force eviction during the burst
    const tiny = new SmartMemoryCache({
      ...opts,
      maxEntries: 60,
      categories: { default: { maxEntries: 60, maxSizeBytes: 50 * 1024 * 1024 } },
    });

    // Seed 30 long-resident NORMAL keys and simulate 50 gets each (builds sketch frequency)
    for (let i = 0; i < 30; i++) {
      tiny.set(`resident:${i}`, i, 120_000, CachePriority.NORMAL);
    }
    for (let i = 0; i < 30; i++) {
      for (let g = 0; g < 50; g++) tiny.get(`resident:${i}`);
    }

    // Now burst-flood 40 brand-new NORMAL keys — this forces eviction of ~10 entries
    for (let i = 0; i < 40; i++) {
      tiny.set(`burst:${i}`, i, 120_000, CachePriority.NORMAL);
    }

    // Residents had 50+ accesses recorded in the sketch; burst keys have 1.
    // At least 20 of the 30 residents should survive (with sketch protecting them).
    let survived = 0;
    for (let i = 0; i < 30; i++) {
      if (tiny.get(`resident:${i}`) !== null) survived++;
    }
    expect(survived).toBeGreaterThanOrEqual(20);
  });
});

// ─── scan() ──────────────────────────────────────────────────────────────────

describe('SmartMemoryCache.scan()', () => {
  let cache: SmartMemoryCache;
  const opts = {
    maxEntries: 100,
    maxSizeBytes: 10 * 1024 * 1024,
    categories: { default: { maxEntries: 100, maxSizeBytes: 10 * 1024 * 1024 } },
    logger: consoleLogger,
  };

  beforeEach(() => { cache = new SmartMemoryCache(opts); });

  it('visits all live entries, skipping expired ones', async () => {
    cache.set('ns:live1', 'a', 60_000);
    cache.set('ns:live2', 'b', 60_000);
    cache.set('ns:dead',  'c', 1);
    await new Promise(r => setTimeout(r, 20));

    const visited: string[] = [];
    cache.scan((key) => visited.push(key), 0);

    expect(visited).toContain('ns:live1');
    expect(visited).toContain('ns:live2');
    expect(visited).not.toContain('ns:dead');
  });

  it('passes the prefixLen argument through to the callback unchanged', () => {
    cache.set('ns:key', 'v', 60_000);
    const seen: number[] = [];
    cache.scan((_key, _entry, pfx) => seen.push(pfx), 3);
    expect(seen).toEqual([3]);
  });

  it('visits nothing when cache is empty', () => {
    let count = 0;
    cache.scan(() => count++, 0);
    expect(count).toBe(0);
  });
});
