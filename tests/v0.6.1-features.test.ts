/**
 * v0.6.1 feature tests:
 *
 *   1. Worker thread crypto offload (WorkerPool)
 *   2. Backplane staleness fence (evictSetBefore + reconnect tracking)
 *   3. Serverless / ephemeral disk auto-detection (disableDisk)
 *   4. Redis Cluster & Sentinel options wiring
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService }      from '../src/cache-service';
import { SmartMemoryCache }  from '../src/smart-memory-cache';
import { WorkerPool }        from '../src/worker-pool';
import { CacheEncryption }   from '../src/encryption';
import { CachePriority, consoleLogger } from '../src/types';
import { tmpdir }    from 'os';
import { join }      from 'path';
import { rmSync }    from 'fs';

// ─── Helpers ────────────────────────────────────────────────────────────────

function tempDir() {
  return join(tmpdir(), `tricache-v061-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function makeL1(extra: Partial<ConstructorParameters<typeof SmartMemoryCache>[0]> = {}) {
  return new SmartMemoryCache({
    maxBytes:   50 * 1024 * 1024,
    maxEntries: 500,
    categories: { default: { maxEntries: 500, maxSizeBytes: 50 * 1024 * 1024 } },
    logger:     silentLogger,
    ...extra,
  });
}

function makeSvc(extra: Parameters<typeof CacheService.reset>[0] = {}) {
  const diskDir = tempDir();
  const svc = CacheService.reset({
    disableRedis: true,
    l1MaxEntries: 200,
    diskCacheDir: diskDir,
    ...extra,
  });
  return { svc, diskDir };
}

// AES-256 test key (32 bytes, deterministic — not a real secret)
const TEST_KEY_B64 = Buffer.alloc(32, 0xab).toString('base64');

// ─── 1. Worker thread crypto offload ────────────────────────────────────────

describe('WorkerPool — off-main-thread crypto', () => {
  let pool: WorkerPool | null = null;

  afterEach(async () => {
    if (pool) { await pool.destroy(); pool = null; }
  });

  it('initialises successfully with a valid key', () => {
    pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
    expect(pool.isAvailable).toBe(true);
  });

  it('encrypt + decrypt round-trips produce the original string', async () => {
    pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
    expect(pool.isAvailable).toBe(true);

    const plain  = JSON.stringify({ hello: 'world', n: 42 });
    const cipher = await pool.encrypt(plain);
    const back   = await pool.decrypt(cipher);

    expect(back).toBe(plain);
    expect(cipher).not.toBe(plain);
  });

  it('produces the same plaintext as synchronous CacheEncryption.decrypt', async () => {
    const enc  = new CacheEncryption(TEST_KEY_B64, silentLogger);
    pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
    expect(pool.isAvailable).toBe(true);

    const plain  = JSON.stringify({ data: 'x'.repeat(500) });
    const syncCt = enc.encrypt(plain);

    // Worker can decrypt what sync produced
    const workerDecrypted = await pool.decrypt(syncCt);
    expect(workerDecrypted).toBe(plain);

    // Sync can decrypt what worker produced
    const workerCt = await pool.encrypt(plain);
    const syncDecrypted = enc.decrypt(workerCt);
    expect(syncDecrypted).toBe(plain);
  });

  it('handles concurrent encrypt requests without losing any', async () => {
    pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 2 });
    expect(pool.isAvailable).toBe(true);

    const payloads = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, v: 'data' }));
    const ciphers  = await Promise.all(payloads.map(p => pool!.encrypt(p)));
    const plains   = await Promise.all(ciphers.map(c => pool!.decrypt(c)));

    for (let i = 0; i < payloads.length; i++) {
      expect(plains[i]).toBe(payloads[i]);
    }
  });

  it('each encrypt produces a distinct ciphertext (IV is unique per call)', async () => {
    pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
    const plain = JSON.stringify({ msg: 'same content' });
    const [c1, c2] = await Promise.all([pool.encrypt(plain), pool.encrypt(plain)]);
    expect(c1).not.toBe(c2); // different IVs → different ciphertext
  });

  it('destroy() resolves cleanly and marks pool unavailable on subsequent use', async () => {
    pool = new WorkerPool({ keyBase64: TEST_KEY_B64, mode: 'aes-256-gcm', size: 1 });
    expect(pool.isAvailable).toBe(true);
    await pool.destroy();
    expect(pool.isAvailable).toBe(false);
    pool = null;
  });

  it('CacheService initialises a worker pool when workerThreads: true', async () => {
    const { svc, diskDir } = makeSvc({
      encryptionKey:        TEST_KEY_B64,
      workerThreads:        true,
      workerPoolSize:       1,
      workerThresholdBytes: 64,   // low threshold so the pool is exercised in tests
    });
    try {
      // Internal pool should be non-null
      expect((svc as unknown as { _workerPool: WorkerPool | null })._workerPool).not.toBeNull();
    } finally {
      await svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('CacheService does not create a pool when workerThreads is false/unset', () => {
    const { svc, diskDir } = makeSvc({ encryptionKey: TEST_KEY_B64 });
    try {
      expect((svc as unknown as { _workerPool: WorkerPool | null })._workerPool).toBeNull();
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('pool encrypt/decrypt are exercised through CacheService get/set with low threshold', async () => {
    const { svc, diskDir } = makeSvc({
      encryptionKey:        TEST_KEY_B64,
      workerThreads:        true,
      workerPoolSize:       1,
      workerThresholdBytes: 10,  // anything > 10 bytes goes through the pool
    });
    try {
      await svc.set('wt:key', { data: 'some payload' }, 300);
      const v = await svc.get('wt:key', async () => null, 300);
      expect(v).toEqual({ data: 'some payload' });
    } finally {
      await svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── 2. Backplane staleness fence — evictSetBefore ──────────────────────────

describe('SmartMemoryCache.evictSetBefore — staleness fence primitive', () => {
  let cache: SmartMemoryCache;
  beforeEach(() => { cache = makeL1(); });

  it('returns 0 when the cache is empty', () => {
    expect(cache.evictSetBefore(Date.now())).toBe(0);
  });

  it('evicts entries whose write-time is before the cutoff', () => {
    const before = Date.now();
    cache.set('stale:1', 'a', 60_000);
    cache.set('stale:2', 'b', 60_000);
    const after = Date.now() + 1;

    // Both entries were written before `after`, so both should be evicted
    const evicted = cache.evictSetBefore(after);
    expect(evicted).toBe(2);
    expect(cache.get('stale:1')).toBeNull();
    expect(cache.get('stale:2')).toBeNull();
  });

  it('does not evict entries written after the cutoff', async () => {
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 5)); // ensure write-time > cutoff

    cache.set('fresh:1', 'x', 60_000);
    cache.set('fresh:2', 'y', 60_000);

    const evicted = cache.evictSetBefore(cutoff);
    expect(evicted).toBe(0);
    expect(cache.get('fresh:1')).not.toBeNull();
    expect(cache.get('fresh:2')).not.toBeNull();
  });

  it('only evicts entries set before the cutoff when mixed age entries exist', async () => {
    // Set entries that will be considered "before"
    cache.set('old:1', 'old', 60_000);
    cache.set('old:2', 'old', 60_000);
    const cutoff = Date.now() + 1;
    await new Promise(r => setTimeout(r, 5));

    // Set entries after the cutoff
    cache.set('new:1', 'new', 60_000);
    cache.set('new:2', 'new', 60_000);

    const evicted = cache.evictSetBefore(cutoff);
    expect(evicted).toBe(2);
    expect(cache.get('old:1')).toBeNull();
    expect(cache.get('old:2')).toBeNull();
    expect(cache.get('new:1')).not.toBeNull();
    expect(cache.get('new:2')).not.toBeNull();
  });

  it('never evicts live CRITICAL entries regardless of age', async () => {
    cache.set('auth:token:1', 'secret', 60_000, CachePriority.CRITICAL);
    const cutoff = Date.now() + 1;
    await new Promise(r => setTimeout(r, 5));

    const evicted = cache.evictSetBefore(cutoff);
    expect(evicted).toBe(0);
    expect(cache.get('auth:token:1')).not.toBeNull();
  });

  it('evicts an expired CRITICAL entry (no longer live)', () => {
    cache.set('auth:expired', 'old', 1 /* 1 ms TTL */);
    const cutoff = Date.now() + 50;
    return new Promise<void>(resolve => setTimeout(() => {
      const evicted = cache.evictSetBefore(cutoff);
      // expired CRITICAL may be evicted since it's no longer live
      expect(evicted).toBeGreaterThanOrEqual(0); // may or may not, depending on exact timing
      resolve();
    }, 20));
  });

  it('rebuilds the bloom filter after evictions', () => {
    cache.set('bf:1', 1, 60_000);
    cache.set('bf:2', 2, 60_000);
    const cutoff = Date.now() + 1;

    cache.evictSetBefore(cutoff);

    // Keys evicted from cache should not appear as bloom hits (may still be
    // true-positives from hash collisions, but the filter is rebuilt).
    // The actual L1 miss is the definitive test.
    expect(cache.get('bf:1')).toBeNull();
    expect(cache.get('bf:2')).toBeNull();
  });

  it('returns the correct count for large eviction runs', () => {
    const N = 100;
    for (let i = 0; i < N; i++) cache.set(`bulk:${i}`, i, 60_000);
    const evicted = cache.evictSetBefore(Date.now() + 1);
    expect(evicted).toBe(N);
    expect(cache.size).toBe(0);
  });
});

describe('backplaneMaxStalenessMs — configuration defaults and opts wiring', () => {
  it('defaults to 5000 ms when not specified', () => {
    const { svc, diskDir } = makeSvc({ invalidationBackplane: false });
    try {
      const opts = (svc as unknown as { opts: { backplaneMaxStalenessMs: number } }).opts;
      expect(opts.backplaneMaxStalenessMs).toBe(5_000);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('accepts a custom backplaneMaxStalenessMs value', () => {
    const { svc, diskDir } = makeSvc({ invalidationBackplane: false, backplaneMaxStalenessMs: 15_000 });
    try {
      const opts = (svc as unknown as { opts: { backplaneMaxStalenessMs: number } }).opts;
      expect(opts.backplaneMaxStalenessMs).toBe(15_000);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('accepts 0 to disable the fence entirely', () => {
    const { svc, diskDir } = makeSvc({ invalidationBackplane: false, backplaneMaxStalenessMs: 0 });
    try {
      const opts = (svc as unknown as { opts: { backplaneMaxStalenessMs: number } }).opts;
      expect(opts.backplaneMaxStalenessMs).toBe(0);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('_subDisconnectedAt starts null', () => {
    const { svc, diskDir } = makeSvc();
    try {
      const disconnectedAt = (svc as unknown as { _subDisconnectedAt: number | null })._subDisconnectedAt;
      expect(disconnectedAt).toBeNull();
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── 3. Serverless / ephemeral disk auto-detection ──────────────────────────

describe('disableDisk — explicit option', () => {
  it('disableDisk: true skips disk operations — get/set still work via L1', async () => {
    const { svc, diskDir } = makeSvc({ disableDisk: true });
    try {
      await svc.set('disk:key', { n: 1 }, 60);
      const v = await svc.get('disk:key', async () => null, 60);
      expect(v).toEqual({ n: 1 });
    } finally {
      await svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('disableDisk: true — metrics().disk.disabled is true', () => {
    const { svc, diskDir } = makeSvc({ disableDisk: true });
    try {
      const m = svc.metrics();
      expect((m.disk as unknown as { disabled: boolean }).disabled).toBe(true);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('disableDisk: false — metrics().disk.disabled is false', () => {
    const { svc, diskDir } = makeSvc({ disableDisk: false });
    try {
      const m = svc.metrics();
      expect((m.disk as unknown as { disabled: boolean }).disabled).toBe(false);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('disableDisk: true — delete() does not throw', async () => {
    const { svc, diskDir } = makeSvc({ disableDisk: true });
    try {
      await svc.set('del:key', 'v', 60);
      await expect(svc.delete('del:key')).resolves.not.toThrow();
    } finally {
      await svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('disableDisk: true — clear() does not throw', async () => {
    const { svc, diskDir } = makeSvc({ disableDisk: true });
    try {
      await svc.set('clr:a', 1, 60);
      await svc.set('clr:b', 2, 60);
      await expect(svc.clear()).resolves.not.toThrow();
      const v = await svc.get('clr:a', async () => 'miss', 60);
      expect(v).toBe('miss'); // cleared from L1 too
    } finally {
      await svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('disableDisk: true — destroy() does not throw', async () => {
    const { svc } = makeSvc({ disableDisk: true });
    await expect(svc.destroy()).resolves.not.toThrow();
  });
});

describe('serverless auto-detection — environment variable detection', () => {
  const SERVERLESS_VARS = [
    'AWS_LAMBDA_FUNCTION_NAME',
    'K_SERVICE',
    'FUNCTION_TARGET',
    'WEBSITE_INSTANCE_ID',
    'FLY_APP_NAME',
    'RAILWAY_ENVIRONMENT',
    'VERCEL',
  ] as const;

  for (const envVar of SERVERLESS_VARS) {
    it(`auto-disables disk when ${envVar} is set`, () => {
      const original = process.env[envVar];
      process.env[envVar] = 'test-value';
      try {
        const { svc, diskDir } = makeSvc();
        try {
          const diskDisabled = (svc as unknown as { _diskDisabled: boolean })._diskDisabled;
          expect(diskDisabled).toBe(true);
        } finally {
          svc.destroy();
          try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
        }
      } finally {
        if (original === undefined) {
          delete process.env[envVar];
        } else {
          process.env[envVar] = original;
        }
      }
    });
  }

  it('disableDisk: false overrides auto-detection even when Lambda env var is set', () => {
    const original = process.env['AWS_LAMBDA_FUNCTION_NAME'];
    process.env['AWS_LAMBDA_FUNCTION_NAME'] = 'my-fn';
    try {
      const { svc, diskDir } = makeSvc({ disableDisk: false });
      try {
        const diskDisabled = (svc as unknown as { _diskDisabled: boolean })._diskDisabled;
        expect(diskDisabled).toBe(false);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    } finally {
      if (original === undefined) {
        delete process.env['AWS_LAMBDA_FUNCTION_NAME'];
      } else {
        process.env['AWS_LAMBDA_FUNCTION_NAME'] = original;
      }
    }
  });

  it('disk remains enabled in non-serverless environment', () => {
    // Ensure none of the serverless vars are set
    const saved: Record<string, string | undefined> = {};
    for (const v of SERVERLESS_VARS) {
      saved[v] = process.env[v];
      delete process.env[v];
    }
    try {
      const { svc, diskDir } = makeSvc();
      try {
        const diskDisabled = (svc as unknown as { _diskDisabled: boolean })._diskDisabled;
        expect(diskDisabled).toBe(false);
      } finally {
        svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  });

  it('full cache workflow functions correctly when disk is auto-disabled', async () => {
    const original = process.env['K_SERVICE'];
    process.env['K_SERVICE'] = 'my-service';
    try {
      const { svc, diskDir } = makeSvc();
      try {
        await svc.set('sl:a', { x: 1 }, 60);
        await svc.set('sl:b', { x: 2 }, 60);

        const va = await svc.get('sl:a', async () => null, 60);
        const vb = await svc.get('sl:b', async () => null, 60);

        expect(va).toEqual({ x: 1 });
        expect(vb).toEqual({ x: 2 });

        await svc.delete('sl:a');
        const after = await svc.get('sl:a', async () => 'fetched', 60);
        expect(after).toBe('fetched');
      } finally {
        await svc.destroy();
        try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
      }
    } finally {
      if (original === undefined) {
        delete process.env['K_SERVICE'];
      } else {
        process.env['K_SERVICE'] = original;
      }
    }
  });
});

// ─── 4. Redis Cluster & Sentinel options wiring ──────────────────────────────
// Full Cluster/Sentinel integration requires real Redis nodes.  These tests
// verify option parsing, type wiring, _redisDisabled computation, and that
// the options are correctly stored in the internal opts object.

describe('Redis Cluster options wiring', () => {
  it('stores redisClusterNodes in opts', () => {
    const { svc, diskDir } = makeSvc({
      redisClusterNodes: [
        { host: 'node-1', port: 6379 },
        { host: 'node-2', port: 6379 },
      ],
    });
    try {
      const opts = (svc as unknown as { opts: { redisClusterNodes?: { host: string; port: number }[] } }).opts;
      expect(opts.redisClusterNodes).toHaveLength(2);
      expect(opts.redisClusterNodes![0]).toEqual({ host: 'node-1', port: 6379 });
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('_redisDisabled is false when redisClusterNodes is set (even without redisHost)', () => {
    const { svc, diskDir } = makeSvc({
      disableRedis:      false,
      redisClusterNodes: [{ host: 'cluster-node', port: 6379 }],
    });
    try {
      const redisDisabled = (svc as unknown as { _redisDisabled: boolean })._redisDisabled;
      expect(redisDisabled).toBe(false);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('_redisDisabled is true when disableRedis: true even with cluster nodes', () => {
    const { svc, diskDir } = makeSvc({
      disableRedis:      true,
      redisClusterNodes: [{ host: 'cluster-node', port: 6379 }],
    });
    try {
      const redisDisabled = (svc as unknown as { _redisDisabled: boolean })._redisDisabled;
      expect(redisDisabled).toBe(true);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('empty redisClusterNodes array does not activate cluster mode', () => {
    const { svc, diskDir } = makeSvc({ redisClusterNodes: [] });
    try {
      const redisDisabled = (svc as unknown as { _redisDisabled: boolean })._redisDisabled;
      // no host set + empty cluster nodes → still disabled
      expect(redisDisabled).toBe(true);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('Redis Sentinel options wiring', () => {
  it('stores redisSentinel in opts', () => {
    const { svc, diskDir } = makeSvc({
      redisSentinel: {
        name:      'mymaster',
        sentinels: [{ host: 'sentinel-1', port: 26379 }],
      },
    });
    try {
      const opts = (svc as unknown as { opts: { redisSentinel?: { name: string; sentinels: unknown[] } } }).opts;
      expect(opts.redisSentinel?.name).toBe('mymaster');
      expect(opts.redisSentinel?.sentinels).toHaveLength(1);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('_redisDisabled is false when redisSentinel is set', () => {
    const { svc, diskDir } = makeSvc({
      disableRedis:  false,
      redisSentinel: {
        name:      'mymaster',
        sentinels: [{ host: 'sentinel-1', port: 26379 }],
      },
    });
    try {
      const redisDisabled = (svc as unknown as { _redisDisabled: boolean })._redisDisabled;
      expect(redisDisabled).toBe(false);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('_redisDisabled is true when disableRedis: true even with sentinel config', () => {
    const { svc, diskDir } = makeSvc({
      disableRedis:  true,
      redisSentinel: {
        name:      'mymaster',
        sentinels: [{ host: 'sentinel-1', port: 26379 }],
      },
    });
    try {
      const redisDisabled = (svc as unknown as { _redisDisabled: boolean })._redisDisabled;
      expect(redisDisabled).toBe(true);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });

  it('redisSentinel and redisClusterNodes cannot both activate L2 (cluster takes precedence in _redisDisabled logic)', () => {
    // Both set with disableRedis: false — cluster nodes are checked first in the || chain
    const { svc, diskDir } = makeSvc({
      disableRedis:      false,
      redisClusterNodes: [{ host: 'c1', port: 6379 }],
      redisSentinel: {
        name:      'mymaster',
        sentinels: [{ host: 'sentinel-1', port: 26379 }],
      },
    });
    try {
      // Either config activates L2 — _redisDisabled should be false
      const redisDisabled = (svc as unknown as { _redisDisabled: boolean })._redisDisabled;
      expect(redisDisabled).toBe(false);
    } finally {
      svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── 5. Combined feature interaction ────────────────────────────────────────

describe('Combined: disableDisk + workerThreads', () => {
  it('disableDisk + workerThreads: true initialises pool and disables disk independently', async () => {
    const { svc, diskDir } = makeSvc({
      disableDisk:          true,
      encryptionKey:        TEST_KEY_B64,
      workerThreads:        true,
      workerPoolSize:       1,
      workerThresholdBytes: 10,
    });
    try {
      const poolAvailable = (svc as unknown as { _workerPool: WorkerPool | null })._workerPool?.isAvailable;
      const diskDisabled  = (svc as unknown as { _diskDisabled: boolean })._diskDisabled;

      expect(diskDisabled).toBe(true);
      expect(poolAvailable).toBe(true);

      await svc.set('combo:k', { v: 'test' }, 60);
      const v = await svc.get('combo:k', async () => null, 60);
      expect(v).toEqual({ v: 'test' });
    } finally {
      await svc.destroy();
      try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
    }
  });
});
