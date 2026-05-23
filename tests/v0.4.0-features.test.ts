/**
 * v0.4.0 feature tests:
 *   1. TTL jitter (ttlJitterFactor)
 *   2. mset() / mdel() batch writes
 *   3. OpenTelemetry span integration (ICacheTracer)
 *   4. L2 circuit breaker
 *   5. warmFromL2(pattern)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CacheService } from '../src/cache-service';
import { CachePriority, type ICacheTracer, type ICacheSpan } from '../src/types';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';

function tempDir() {
  return join(tmpdir(), `tricache-v04-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeService(extra: Parameters<typeof CacheService.reset>[0] = {}) {
  const diskDir = tempDir();
  const svc = CacheService.reset({
    disableRedis: true,
    l1MaxEntries: 200,
    diskCacheDir: diskDir,
    ...extra,
  });
  return { svc, diskDir };
}

// ─── 1. TTL jitter ───────────────────────────────────────────────────────────

describe('TTL jitter (ttlJitterFactor)', () => {
  it('stores entries with a jittered TTL when factor > 0', async () => {
    const { svc, diskDir } = makeService({ ttlJitterFactor: 0.5 });
    afterEach(() => { svc.destroy(); try { rmSync(diskDir, { recursive: true, force: true }); } catch {} });

    const rawTtl = 100; // seconds
    const samples: number[] = [];

    // Sample 20 sets and collect the remaining TTL
    for (let i = 0; i < 20; i++) {
      const { svc: s, diskDir: d } = makeService({ ttlJitterFactor: 0.5 });
      await s.set(`k${i}`, 'v', rawTtl);
      const remaining = s.ttl(`k${i}`);
      if (remaining !== null) samples.push(remaining);
      s.destroy();
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }

    // With factor=0.5 the TTL is multiplied by (1 ± 0.5), so range is [50 s, 150 s]
    expect(samples.length).toBeGreaterThan(0);
    const allExact = samples.every(t => t === rawTtl);
    // With 20 samples the probability of all landing exactly at 100 s is essentially 0
    expect(allExact).toBe(false);
    for (const t of samples) {
      expect(t).toBeGreaterThanOrEqual(49);  // tiny float-rounding buffer
      expect(t).toBeLessThanOrEqual(151);
    }
  });

  it('stores entries with exact TTL when factor is 0 (default)', async () => {
    const { svc, diskDir } = makeService({ ttlJitterFactor: 0 });
    afterEach(() => { svc.destroy(); try { rmSync(diskDir, { recursive: true, force: true }); } catch {} });

    await svc.set('exact', 'v', 300);
    const remaining = svc.ttl('exact');
    // Should be exactly 300 s (or 299 due to sub-ms elapsed)
    expect(remaining).toBeGreaterThanOrEqual(299);
    expect(remaining).toBeLessThanOrEqual(300);
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('get() also jitters the fetch-path TTL', async () => {
    const samples: number[] = [];
    for (let i = 0; i < 15; i++) {
      const { svc: s, diskDir: d } = makeService({ ttlJitterFactor: 0.5 });
      await s.get(`k${i}`, async () => 'v', 100);
      const remaining = s.ttl(`k${i}`);
      if (remaining !== null) samples.push(remaining);
      s.destroy();
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    const allExact = samples.every(t => t === 100);
    expect(allExact).toBe(false);
  });
});

// ─── 2. mset() / mdel() ──────────────────────────────────────────────────────

describe('mset() / mdel()', () => {
  let svc: CacheService;
  let diskDir: string;

  beforeEach(() => ({ svc, diskDir } = makeService()));
  afterEach(() => {
    svc.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('mset() writes all entries into L1', async () => {
    await svc.mset({
      'user:1': { value: { name: 'Alice' }, ttl: 300 },
      'user:2': { value: { name: 'Bob'   }, ttl: 300 },
      'user:3': { value: { name: 'Carol' }, ttl: 300 },
    });

    expect(await svc.get('user:1', async () => null, 60)).toEqual({ name: 'Alice' });
    expect(await svc.get('user:2', async () => null, 60)).toEqual({ name: 'Bob'   });
    expect(await svc.get('user:3', async () => null, 60)).toEqual({ name: 'Carol' });
  });

  it('mset() respects per-entry TTL', async () => {
    await svc.mset({
      'short': { value: 'a', ttl: 10 },
      'long':  { value: 'b', ttl: 600 },
    });
    const shortTtl = svc.ttl('short');
    const longTtl  = svc.ttl('long');
    expect(shortTtl).toBeLessThanOrEqual(10);
    expect(longTtl).toBeGreaterThan(shortTtl!);
  });

  it('mset() respects per-entry priority', async () => {
    // We verify by checking the entry is stored; priority affects eviction not retrieval
    await svc.mset({
      'crit': { value: 'x', ttl: 60, priority: CachePriority.CRITICAL },
    });
    expect(svc.has('crit')).toBe(true);
  });

  it('mdel() removes all specified keys from L1', async () => {
    await svc.set('a', 1, 60);
    await svc.set('b', 2, 60);
    await svc.set('c', 3, 60);

    await svc.mdel(['a', 'b']);

    expect(svc.has('a')).toBe(false);
    expect(svc.has('b')).toBe(false);
    expect(svc.has('c')).toBe(true);
  });

  it('mdel() is a no-op for missing keys', async () => {
    await expect(svc.mdel(['does-not-exist'])).resolves.toBeUndefined();
  });

  it('mset() returns undefined (void)', async () => {
    const result = await svc.mset({ 'k': { value: 'v', ttl: 60 } });
    expect(result).toBeUndefined();
  });
});

// ─── 3. OpenTelemetry span integration ───────────────────────────────────────

describe('OpenTelemetry tracer (ICacheTracer)', () => {
  function makeTracer() {
    const spans: { name: string; attrs: Record<string, unknown>; ended: boolean }[] = [];
    const tracer: ICacheTracer = {
      startSpan(name) {
        const span = { name, attrs: {} as Record<string, unknown>, ended: false };
        spans.push(span);
        const s: ICacheSpan = {
          setAttribute(k, v) { span.attrs[k] = v; return s; },
          setStatus()        { return s; },
          end()              { span.ended = true; },
        };
        return s;
      },
    };
    return { tracer, spans };
  }

  let svc: CacheService;
  let diskDir: string;

  afterEach(() => {
    svc?.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('records a span for get() with cache.hit = miss on cold cache', async () => {
    const { tracer, spans } = makeTracer();
    ({ svc, diskDir } = makeService({ tracer }));

    await svc.get('user:1', async () => 'val', 60);

    const span = spans.find(s => s.name === 'tricache.get');
    expect(span).toBeDefined();
    expect(span!.attrs['cache.hit']).toBe('miss');
    expect(span!.attrs['cache.key_prefix']).toBe('user');
    expect(span!.ended).toBe(true);
  });

  it('records cache.hit = l1 on a warm hit', async () => {
    const { tracer, spans } = makeTracer();
    ({ svc, diskDir } = makeService({ tracer }));

    await svc.set('user:2', 'val', 60);
    spans.length = 0; // clear the set() span

    await svc.get('user:2', async () => 'other', 60);

    const span = spans.find(s => s.name === 'tricache.get');
    expect(span!.attrs['cache.hit']).toBe('l1');
  });

  it('records a span for set()', async () => {
    const { tracer, spans } = makeTracer();
    ({ svc, diskDir } = makeService({ tracer }));

    await svc.set('product:1', 'data', 60);

    const span = spans.find(s => s.name === 'tricache.set');
    expect(span).toBeDefined();
    expect(span!.attrs['cache.key_prefix']).toBe('product');
    expect(span!.ended).toBe(true);
  });

  it('records a span for delete()', async () => {
    const { tracer, spans } = makeTracer();
    ({ svc, diskDir } = makeService({ tracer }));

    await svc.set('order:1', 'v', 60);
    spans.length = 0;

    await svc.delete('order:1');

    const span = spans.find(s => s.name === 'tricache.delete');
    expect(span).toBeDefined();
    expect(span!.attrs['cache.key_prefix']).toBe('order');
    expect(span!.ended).toBe(true);
  });

  it('works without a tracer (no-op span — no error)', async () => {
    ({ svc, diskDir } = makeService());
    await expect(svc.get('k', async () => 'v', 60)).resolves.toBe('v');
  });
});

// ─── 4. L2 circuit breaker ───────────────────────────────────────────────────

describe('L2 circuit breaker', () => {
  let svc: CacheService;
  let diskDir: string;

  afterEach(() => {
    svc?.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('starts in closed state', () => {
    ({ svc, diskDir } = makeService());
    const m = svc.metrics();
    expect(m.l2CircuitBreaker.state).toBe('closed');
  });

  it('circuit breaker state is exposed in metrics', () => {
    ({ svc, diskDir } = makeService({
      l2CircuitBreakerThreshold: 3,
      l2CircuitBreakerCooldownMs: 5_000,
    }));
    const m = svc.metrics();
    // Redis is disabled in tests, so no failures — stays closed
    expect(m.l2CircuitBreaker.state).toBe('closed');
  });

  it('transitions through open → half_open after cooldown', async () => {
    // Spy on getRedis to simulate it being called: we can observe circuit
    // breaker behaviour by inspecting state via metrics() after forcing failures.
    // We unit-test the L2CircuitBreaker class logic via the service directly.
    // Since Redis is disabled in test, we instead test by calling the private cb
    // methods by accessing them indirectly through a known public surface.

    // Access circuit breaker via any cast so we can drive it without Redis
    const { svc: s, diskDir: d } = makeService({
      l2CircuitBreakerThreshold:  2,
      l2CircuitBreakerCooldownMs: 50, // short cooldown for test
    });
    diskDir = d; svc = s;

    const cb = (s as unknown as { cb: { onFailure(): void; onSuccess(): void; isOpen: boolean; currentState: string } }).cb;

    // Force two failures to open the circuit
    cb.onFailure();
    cb.onFailure();
    expect(cb.isOpen).toBe(true);
    expect(cb.currentState).toBe('open');
    expect(s.metrics().l2CircuitBreaker.state).toBe('open');

    // Wait for cooldown then check it transitions to half_open on next probe
    await new Promise(r => setTimeout(r, 60));
    // isAllowed() triggers the OPEN→HALF_OPEN transition
    const allowed = (s as unknown as { cb: { isAllowed(): boolean } }).cb.isAllowed();
    expect(allowed).toBe(true);
    expect(cb.currentState).toBe('half_open');

    // A success resets to closed
    cb.onSuccess();
    expect(cb.currentState).toBe('closed');
    expect(cb.isOpen).toBe(false);
  });

  it('re-opens immediately on failure during half_open probe', () => {
    const { svc: s, diskDir: d } = makeService({
      l2CircuitBreakerThreshold:  1,
      l2CircuitBreakerCooldownMs: 60_000,
    });
    diskDir = d; svc = s;

    const cb = (s as unknown as { cb: { onFailure(): void; currentState: string; isAllowed(): boolean } }).cb;
    cb.onFailure(); // open
    // Manually set to half_open by expiring cooldown via time — not feasible without
    // fake timers, so drive onFailure from half_open via internal state hack.
    // Instead: verify that a failure in half_open state re-opens
    const cbFull = (s as unknown as { cb: { state: number; openedAt: number } }).cb;
    cbFull.state    = 2; // CBState.HALF_OPEN = 2
    cbFull.openedAt = Date.now() - 1;
    cb.onFailure();
    expect(cb.currentState).toBe('open');
  });
});

// ─── 5. warmFromL2(pattern) ──────────────────────────────────────────────────

describe('warmFromL2(pattern)', () => {
  let svc: CacheService;
  let diskDir: string;

  afterEach(() => {
    svc?.destroy();
    try { rmSync(diskDir, { recursive: true, force: true }); } catch {}
  });

  it('returns 0 immediately when Redis is disabled', async () => {
    ({ svc, diskDir } = makeService({ disableRedis: true }));
    const count = await svc.warmFromL2('user:*');
    expect(count).toBe(0);
  });

  it('returns 0 and does not throw when Redis is unavailable', async () => {
    ({ svc, diskDir } = makeService({
      disableRedis: false,
      redisHost:    '127.0.0.1',
      redisPort:    19999, // nothing listening here
    }));
    await expect(svc.warmFromL2('user:*')).resolves.toBe(0);
  });
});
