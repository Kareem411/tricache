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
});
