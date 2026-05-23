/**
 * v0.4.0 feature tests:
 *   1. Negative caching (notFoundTtl)
 *   2. setIfAbsent()
 *   3. Probabilistic early expiration — XFetch (xfetchBeta)
 *   4. Refresh-ahead scheduling (refreshAhead)
 *   5. hotKeys(n)
 *   6. Dependency-aware invalidation (dependsOn)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service';
import { CachePriority } from '../src/types';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

function tempDir() {
  return join(tmpdir(), `tricache-v040-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeService(extra: Parameters<typeof CacheService.reset>[0] = {}) {
  const diskDir = tempDir();
  const svc = CacheService.reset({
    disableRedis: true,
    l1MaxEntries: 500,
    diskCacheDir: diskDir,
    ...extra,
  });
  return { svc, diskDir };
}

// ─── 1. Negative caching (notFoundTtl) ───────────────────────────────────────

describe('notFoundTtl — negative caching', () => {
  let svc: CacheService;
  let diskDir: string;

  beforeEach(() => ({ svc, diskDir } = makeService()));
  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('caches null result and does not call fetchFn again on repeat get()', async () => {
    let count = 0;
    const fetch = async () => { count++; return null as unknown as string; };

    await svc.get('missing:1', fetch, 60, { notFoundTtl: 5 });
    await svc.get('missing:1', fetch, 60, { notFoundTtl: 5 });
    await svc.get('missing:1', fetch, 60, { notFoundTtl: 5 });

    expect(count).toBe(1);
  });

  it('returns null on cached not-found hit', async () => {
    await svc.get('missing:2', async () => null as unknown as string, 60, { notFoundTtl: 5 });
    const result = await svc.get('missing:2', async () => 'fallback' as string, 60, { notFoundTtl: 5 });
    expect(result).toBeNull();
  });

  it('stores entry with notFoundTtl, not the normal ttlSeconds', async () => {
    await svc.get('missing:3', async () => null as unknown as string, 60, { notFoundTtl: 5 });
    const remaining = svc.ttl('missing:3');
    expect(remaining).not.toBeNull();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5);   // capped at notFoundTtl, not 60
  });

  it('uses normal ttlSeconds when notFoundTtl is 0 (disabled) and result is null', async () => {
    let count = 0;
    // notFoundTtl defaults to 0 → null cached with normal 60s TTL
    await svc.get('missing:4', async () => { count++; return null as unknown as string; }, 60);
    const result = await svc.get('missing:4', async () => { count++; return null as unknown as string; }, 60);
    expect(result).toBeNull();
    expect(count).toBe(1); // still cached, just with 60s TTL
    expect(svc.ttl('missing:4')).toBeGreaterThan(5); // well above 5s
  });

  it('non-null results always use normal ttlSeconds regardless of notFoundTtl', async () => {
    await svc.get('present:1', async () => 'value', 30, { notFoundTtl: 5 });
    const remaining = svc.ttl('present:1');
    expect(remaining).toBeGreaterThan(5); // uses 30s, not 5s
  });

  it('global notFoundTtl config is used when not overridden per-call', async () => {
    const { svc: s, diskDir: d } = makeService({ notFoundTtl: 3 });
    let count = 0;
    await s.get('glob:1', async () => { count++; return null as unknown as string; }, 60);
    const remaining = s.ttl('glob:1');
    expect(remaining).toBeLessThanOrEqual(3);
    const result = await s.get('glob:1', async () => { count++; return 'new'; }, 60);
    expect(result).toBeNull(); // served from cache
    expect(count).toBe(1);
    s.destroy();
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('per-call notFoundTtl overrides global config', async () => {
    const { svc: s, diskDir: d } = makeService({ notFoundTtl: 10 });
    await s.get('glob:2', async () => null as unknown as string, 60, { notFoundTtl: 2 });
    const remaining = s.ttl('glob:2');
    expect(remaining).toBeLessThanOrEqual(2); // per-call wins
    s.destroy();
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  });
});

// ─── 2. setIfAbsent() ────────────────────────────────────────────────────────

describe('setIfAbsent()', () => {
  let svc: CacheService;
  let diskDir: string;

  beforeEach(() => ({ svc, diskDir } = makeService()));
  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('returns true and writes value when key is absent', async () => {
    const wrote = await svc.setIfAbsent('sia:1', 'payload', 60);
    expect(wrote).toBe(true);
    expect(svc.has('sia:1')).toBe(true);
  });

  it('returns false when key already exists in L1', async () => {
    await svc.set('sia:2', 'existing', 60);
    const wrote = await svc.setIfAbsent('sia:2', 'new', 60);
    expect(wrote).toBe(false);
  });

  it('does not overwrite existing value', async () => {
    await svc.set('sia:3', 'original', 60);
    await svc.setIfAbsent('sia:3', 'replacement', 60);
    const val = await svc.get('sia:3', async () => 'fetched', 60);
    expect(val).toBe('original');
  });

  it('second call to setIfAbsent for same key returns false', async () => {
    const first  = await svc.setIfAbsent('sia:4', 'v', 60);
    const second = await svc.setIfAbsent('sia:4', 'v2', 60);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('two distinct absent keys both return true', async () => {
    const a = await svc.setIfAbsent('sia:5a', 'v', 60);
    const b = await svc.setIfAbsent('sia:5b', 'v', 60);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it('stored value is retrievable after a successful setIfAbsent', async () => {
    await svc.setIfAbsent('sia:6', { name: 'Alice' }, 60);
    const val = await svc.get('sia:6', async () => null, 60);
    expect(val).toEqual({ name: 'Alice' });
  });

  it('respects namespace — same logical key in different namespaces never conflicts', async () => {
    const { svc: ns, diskDir: d } = makeService({ namespace: 'ns1' });
    const resultNs  = await ns.setIfAbsent('k:1', 'nsval', 60);
    const resultDef = await svc.setIfAbsent('k:1', 'defval', 60);
    expect(resultNs).toBe(true);
    expect(resultDef).toBe(true); // independent key spaces
    ns.destroy();
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('works with CachePriority parameter', async () => {
    const wrote = await svc.setIfAbsent('sia:prio', 'v', 60, CachePriority.HIGH);
    expect(wrote).toBe(true);
    expect(svc.has('sia:prio')).toBe(true);
  });
});

// ─── 3. XFetch probabilistic early expiration (xfetchBeta) ───────────────────

describe('XFetch probabilistic early expiration (xfetchBeta)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not trigger background recompute when xfetchBeta is not set', async () => {
    const { svc, diskDir } = makeService();
    await svc.set('xf:off', 'v', 60);
    await svc.get('xf:off', async () => 'new', 60); // no xfetchBeta
    expect(svc.metrics().revalidations.total).toBe(0);
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('does not crash when entry has no stored delta (e.g. set() path)', async () => {
    const { svc, diskDir } = makeService();
    await svc.set('xf:nodelta', 'v', 60); // set() stores delta=undefined
    await expect(
      svc.get('xf:nodelta', async () => 'new', 60, { xfetchBeta: 1.0 }),
    ).resolves.toBe('v'); // no throw, no recompute (delta=undefined guard)
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('triggers background recompute when remaining TTL is small relative to fetch cost', async () => {
    const { svc, diskDir } = makeService();
    let fetchCount = 0;

    // First fetch: stores delta (real elapsed ms). Use a small artificial delay
    // so delta is non-zero and the XFetch threshold becomes meaningful.
    await svc.get('xf:live', async () => {
      await new Promise<void>(r => setTimeout(r, 3)); // 3 ms → delta ≈ 3
      fetchCount++;
      return 'v1';
    }, 0.12); // 120 ms TTL

    // Wait until ~80 ms remain so remaining (40 ms) is well within
    // the XFetch threshold at beta=1e6: delta(3) * 1e6 * -log(rand) >> 40 ms
    await new Promise<void>(r => setTimeout(r, 80));

    const val = await svc.get('xf:live', async () => { fetchCount++; return 'v2'; }, 0.12, {
      xfetchBeta: 1e6,
    });

    expect(val).toBe('v1');                                       // still served from cache
    expect(svc.metrics().revalidations.total).toBeGreaterThanOrEqual(1);

    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  }, 500);

  it('does not retrigger on the same key while revalidation is in flight', async () => {
    const { svc, diskDir } = makeService();
    let fetchCount = 0;

    await svc.get('xf:once', async () => {
      await new Promise<void>(r => setTimeout(r, 3));
      fetchCount++;
      return 'v1';
    }, 0.12);

    await new Promise<void>(r => setTimeout(r, 80));

    // Hit twice rapidly — only one background revalidation should be scheduled.
    // fetchFn uses a small setTimeout so the revalidation stays in-flight across
    // both gets (prevents it completing in microtasks between the two awaits).
    const slowFetch = async () => { await new Promise<void>(r => setTimeout(r, 30)); fetchCount++; return 'v2'; };
    await svc.get('xf:once', slowFetch, 0.12, { xfetchBeta: 1e6 });
    await svc.get('xf:once', slowFetch, 0.12, { xfetchBeta: 1e6 });

    expect(svc.metrics().revalidations.total).toBeLessThanOrEqual(1);

    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  }, 500);
});

// ─── 4. Refresh-ahead scheduling (refreshAhead) ──────────────────────────────

describe('refreshAhead — proactive background recompute', () => {
  it('does not trigger when key was just set (full TTL remaining)', async () => {
    const { svc, diskDir } = makeService();
    await svc.set('ra:fresh', 'v', 60); // 60s — near full TTL remaining
    await svc.get('ra:fresh', async () => 'new', 60, { refreshAhead: 0.8 });
    // refreshAhead=0.8 fires when remaining ≤ 20% of 60s = 12s; key is fresh → no trigger
    expect(svc.metrics().revalidations.total).toBe(0);
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('triggers background recompute when threshold is crossed (fake timers)', async () => {
    vi.useFakeTimers();
    const { svc, diskDir } = makeService();
    try {
      let fetchCount = 0;
      await svc.set('ra:key', 'original', 60);

      // Advance 55 s → 5 s remaining; threshold = 60 s * (1-0.9) = 6 s → 5 ≤ 6 → fires
      vi.advanceTimersByTime(55_000);

      const val = await svc.get('ra:key', async () => { fetchCount++; return 'refreshed'; }, 60, {
        refreshAhead: 0.9,
      });

      expect(val).toBe('original');                                 // served from cache
      expect(svc.metrics().revalidations.total).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('does not retrigger while revalidation is already in flight', async () => {
    vi.useFakeTimers();
    const { svc, diskDir } = makeService();
    try {
      await svc.set('ra:once', 'v', 60);
      vi.advanceTimersByTime(55_000);

      await svc.get('ra:once', async () => 'new', 60, { refreshAhead: 0.9 });
      await svc.get('ra:once', async () => 'new', 60, { refreshAhead: 0.9 });

      // Second hit sees key still in `revalidating` set → skipped
      expect(svc.metrics().revalidations.total).toBe(1);
    } finally {
      vi.useRealTimers();
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('still returns cached value even when refresh-ahead is triggered', async () => {
    vi.useFakeTimers();
    const { svc, diskDir } = makeService();
    try {
      await svc.set('ra:val', { score: 42 }, 60);
      vi.advanceTimersByTime(55_000);

      const val = await svc.get('ra:val', async () => ({ score: 99 }), 60, { refreshAhead: 0.9 });
      expect((val as { score: number }).score).toBe(42); // stale value, not re-fetch result
    } finally {
      vi.useRealTimers();
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('refresh-ahead and SWR are independent — both can be active', async () => {
    vi.useFakeTimers();
    const { svc, diskDir } = makeService();
    try {
      await svc.set('ra:swr', 'v', 60);
      vi.advanceTimersByTime(55_000);

      // Both opts active: SWR grace period + refresh-ahead threshold
      const val = await svc.get('ra:swr', async () => 'new', 60, {
        refreshAhead: 0.9,
        swr:          30,
      });
      expect(val).toBe('v');
    } finally {
      vi.useRealTimers();
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── 5. hotKeys(n) ───────────────────────────────────────────────────────────

describe('hotKeys(n)', () => {
  let svc: CacheService;
  let diskDir: string;

  beforeEach(() => ({ svc, diskDir } = makeService()));
  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('returns an empty array when L1 is empty', () => {
    expect(svc.hotKeys(5)).toEqual([]);
  });

  it('returns at most n entries', async () => {
    for (let i = 0; i < 20; i++) await svc.set(`hk:${i}`, i, 60);
    const result = svc.hotKeys(5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('returns keys sorted by hit count descending', async () => {
    await svc.set('hk:a', 1, 60);
    await svc.set('hk:b', 2, 60);
    await svc.set('hk:c', 3, 60);

    // Access a 6×, b 3×, c 1×
    for (let i = 0; i < 6; i++) await svc.get('hk:a', async () => 1, 60);
    for (let i = 0; i < 3; i++) await svc.get('hk:b', async () => 2, 60);
    await svc.get('hk:c', async () => 3, 60);

    const top = svc.hotKeys(3);
    expect(top[0].key).toBe('hk:a');
    expect(top[1].key).toBe('hk:b');
    expect(top[2].key).toBe('hk:c');
  });

  it('each entry has sizeBytes > 0', async () => {
    await svc.set('hk:size', { payload: 'data' }, 60);
    const result = svc.hotKeys(1);
    expect(result.length).toBe(1);
    expect(result[0].sizeBytes).toBeGreaterThan(0);
  });

  it('each entry has a hits field ≥ 1', async () => {
    await svc.set('hk:hits', 'v', 60);
    await svc.get('hk:hits', async () => 'v', 60);
    const result = svc.hotKeys(1);
    expect(result[0].hits).toBeGreaterThanOrEqual(1);
  });

  it('strips the namespace prefix from returned keys', async () => {
    const { svc: ns, diskDir: d } = makeService({ namespace: 'myns' });
    await ns.set('user:1', 'v', 60);
    for (let i = 0; i < 3; i++) await ns.get('user:1', async () => 'v', 60);

    const result = ns.hotKeys(1);
    expect(result.length).toBe(1);
    expect(result[0].key).toBe('user:1');
    expect(result[0].key).not.toContain('myns:');

    ns.destroy();
    try { rmSync(d, { recursive: true, force: true }); } catch {}
  });

  it('n defaults to 10 when not provided', async () => {
    for (let i = 0; i < 20; i++) await svc.set(`hk:def:${i}`, i, 60);
    const result = svc.hotKeys();
    expect(result.length).toBeLessThanOrEqual(10);
  });
});

// ─── 6. Dependency-aware invalidation (dependsOn) ────────────────────────────

describe('dependsOn — dependency-aware cascade invalidation', () => {
  let svc: CacheService;
  let diskDir: string;

  beforeEach(() => ({ svc, diskDir } = makeService()));
  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('invalidates dependent key when a source key matching the pattern is deleted', async () => {
    await svc.set('analytics:org1', 'stale', 60, undefined, {
      dependsOn: ['case:org1:*'],
    });
    expect(svc.has('analytics:org1')).toBe(true);

    await svc.delete('case:org1:case123');

    expect(svc.has('analytics:org1')).toBe(false);
  });

  it('does NOT cascade when deleted key does not match the pattern', async () => {
    await svc.set('analytics:org2', 'data', 60, undefined, {
      dependsOn: ['case:org2:*'],
    });

    await svc.delete('case:org9:case123'); // different org

    expect(svc.has('analytics:org2')).toBe(true);
  });

  it('supports an exact key (no wildcard) as a dependsOn pattern', async () => {
    await svc.set('derived:1', 'v', 60, undefined, {
      dependsOn: ['source:1'],
    });

    await svc.delete('source:1');

    expect(svc.has('derived:1')).toBe(false);
  });

  it('cascades to multiple dependents registered under the same pattern', async () => {
    await svc.set('dep:a', 'v', 60, undefined, { dependsOn: ['base:x'] });
    await svc.set('dep:b', 'v', 60, undefined, { dependsOn: ['base:x'] });
    await svc.set('dep:c', 'v', 60, undefined, { dependsOn: ['base:y'] });

    await svc.delete('base:x');

    expect(svc.has('dep:a')).toBe(false);
    expect(svc.has('dep:b')).toBe(false);
    expect(svc.has('dep:c')).toBe(true); // different pattern, not affected
  });

  it('one key can declare multiple dependsOn patterns', async () => {
    await svc.set('summary:1', 'v', 60, undefined, {
      dependsOn: ['case:org1:*', 'member:org1:*'],
    });

    await svc.delete('member:org1:user42');

    expect(svc.has('summary:1')).toBe(false);
  });

  it('non-matching delete leaves dependent key intact across multiple patterns', async () => {
    await svc.set('dep:safe', 'v', 60, undefined, {
      dependsOn: ['case:orgX:*', 'member:orgX:*'],
    });

    await svc.delete('case:orgY:item');   // different org
    await svc.delete('member:orgZ:user'); // different org

    expect(svc.has('dep:safe')).toBe(true);
  });

  it('mset() supports dependsOn per-entry', async () => {
    await svc.mset({
      'batch:dep:1': { value: 'v1', ttl: 60, dependsOn: ['batch:src:*'] },
      'batch:dep:2': { value: 'v2', ttl: 60, dependsOn: ['batch:src:*'] },
      'batch:dep:3': { value: 'v3', ttl: 60, dependsOn: ['batch:other:*'] },
    });

    await svc.delete('batch:src:item1');

    expect(svc.has('batch:dep:1')).toBe(false);
    expect(svc.has('batch:dep:2')).toBe(false);
    expect(svc.has('batch:dep:3')).toBe(true);
  });

  it('deleted dependent is removed from the dependency index (no double-cascade)', async () => {
    await svc.set('dep:clean', 'v', 60, undefined, { dependsOn: ['src:*'] });

    // Explicitly delete the dependent first
    await svc.delete('dep:clean');
    expect(svc.has('dep:clean')).toBe(false);

    // Deleting a source key now should not error even though dep:clean is gone
    await expect(svc.delete('src:item')).resolves.toBeUndefined();
  });

  it('cascade does not affect the triggering key itself', async () => {
    // Circular-ish: a key that "depends on" itself via a glob
    await svc.set('self:1', 'v', 60, undefined, { dependsOn: ['unrelated:*'] });

    await svc.delete('unrelated:item');

    // The key registered as dependent is 'self:1', not 'unrelated:item'
    expect(svc.has('self:1')).toBe(false); // correctly cascaded
  });

  it('backplane message triggers cascade on the receiving instance', async () => {
    // Simulate a fleet peer: instance A deletes the parent key and publishes
    // a 'del' backplane message. Instance B (svc) receives it via
    // _handleBackplaneMessage. The dependent registered on instance B should
    // be evicted even though instance B never called delete() directly.
    const nsParent = (svc as unknown as { nk: (k: string) => string }).nk('org:99');
    const nsDependent = (svc as unknown as { nk: (k: string) => string }).nk('org:99:config');

    // Register the dependent on this instance (as if it handled a set())
    await svc.set('org:99:config', 'cfg', 60, undefined, { dependsOn: ['org:99'] });
    expect(svc.has('org:99:config')).toBe(true);

    // Simulate a peer publishing a delete for the parent — use a different src
    // so the skip-own-message guard doesn't fire.
    const peerMessage = JSON.stringify({ op: 'del', key: nsParent, src: 'peer-instance-id' });
    (svc as unknown as { _handleBackplaneMessage: (m: string) => void })
      ._handleBackplaneMessage(peerMessage);

    // Dependent must be gone — cascade ran on the receiving side
    expect(svc.has('org:99:config')).toBe(false);

    void nsDependent; // suppress unused-variable warning
  });
});

// ─── 7. mget per-key TTL ─────────────────────────────────────────────────────

describe('mget — per-key TTL function', () => {
  let svc: CacheService;
  let diskDir: string;

  beforeEach(() => ({ svc, diskDir } = makeService()));
  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('accepts a plain number TTL (backwards compat)', async () => {
    const results = await svc.mget(
      ['k:1', 'k:2'],
      (keys) => Promise.resolve(Object.fromEntries(keys.map(k => [k, k]))),
      120,
    );
    expect(results).toEqual(['k:1', 'k:2']);
    expect(svc.ttl('k:1')).toBeGreaterThan(0);
    expect(svc.ttl('k:1')).toBeLessThanOrEqual(120);
  });

  it('applies per-key TTL via function', async () => {
    const ttlFn = (key: string) => key.startsWith('long:') ? 600 : 60;

    await svc.mget(
      ['long:a', 'short:b'],
      (keys) => Promise.resolve(Object.fromEntries(keys.map(k => [k, k]))),
      ttlFn,
    );

    const longTtl  = svc.ttl('long:a');
    const shortTtl = svc.ttl('short:b');

    expect(longTtl).not.toBeNull();
    expect(shortTtl).not.toBeNull();
    // long: key must have a meaningfully larger TTL than short: key
    expect(longTtl!).toBeGreaterThan(shortTtl! + 60);
  });

  it('each miss key gets its own independently resolved TTL', async () => {
    const ttls: Record<string, number> = { 'item:a': 30, 'item:b': 90, 'item:c': 180 };
    const ttlFn = (key: string) => ttls[key] ?? 60;

    await svc.mget(
      ['item:a', 'item:b', 'item:c'],
      (keys) => Promise.resolve(Object.fromEntries(keys.map(k => [k, k]))),
      ttlFn,
    );

    expect(svc.ttl('item:a')).toBeLessThanOrEqual(30);
    expect(svc.ttl('item:b')).toBeLessThanOrEqual(90);
    expect(svc.ttl('item:c')).toBeLessThanOrEqual(180);
    // Confirm ordering: a < b < c
    expect(svc.ttl('item:a')!).toBeLessThan(svc.ttl('item:b')!);
    expect(svc.ttl('item:b')!).toBeLessThan(svc.ttl('item:c')!);
  });

  it('TTL function is only called for miss keys, not L1 hits', async () => {
    // Pre-populate item:x in L1
    await svc.set('item:x', 'cached', 300);
    const ttlFn = vi.fn((key: string) => key === 'item:y' ? 45 : 300);

    await svc.mget(
      ['item:x', 'item:y'],
      (keys) => Promise.resolve(Object.fromEntries(keys.map(k => [k, k]))),
      ttlFn,
    );

    // ttlFn should only be called for the miss key 'item:y'
    expect(ttlFn).toHaveBeenCalledOnce();
    expect(ttlFn).toHaveBeenCalledWith('item:y');
  });
});

// ─── 8. cache.ready() ────────────────────────────────────────────────────────

describe('cache.ready()', () => {
  let svc: CacheService;
  let diskDir: string;

  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('resolves immediately when warmKeys is not configured', async () => {
    ({ svc, diskDir } = makeService());
    await expect(svc.ready()).resolves.toBeUndefined();
  });

  it('resolves immediately when Redis is disabled (warmKeys is a no-op)', async () => {
    ({ svc, diskDir } = makeService({ warmKeys: 'user:*' }));
    // Redis is disabled — warmFromL2 returns 0 immediately; ready() should still resolve
    await expect(svc.ready()).resolves.toBeUndefined();
  });

  it('returns the same Promise on repeated calls', async () => {
    ({ svc, diskDir } = makeService());
    const p1 = svc.ready();
    const p2 = svc.ready();
    expect(p1).toBe(p2);
  });

  it('resolves before first get() is called (no race with warmKeys)', async () => {
    ({ svc, diskDir } = makeService({ warmKeys: 'session:*' }));
    // Await ready before serving any traffic
    await svc.ready();
    // Basic sanity: cache still works after ready resolves
    await svc.set('session:1', 'data', 60);
    expect(svc.has('session:1')).toBe(true);
  });
});
