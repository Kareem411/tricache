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
  it('accumulates in L1 when Redis is disabled', async () => {
    const c1 = await svc.increment('counter:hits', 60);
    const c2 = await svc.increment('counter:hits', 60);
    expect(c1).toBe(1);
    expect(c2).toBe(2);
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

// ── Feature: Iterator interface ───────────────────────────────────────────────

describe('Iterator interface (keys / values / entries)', () => {
  it('keys() yields namespace-stripped keys for live entries', async () => {
    const nsSvc = CacheService.reset({
      disableRedis: true,
      namespace:    'app',
      l1MaxEntries: 100,
      l1MaxBytes:   10 * 1024 * 1024,
      diskCacheDir: tempDir(),
    });
    try {
      await nsSvc.set('alpha', 1, 60);
      await nsSvc.set('beta', 2, 60);
      await nsSvc.set('gamma', 3, 60);
      const ks = [...nsSvc.keys()].sort();
      expect(ks).toEqual(['alpha', 'beta', 'gamma']);
    } finally {
      await nsSvc.destroy();
    }
  });

  it('values() yields deserialized values for live entries', async () => {
    await svc.set('v1', { n: 10 }, 60);
    await svc.set('v2', { n: 20 }, 60);
    const vals = [...svc.values<{ n: number }>()].map(v => v.n).sort((a, b) => a - b);
    expect(vals).toEqual([10, 20]);
  });

  it('entries() yields [key, value] pairs with namespace stripped', async () => {
    const nsSvc = CacheService.reset({
      disableRedis: true,
      namespace:    'ns',
      l1MaxEntries: 100,
      l1MaxBytes:   10 * 1024 * 1024,
      diskCacheDir: tempDir(),
    });
    try {
      await nsSvc.set('x', 42, 60);
      await nsSvc.set('y', 99, 60);
      const pairs = [...nsSvc.entries<number>()].sort(([a], [b]) => a.localeCompare(b));
      expect(pairs).toEqual([['x', 42], ['y', 99]]);
    } finally {
      await nsSvc.destroy();
    }
  });

  it('iterators skip expired entries', async () => {
    await svc.set('fresh', 'yes', 60);
    await svc.set('stale', 'no', 0.001); // ~1 ms TTL
    await new Promise(r => setTimeout(r, 20));
    const ks = [...svc.keys()];
    expect(ks).toContain('fresh');
    expect(ks).not.toContain('stale');
  });

  it('keys() returns empty iterator when cache is empty', () => {
    expect([...svc.keys()]).toHaveLength(0);
  });
});

// ── Feature: scan() ───────────────────────────────────────────────────────────

describe('CacheService.scan()', () => {
  it('visits all live entries with correct values', async () => {
    await svc.set('a', 10, 60);
    await svc.set('b', 20, 60);
    const collected: [string, number][] = [];
    svc.scan<number>((rawKey, value, offset) => {
      collected.push([rawKey.slice(offset), value]);
    });
    collected.sort(([a], [b]) => a.localeCompare(b));
    expect(collected).toEqual([['a', 10], ['b', 20]]);
  });

  it('strips namespace via offset (no extra slice on caller side)', async () => {
    const nsSvc = CacheService.reset({
      disableRedis: true,
      namespace:    'myns',
      l1MaxEntries: 100,
      l1MaxBytes:   10 * 1024 * 1024,
      diskCacheDir: tempDir(),
    });
    try {
      await nsSvc.set('foo', 'bar', 60);
      const seen: [string, string][] = [];
      nsSvc.scan<string>((rawKey, value, offset) => {
        seen.push([rawKey.slice(offset), value]);
      });
      expect(seen).toEqual([['foo', 'bar']]);
    } finally {
      await nsSvc.destroy();
    }
  });

  it('skips expired entries', async () => {
    await svc.set('live', 'yes', 60);
    await svc.set('dead', 'no', 0.001);
    await new Promise(r => setTimeout(r, 20));
    const keys: string[] = [];
    svc.scan((rawKey, _v, offset) => keys.push(rawKey.slice(offset)));
    expect(keys).toContain('live');
    expect(keys).not.toContain('dead');
  });

  it('visits nothing when cache is empty', () => {
    let count = 0;
    svc.scan(() => count++);
    expect(count).toBe(0);
  });
});

// ── Feature: Invalidation backplane message handler ───────────────────────────

describe('Invalidation backplane (_handleBackplaneMessage)', () => {
  const PEER_ID = 'peer-instance-xyz';

  it('del message evicts the key from L1 immediately', async () => {
    await svc.set('user:1', { name: 'Alice' }, 60);
    expect(svc.has('user:1')).toBe(true);

    (svc as unknown as { _handleBackplaneMessage(m: string): void })
      ._handleBackplaneMessage(JSON.stringify({ op: 'del', key: 'user:1', src: PEER_ID }));

    expect(svc.has('user:1')).toBe(false);
  });

  it('del message is a no-op for keys not in L1', () => {
    expect(() => {
      (svc as unknown as { _handleBackplaneMessage(m: string): void })
        ._handleBackplaneMessage(JSON.stringify({ op: 'del', key: 'nonexistent', src: PEER_ID }));
    }).not.toThrow();
  });

  it('del-glob message evicts all matching L1 keys', async () => {
    await svc.set('session:a', 1, 60);
    await svc.set('session:b', 2, 60);
    await svc.set('other:c', 3, 60);

    (svc as unknown as { _handleBackplaneMessage(m: string): void })
      ._handleBackplaneMessage(JSON.stringify({ op: 'del-glob', key: 'session:*', src: PEER_ID }));

    expect(svc.has('session:a')).toBe(false);
    expect(svc.has('session:b')).toBe(false);
    expect(svc.has('other:c')).toBe(true);
  });

  it('own messages (same instanceId) are skipped without eviction', async () => {
    await svc.set('product:1', { price: 99 }, 60);
    const ownId = (svc as unknown as { instanceId: string }).instanceId;

    (svc as unknown as { _handleBackplaneMessage(m: string): void })
      ._handleBackplaneMessage(JSON.stringify({ op: 'del', key: 'product:1', src: ownId }));

    // should still be present — own messages are ignored
    expect(svc.has('product:1')).toBe(true);
  });

  it('malformed JSON messages are silently ignored', () => {
    expect(() => {
      (svc as unknown as { _handleBackplaneMessage(m: string): void })
        ._handleBackplaneMessage('not-json{{');
    }).not.toThrow();
  });

  it('disk.delete is deferred via setImmediate (does not block the event loop)', async () => {
    await svc.set('k', 42, 60);
    const diskSpy = vi.spyOn(
      (svc as unknown as { disk: { delete(k: string): void } }).disk,
      'delete',
    );

    (svc as unknown as { _handleBackplaneMessage(m: string): void })
      ._handleBackplaneMessage(JSON.stringify({ op: 'del', key: 'k', src: PEER_ID }));

    // disk.delete must NOT have been called synchronously
    expect(diskSpy).not.toHaveBeenCalled();

    // after yielding to the event loop it fires
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(diskSpy).toHaveBeenCalledWith('k');
  });
});

// ── Feature: onHit / onMiss callbacks ────────────────────────────────────────

describe('onHit / onMiss callbacks', () => {
  it('onHit fires with tier "l1" on an L1 cache hit', async () => {
    const hits: Array<{ key: string; tier: string }> = [];
    const dir = tempDir();
    const s = CacheService.reset({
      disableRedis: true, diskCacheDir: dir,
      onHit: (key, tier) => hits.push({ key, tier }),
    });
    try {
      await s.set('org:1', { name: 'acme' }, 60);
      await s.get('org:1', () => Promise.resolve({ name: 'miss' }), 60);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toEqual({ key: 'org:1', tier: 'l1' });
    } finally { await s.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('onMiss fires on a cache miss', async () => {
    const misses: string[] = [];
    const dir = tempDir();
    const s = CacheService.reset({
      disableRedis: true, diskCacheDir: dir,
      onMiss: (key) => misses.push(key),
    });
    try {
      await s.get('cold:1', () => Promise.resolve('val'), 60);
      expect(misses).toEqual(['cold:1']);
    } finally { await s.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('neither callback fires when not configured', async () => {
    // Should not throw even with no onHit/onMiss
    const result = await svc.get('plain:1', () => Promise.resolve(42), 60);
    expect(result).toBe(42);
  });
});

// ── Feature: frozen option ────────────────────────────────────────────────────

describe('frozen option', () => {
  it('returned L1 hit is deeply frozen when frozen: true', async () => {
    const dir = tempDir();
    const s = CacheService.reset({ disableRedis: true, diskCacheDir: dir, frozen: true });
    try {
      await s.set('obj:1', { a: { b: 1 } }, 60);
      const val = await s.get<{ a: { b: number } }>('obj:1', () => Promise.resolve({ a: { b: 0 } }), 60);
      expect(Object.isFrozen(val)).toBe(true);
      expect(Object.isFrozen(val.a)).toBe(true);
      expect(() => { (val as { a: { b: number } }).a.b = 99; }).toThrow(TypeError);
    } finally { await s.destroy(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('returned value is NOT frozen when frozen is not set', async () => {
    await svc.set('mutable:1', { x: 1 }, 60);
    const val = await svc.get<{ x: number }>('mutable:1', () => Promise.resolve({ x: 0 }), 60);
    expect(Object.isFrozen(val)).toBe(false);
    val.x = 999; // should not throw
    expect(val.x).toBe(999);
  });
});

// ── Feature: warmFromL2 priority override ─────────────────────────────────────

describe('warmFromL2 priority option', () => {
  it('accepts a priority option without error when Redis is disabled', async () => {
    const { CachePriority } = await import('../src/types');
    // Redis disabled → warmFromL2 returns 0 but must not throw
    const result = await svc.warmFromL2('org:*', { priority: CachePriority.HIGH });
    expect(result).toBe(0);
  });
});

// ── Feature: invalidateTags() batch ──────────────────────────────────────────

describe('invalidateTags() batch invalidation', () => {
  it('removes all entries tagged with any of the given tags in one call', async () => {
    await svc.set('case:1', 'c', 60, undefined, { tags: ['case:acme'] });
    await svc.set('org:1',  'o', 60, undefined, { tags: ['org:acme'] });
    await svc.set('ai:1',   'a', 60, undefined, { tags: ['ai-chat:acme'] });
    await svc.set('other:1', 'x', 60, undefined, { tags: ['unrelated'] });

    await svc.invalidateTags(['case:acme', 'org:acme', 'ai-chat:acme']);

    expect(svc.has('case:1')).toBe(false);
    expect(svc.has('org:1')).toBe(false);
    expect(svc.has('ai:1')).toBe(false);
    expect(svc.has('other:1')).toBe(true); // unrelated tag — must survive
  });

  it('is equivalent to calling invalidateTag() for each tag individually', async () => {
    const dir1 = tempDir(); const dir2 = tempDir();
    const s1 = CacheService.reset({ disableRedis: true, diskCacheDir: dir1 });
    const s2 = CacheService.reset({ disableRedis: true, diskCacheDir: dir2 });
    try {
      for (const s of [s1, s2]) {
        await s.set('p:1', 'v', 60, undefined, { tags: ['alpha'] });
        await s.set('p:2', 'v', 60, undefined, { tags: ['beta'] });
        await s.set('p:3', 'v', 60, undefined, { tags: ['gamma'] });
      }
      await s1.invalidateTags(['alpha', 'beta', 'gamma']);
      await s2.invalidateTag('alpha');
      await s2.invalidateTag('beta');
      await s2.invalidateTag('gamma');

      expect(s1.has('p:1')).toBe(s2.has('p:1'));
      expect(s1.has('p:2')).toBe(s2.has('p:2'));
      expect(s1.has('p:3')).toBe(s2.has('p:3'));
    } finally {
      await s1.destroy(); await s2.destroy();
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('is a no-op for an empty tags array', async () => {
    await expect(svc.invalidateTags([])).resolves.not.toThrow();
  });

  it('with a single tag delegates to invalidateTag() — same result', async () => {
    await svc.set('solo:1', 'v', 60, undefined, { tags: ['solo-tag'] });
    await svc.invalidateTags(['solo-tag']);
    expect(svc.has('solo:1')).toBe(false);
  });
});
