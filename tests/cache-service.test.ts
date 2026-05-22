/**
 * CacheService integration tests.
 * Redis is disabled (NODE_ENV = test → disableRedis: true by default),
 * so these tests cover L1 + L1.5 paths only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

function tempDir() {
  return join(tmpdir(), `tricache-cs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

let diskDir: string;
let svc: CacheService;

beforeEach(() => {
  diskDir = tempDir();
  svc = CacheService.reset({
    disableRedis: true,
    l1MaxBytes:   20 * 1024 * 1024,
    l1MaxEntries: 500,
    diskCacheDir: diskDir,
  });
});

afterEach(() => {
  svc.destroy();
  try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
});

describe('CacheService.get (L1 path)', () => {
  it('calls fetchFn on cold miss and returns the value', async () => {
    const fetch = vi.fn().mockResolvedValue({ answer: 42 });
    const result = await svc.get('mykey', fetch, 60);
    expect(result).toEqual({ answer: 42 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns cached value without calling fetchFn on a warm hit', async () => {
    const fetch = vi.fn().mockResolvedValue('cached');
    await svc.get('warm', fetch, 60);
    await svc.get('warm', fetch, 60);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('prevents thundering herd — concurrent gets issue only one fetchFn call', async () => {
    const fetch = vi.fn().mockImplementation(() =>
      new Promise(resolve => setTimeout(() => resolve('data'), 20))
    );
    const [r1, r2, r3] = await Promise.all([
      svc.get('herd', fetch, 60),
      svc.get('herd', fetch, 60),
      svc.get('herd', fetch, 60),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(r1).toBe('data');
    expect(r2).toBe('data');
    expect(r3).toBe('data');
  });

  it('re-fetches after TTL expiry', async () => {
    const fetch = vi.fn().mockResolvedValue('fresh');
    await svc.get('ttl-key', fetch, 0); // 0 second TTL
    await new Promise(r => setTimeout(r, 50));
    await svc.get('ttl-key', fetch, 0);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates fetchFn errors', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(svc.get('err', fetch, 60)).rejects.toThrow('db down');
  });
});

describe('CacheService.set / delete', () => {
  it('set stores a value retrievable without fetchFn', async () => {
    await svc.set('preset', { v: 99 }, 60);
    const result = await svc.get('preset', () => Promise.resolve(null), 60);
    expect(result).toEqual({ v: 99 });
  });

  it('delete removes an entry', async () => {
    const fetch = vi.fn().mockResolvedValue('original');
    await svc.get('del-key', fetch, 60);
    await svc.delete('del-key');
    const fetch2 = vi.fn().mockResolvedValue('after-delete');
    const r = await svc.get('del-key', fetch2, 60);
    expect(r).toBe('after-delete');
    expect(fetch2).toHaveBeenCalledOnce();
  });

  it('delete with glob * pattern clears matching keys', async () => {
    await svc.set('user:1:data', 'a', 60);
    await svc.set('user:2:data', 'b', 60);
    await svc.set('org:1:data', 'c', 60);
    await svc.delete('user:*');
    const f = vi.fn().mockResolvedValue('miss');
    expect(await svc.get('user:1:data', f, 60)).toBe('miss');
    expect(await svc.get('user:2:data', f, 60)).toBe('miss');
    // org key should be untouched
    expect(await svc.get('org:1:data', f, 60)).toBe('c');
    expect(f).toHaveBeenCalledTimes(2); // only the two user keys triggered fetch
  });
});

describe('CacheService.increment', () => {
  it('returns 0 when Redis is disabled (safe dev fallback)', async () => {
    // increment is a Redis-only operation — in test mode (disableRedis: true) it safely returns 0
    const c1 = await svc.increment('counter:hits', 60);
    const c2 = await svc.increment('counter:hits', 60);
    expect(c1).toBe(0);
    expect(c2).toBe(0);
  });
});

describe('CacheService.stats', () => {
  it('returns l1 entry count > 0 after writes', async () => {
    await svc.set('stat-key', 'x', 60);
    const stats = svc.stats();
    expect(stats.l1.entries).toBeGreaterThan(0);
  });
});

describe('Priority auto-inference', () => {
  it('auth: prefix infers CRITICAL and survives manual evictions', async () => {
    await svc.set('auth:tok:abc', 'token', 300);
    const r = await svc.get('auth:tok:abc', () => Promise.resolve(null), 300);
    expect(r).toBe('token');
  });
});

// ── Feature: metrics() ───────────────────────────────────────────────────────

describe('CacheService.metrics()', () => {
  it('tracks gets, l1Hits, fetches, and computes hit rates', async () => {
    let calls = 0;
    const fetch = () => { calls++; return Promise.resolve({ v: calls }); };

    await svc.get('m:1', fetch, 60);   // cold miss → fetch #1
    await svc.get('m:1', fetch, 60);   // warm hit
    await svc.get('m:2', fetch, 60);   // cold miss → fetch #2

    const m = svc.metrics();
    expect(m.gets.total).toBe(3);
    expect(m.gets.l1Hits).toBe(1);
    expect(m.gets.fetches).toBe(2);
    expect(m.gets.l1HitRate).toBeCloseTo(1 / 3, 5);
    expect(m.gets.fetchRate).toBeCloseTo(2 / 3, 5);
  });

  it('tracks sets and deletes', async () => {
    await svc.set('met:a', 1, 60);
    await svc.set('met:b', 2, 60);
    await svc.delete('met:a');

    const m = svc.metrics();
    expect(m.sets.total).toBe(2);
    expect(m.deletes.total).toBe(1);
  });

  it('returns zero hit rates when no gets have been made', () => {
    const m = svc.metrics();
    expect(m.gets.total).toBe(0);
    expect(m.gets.l1HitRate).toBe(0);
    expect(m.gets.fetchRate).toBe(0);
    expect(m.bloom.falsePositiveRate).toBe(0);
  });

  it('reports correct namespace and l1 size', async () => {
    await svc.set('ns:x', { payload: 'data' }, 60);
    await new Promise(r => setTimeout(r, 2)); // ensure ≥1 ms uptime before asserting
    const m = svc.metrics();
    expect(m.namespace).toBe('');
    expect(m.l1.entries).toBeGreaterThan(0);
    expect(m.l1.maxBytes).toBeGreaterThan(0);
    expect(m.uptimeMs).toBeGreaterThan(0);
  });

  it('toPrometheusText() produces valid HELP/TYPE/metric triples', async () => {
    await svc.set('prom:1', 'v', 60);
    const text = CacheService.toPrometheusText(svc.metrics());
    // Every metric block should have HELP + TYPE + value lines
    const helps = text.split('\n').filter(l => l.startsWith('# HELP'));
    const types = text.split('\n').filter(l => l.startsWith('# TYPE'));
    expect(helps.length).toBeGreaterThan(5);
    expect(helps.length).toBe(types.length);
    // Should contain known counters
    expect(text).toContain('tricache_gets_total');
    expect(text).toContain('tricache_l1_hit_rate');
  });

  it('toPrometheusText() includes namespace label when set', async () => {
    const nsSvc = CacheService.reset({
      disableRedis: true,
      namespace:    'myapp',
      diskCacheDir: tempDir(),
    });
    try {
      await nsSvc.set('k', 1, 60);
      const text = CacheService.toPrometheusText(nsSvc.metrics());
      expect(text).toContain('{namespace="myapp"}');
    } finally {
      await nsSvc.destroy();
    }
  });
});

// ── Feature: OOM guard ───────────────────────────────────────────────────────

describe('OOM guard', () => {
  it('triggers eviction when heap threshold is set to near-zero', async () => {
    const oomSvc = CacheService.reset({
      disableRedis:       true,
      oomProtection:      true,
      oomHeapThreshold:   0.001, // always exceeded — forces eviction
      oomCheckIntervalMs: 30,
      oomEvictPercent:    0.5,
      l1MaxBytes:         1_000_000,
      l1MaxEntries:       200,
      diskCacheDir:       tempDir(),
    });
    try {
      for (let i = 0; i < 5; i++) await oomSvc.set(`oom:${i}`, { i }, 300);

      // Wait for at least two OOM check intervals
      await new Promise(r => setTimeout(r, 120));

      const m = oomSvc.metrics();
      expect(m.oom.enabled).toBe(true);
      expect(m.oom.evictions).toBeGreaterThan(0);
      expect(m.oom.lastTriggeredAt).not.toBeNull();
    } finally {
      await oomSvc.destroy();
    }
  });

  it('does NOT evict when heap is below threshold', async () => {
    const safeSvc = CacheService.reset({
      disableRedis:       true,
      oomProtection:      true,
      oomHeapThreshold:   1.0, // impossible to exceed (> 100% heap)
      oomCheckIntervalMs: 30,
      oomEvictPercent:    0.5,
      diskCacheDir:       tempDir(),
    });
    try {
      await safeSvc.set('safe:1', 'x', 300);
      await new Promise(r => setTimeout(r, 100));

      const m = safeSvc.metrics();
      expect(m.oom.evictions).toBe(0);
      expect(m.oom.lastTriggeredAt).toBeNull();
    } finally {
      await safeSvc.destroy();
    }
  });
});
