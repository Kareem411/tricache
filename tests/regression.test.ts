/**
 * Regression tests for the six maintainer-identified issues.
 *
 * Each describe block is named after the issue and verifies both:
 *   1. The fix works correctly (positive assertions).
 *   2. The old broken behavior no longer occurs (negative / boundary assertions).
 *
 * Redis is disabled throughout — all tests run in-process only.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CacheService } from '../src/cache-service';

function tempDir() {
  const d = join(tmpdir(), `tricache-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

let diskDir: string;
let svc: CacheService;

beforeEach(() => {
  diskDir = tempDir();
  svc = CacheService.reset({
    disableRedis: true,
    l1MaxBytes:   10 * 1024 * 1024,
    l1MaxEntries: 200,
    diskCacheDir: diskDir,
  });
});

afterEach(async () => {
  await svc.destroy();
  try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
});

// ─── Issue 1: stats() sizeBytes inconsistency ────────────────────────────────

describe('Issue 1 — stats().l1 now exposes both sizeBytes and sizeKB', () => {
  it('stats().l1 contains sizeBytes as a number', async () => {
    await svc.set('payload:1', { x: 'hello world' }, 60);
    const s = svc.stats();
    expect(typeof s.l1.sizeBytes).toBe('number');
    expect(s.l1.sizeBytes).toBeGreaterThan(0);
  });

  it('stats().l1 still exposes sizeKB for backward compatibility', async () => {
    await svc.set('payload:2', { x: 'hello world' }, 60);
    const s = svc.stats();
    expect(typeof s.l1.sizeKB).toBe('number');
    expect(s.l1.sizeKB).toBeGreaterThanOrEqual(0);
  });

  it('sizeBytes and sizeKB are consistent (sizeKB = round(sizeBytes / 1024))', async () => {
    await svc.set('payload:3', 'x'.repeat(2048), 60);
    const s = svc.stats();
    expect(s.l1.sizeKB).toBe(Math.round(s.l1.sizeBytes / 1024));
  });

  it('metrics().l1.sizeBytes matches stats().l1.sizeBytes', async () => {
    await svc.set('payload:4', { data: 'test' }, 60);
    const s = svc.stats();
    const m = svc.metrics();
    expect(m.l1.sizeBytes).toBe(s.l1.sizeBytes);
  });
});

// ─── Issue 2: clear() ────────────────────────────────────────────────────────

describe('Issue 2 — clear() full flush and prefix-scoped flush', () => {
  it('clear() with no arguments flushes all L1 entries', async () => {
    await svc.set('alpha:1', 'a', 60);
    await svc.set('alpha:2', 'b', 60);
    await svc.set('beta:1',  'c', 60);

    expect(svc.stats().l1.entries).toBe(3);

    await svc.clear();

    expect(svc.stats().l1.entries).toBe(0);
    expect(svc.stats().l1.sizeBytes).toBe(0);
  });

  it('clear(prefix) removes only keys with that prefix', async () => {
    await svc.set('user:1:data',  'u1', 60);
    await svc.set('user:2:data',  'u2', 60);
    await svc.set('product:1',    'p1', 60);

    await svc.clear('user:');

    // user keys are gone
    const f = async (k: string) =>
      svc.get(k, () => Promise.resolve(null), 60);

    expect(await f('user:1:data')).toBeNull();
    expect(await f('user:2:data')).toBeNull();
    // product key is untouched
    expect(await f('product:1')).toBe('p1');
  });

  it('clear() resets entry count and sizeBytes to zero', async () => {
    for (let i = 0; i < 10; i++) await svc.set(`k:${i}`, 'x'.repeat(512), 60);
    await svc.clear();

    const s = svc.stats();
    expect(s.l1.entries).toBe(0);
    expect(s.l1.sizeBytes).toBe(0);
  });

  it('cache is usable after clear()', async () => {
    await svc.set('pre:x', 'before', 60);
    await svc.clear();

    const fetch = async () => 'after';
    const result = await svc.get('pre:x', fetch, 60);
    expect(result).toBe('after');
  });

  it('clear() also resets L1 counters so increment() starts from 1 again', async () => {
    await svc.increment('hits', 60);
    await svc.increment('hits', 60);
    await svc.clear();

    const after = await svc.increment('hits', 60);
    expect(after).toBe(1);
  });
});

// ─── Issue 3: rebalance() ────────────────────────────────────────────────────

describe('Issue 3 — rebalance() evicts entries that exceed category limits', () => {
  it('rebalance() evicts overflowing entries after limits are tightened post-startup', async () => {
    // Start with generous limits so 5 entries accumulate freely
    const looseSvc = CacheService.reset({
      disableRedis:   true,
      l1MaxEntries:   100,
      diskCacheDir:   tempDir(),
      categoryLimits: { 'item:': { maxEntries: 10, maxSizeBytes: 5 * 1024 * 1024 } },
    });

    try {
      for (let i = 1; i <= 5; i++) await looseSvc.set(`item:${i}`, { v: i }, 60);
      expect(looseSvc.stats().l1.entries).toBe(5);

      // Simulate post-startup limit tightening — the core of the maintainer issue.
      // Without rebalance() there is no way to enforce the new limit retroactively.
      (looseSvc['l1'] as any).opts.categories['item:'] = {
        maxEntries:   2,
        maxSizeBytes: 5 * 1024 * 1024,
      };

      const evicted = looseSvc.rebalance();

      expect(evicted).toBeGreaterThan(0);
      expect(looseSvc.stats().l1.entries).toBeLessThanOrEqual(2);
    } finally {
      await looseSvc.destroy();
    }
  });

  it('rebalance() returns 0 when all entries are within limits', async () => {
    await svc.set('safe:1', 'a', 60);
    await svc.set('safe:2', 'b', 60);
    const evicted = svc.rebalance();
    expect(evicted).toBe(0);
    expect(svc.stats().l1.entries).toBe(2);
  });

  it('rebalance() does not evict CRITICAL entries with remaining TTL', async () => {
    const { CachePriority } = await import('../src/types');
    await svc.set('auth:tok:1', 'token', 300, CachePriority.CRITICAL);

    // Force over-capacity at global level by lowering the limit directly
    // (simulating a post-startup reconfiguration scenario):
    (svc['l1'] as any).opts.maxEntries = 0; // make ANY entry exceed global limit
    const evicted = svc.rebalance();

    // CRITICAL entry with future TTL must survive
    const result = await svc.get('auth:tok:1', () => Promise.resolve(null), 300);
    expect(result).toBe('token');
    // Restore so afterEach cleanup works
    (svc['l1'] as any).opts.maxEntries = 200;
  });
});

// ─── Issue 4: increment() L1 fallback ───────────────────────────────────────

describe('Issue 4 — increment() returns accumulating count when Redis is disabled', () => {
  it('increment() returns 1 on first call, 2 on second, etc.', async () => {
    const c1 = await svc.increment('rate:user:1', 60);
    const c2 = await svc.increment('rate:user:1', 60);
    const c3 = await svc.increment('rate:user:1', 60);

    expect(c1).toBe(1);
    expect(c2).toBe(2);
    expect(c3).toBe(3);
  });

  it('independent keys do not share counters', async () => {
    const a1 = await svc.increment('rate:a', 60);
    const b1 = await svc.increment('rate:b', 60);
    const a2 = await svc.increment('rate:a', 60);

    expect(a1).toBe(1);
    expect(b1).toBe(1);
    expect(a2).toBe(2);
  });

  it('counter resets to 1 after its TTL window expires', async () => {
    // 1-second TTL window
    const c1 = await svc.increment('rate:short', 1);
    expect(c1).toBe(1);

    // Simulate expiry by backdating the stored entry
    const k = svc['nk']('rate:short');
    const entry = svc['_l1Counters'].get(k)!;
    entry.expiresAt = Date.now() - 1;

    const c2 = await svc.increment('rate:short', 1);
    expect(c2).toBe(1); // resets after expiry
  });

  it('namespaced instances keep separate counters', async () => {
    const diskA = tempDir();
    const diskB = tempDir();
    const svcA = CacheService.reset({ disableRedis: true, namespace: 'a', diskCacheDir: diskA });
    const svcB = CacheService.reset({ disableRedis: true, namespace: 'b', diskCacheDir: diskB });
    try {
      const a = await svcA.increment('hits', 60);
      const b = await svcB.increment('hits', 60);
      expect(a).toBe(1);
      expect(b).toBe(1); // separate — not sharing the same counter
    } finally {
      await svcA.destroy();
      await svcB.destroy();
      rmSync(diskA, { recursive: true, force: true });
      rmSync(diskB, { recursive: true, force: true });
    }
  });
});

// ─── Issue 5: per-key TTL introspection ─────────────────────────────────────

describe('Issue 5 — ttl() returns remaining seconds without fetching the value', () => {
  it('ttl() returns a positive number for a freshly-set key', async () => {
    await svc.set('ttl:fresh', 'data', 120);
    const remaining = svc.ttl('ttl:fresh');
    expect(remaining).not.toBeNull();
    expect(remaining!).toBeGreaterThan(0);
    expect(remaining!).toBeLessThanOrEqual(120);
  });

  it('ttl() returns null for a key that does not exist in L1', () => {
    expect(svc.ttl('ttl:ghost')).toBeNull();
  });

  it('ttl() returns null after the entry expires', async () => {
    // 1 ms TTL — expires immediately
    svc['l1'].set(svc['nk']('ttl:expired'), 'x', 1, 2);
    await new Promise(r => setTimeout(r, 20));
    expect(svc.ttl('ttl:expired')).toBeNull();
  });

  it('ttl() decreases over time', async () => {
    await svc.set('ttl:tick', 'v', 300);
    const r1 = svc.ttl('ttl:tick')!;
    await new Promise(r => setTimeout(r, 1100));
    const r2 = svc.ttl('ttl:tick')!;
    // After ~1 second the remaining TTL should be smaller
    expect(r2).toBeLessThan(r1);
  });

  it('ttl() does NOT consume the value (get() still returns it)', async () => {
    await svc.set('ttl:safe', 42, 60);
    svc.ttl('ttl:safe'); // should not delete or alter the entry
    const val = await svc.get('ttl:safe', () => Promise.resolve(0), 60);
    expect(val).toBe(42);
  });

  it('ttl() respects the namespace prefix', async () => {
    const nsDisk = tempDir();
    const nsSvc = CacheService.reset({
      disableRedis: true,
      namespace:    'ns1',
      diskCacheDir: nsDisk,
    });
    try {
      await nsSvc.set('item:x', 'v', 100);
      // ttl() should find the entry under the namespaced key
      expect(nsSvc.ttl('item:x')).not.toBeNull();
      // but the un-namespaced key on the other instance should not be visible
      expect(svc.ttl('item:x')).toBeNull();
    } finally {
      await nsSvc.destroy();
      rmSync(nsDisk, { recursive: true, force: true });
    }
  });
});

// ─── Issue 6: writeSnapshot() alternate path ─────────────────────────────────

describe('Issue 6 — writeSnapshot() accepts an alternate path', () => {
  it('writeSnapshot() writes to the alternate path when provided', async () => {
    await svc.set('snap:a', { data: 'hello' }, 300);
    await svc.set('snap:b', { data: 'world' }, 300);

    const altPath = join(diskDir, 'backup.snap');
    svc.writeSnapshot(altPath);

    expect(existsSync(altPath)).toBe(true);
  });

  it('writeSnapshot() with no argument still uses the configured default path', async () => {
    await svc.set('snap:default', 'v', 300);

    const configuredPath = svc['opts'].snapshotPath;
    svc.writeSnapshot();

    expect(existsSync(configuredPath)).toBe(true);
    // Clean up snapshot so afterEach isn't affected
    try { rmSync(configuredPath); } catch {}
  });

  it('writeSnapshot(altPath) does not overwrite the configured default path', async () => {
    await svc.set('snap:c', 'v', 300);

    const altPath        = join(diskDir, 'ondemand.snap');
    const configuredPath = svc['opts'].snapshotPath;

    svc.writeSnapshot(altPath);

    expect(existsSync(altPath)).toBe(true);
    expect(existsSync(configuredPath)).toBe(false);
  });

  it('writeSnapshot() with alternate path accepts zero arguments (original method still works)', () => {
    // Verifies the optional param is backward-compatible: no arguments → no throw
    expect(() => svc.writeSnapshot()).not.toThrow();
  });
});
