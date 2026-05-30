/**
 * tricache — comprehensive benchmark & concurrency analysis
 *
 * Run:  pnpm bench
 *
 * What this measures
 * ──────────────────
 *  1. Raw L1 throughput: hot hits, cold misses, set (small/large/CRITICAL)
 *  2. Bloom-filter overhead: definite miss vs actual set/get
 *  3. Compression cost: entry size classes crossing the 512-byte boundary
 *  4. CacheService end-to-end: L1 hit, miss→fetch, SWR, stampede coalescing
 *  5. Concurrency & "thread locking":
 *       - Serial  vs Parallel throughput (Promise.all fan-out)
 *       - Inflight-map contention: N coroutines hitting the SAME key
 *       - Inflight-map fan-out: N coroutines hitting DISTINCT keys
 *       - Mixed read/write ratio sweeps (100/0 → 0/100)
 *  6. Eviction pressure: what happens when L1 fills up
 *  7. OOM guard eviction latency
 *  8. delete / glob-delete cost
 *  9. metrics() snapshot overhead
 *  10. AES-256-GCM, AES-128-GCM, AES-128-CTR, XOR encryption overhead
 * 11. Realistic workload simulation (80/15/5 read/miss/write)
 * 12. Multi-tenancy: category competition (user: HIGH vs analytics: LOW)
 *     and namespace isolation (org_a vs org_b independent throughput)
 * 17. Adaptive TTL: LatencyTracker ring-buffer overhead on warm-hit, fetch,
 *     and metrics() snapshot paths — compares enabled vs disabled baseline
 *
 * Concurrency notes printed inline explain whether an operation is truly
 * concurrent, where the "lock" is (the inflight Map), and which path wins.
 */

import { CacheService }                 from '../src/cache-service';
import { SmartMemoryCache }             from '../src/smart-memory-cache';
import { CacheEncryption }              from '../src/encryption';
import { CachePriority, consoleLogger } from '../src/types';
import os   from 'os';
import path from 'path';
import { rmSync, mkdtempSync } from 'fs';
import { performance as nodePerf } from 'node:perf_hooks';
import crypto from 'crypto';

// ─── ANSI colour helpers ──────────────────────────────────────────────────────

const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
};

// ─── Formatting helpers ───────────────────────────────────────────────────────

const COL_LABEL = 52;
const COL_OPS   = 18;
const COL_LAT   = 14;

function pad(s: string, n: number, right = false): string {
  return right ? s.padStart(n) : s.padEnd(n);
}

function fmtOps(opsPerSec: number): string {
  if (opsPerSec >= 1_000_000) return `${(opsPerSec / 1_000_000).toFixed(2)} M/s`;
  if (opsPerSec >= 1_000)     return `${(opsPerSec /     1_000).toFixed(1)} K/s`;
  return `${opsPerSec} /s`;
}

function fmtLat(nsPerOp: number): string {
  if (nsPerOp >= 1_000_000) return `${(nsPerOp / 1_000_000).toFixed(2)} ms`;
  if (nsPerOp >= 1_000)     return `${(nsPerOp /     1_000).toFixed(2)} µs`;
  return `${nsPerOp.toFixed(0)} ns`;
}

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  if (b >= 1024)        return `${(b / 1024).toFixed(1)} KB`;
  return `${b} B`;
}

function speedColour(opsPerSec: number): string {
  if (opsPerSec >= 5_000_000) return C.green;
  if (opsPerSec >= 1_000_000) return C.cyan;
  if (opsPerSec >= 100_000)   return C.yellow;
  return C.red;
}

function row(label: string, opsPerSec: number, nsPerOp: number, note = ''): void {
  const ops  = `${speedColour(opsPerSec)}${pad(fmtOps(opsPerSec), COL_OPS, true)}${C.reset}`;
  const lat  = `${C.dim}${pad(fmtLat(nsPerOp), COL_LAT, true)}${C.reset}`;
  const lbl  = pad(label, COL_LABEL);
  const ann  = note ? `  ${C.gray}${note}${C.reset}` : '';
  console.log(`  ${lbl}${ops}  ${lat}${ann}`);
}

function header(title: string): void {
  console.log(`\n${C.bold}${C.blue}  ▸ ${title}${C.reset}`);
  console.log(`  ${C.dim}${'─'.repeat(COL_LABEL + COL_OPS + COL_LAT + 4)}${C.reset}`);
}

function note(msg: string): void {
  console.log(`  ${C.yellow}ℹ${C.reset}  ${C.dim}${msg}${C.reset}`);
}

function divider(): void {
  console.log(`  ${C.dim}${'─'.repeat(COL_LABEL + COL_OPS + COL_LAT + 4)}${C.reset}`);
}

// ─── Core bench runner ────────────────────────────────────────────────────────

interface BenchResult {
  opsPerSec: number;
  nsPerOp:   number;
  totalMs:   number;
}

async function bench(
  label:      string,
  fn:         (i: number) => Promise<void> | void,
  iters     = 100_000,
  warmup    = Math.min(Math.ceil(iters / 10), 2_000),
  annotation = '',
): Promise<BenchResult> {
  for (let i = 0; i < warmup; i++) await fn(i);

  const start = performance.now();
  for (let i = 0; i < iters; i++) await fn(i);
  const totalMs = performance.now() - start;

  const opsPerSec = Math.round((iters / totalMs) * 1000);
  const nsPerOp   = (totalMs / iters) * 1_000_000;

  row(label, opsPerSec, nsPerOp, annotation);
  return { opsPerSec, nsPerOp, totalMs };
}

/** Parallel batch: fire N concurrent promises per batch */
async function benchParallel(
  label:       string,
  fn:          (i: number) => Promise<void>,
  concurrency: number,
  batches:     number,
  annotation = '',
): Promise<BenchResult> {
  for (let i = 0; i < Math.min(batches / 5, 100); i++) {
    await Promise.all(Array.from({ length: concurrency }, (_, j) => fn(i * concurrency + j)));
  }

  const totalOps = batches * concurrency;
  const start    = performance.now();
  for (let i = 0; i < batches; i++) {
    await Promise.all(Array.from({ length: concurrency }, (_, j) => fn(i * concurrency + j)));
  }
  const totalMs = performance.now() - start;

  const opsPerSec = Math.round((totalOps / totalMs) * 1000);
  const nsPerOp   = (totalMs / totalOps) * 1_000_000;

  row(label, opsPerSec, nsPerOp, annotation);
  return { opsPerSec, nsPerOp, totalMs };
}

// ─── Percentile latency helpers ───────────────────────────────────────────────

interface PercentileResult {
  opsPerSec: number;
  nsPerOp:   number;  // mean
  p50:       number;
  p95:       number;
  p99:       number;
  max:       number;
}

/**
 * Measures latency distribution (p50/p95/p99/max) by timing *batches* of
 * `batchSize` iterations and dividing.  Batching is essential for sub-µs
 * operations: a single 350 ns call measured with performance.now() (≈0.1 µs
 * resolution) produces noise-dominated data.  Batching 100 ops gives a
 * ~35 µs measurement that is accurate to < 1 %.
 *
 * Prints the mean row in the same column format as bench(), plus a second
 * indented line showing p50 / p95 / p99 / max.
 */
async function percentileBench(
  label:      string,
  fn:         (i: number) => Promise<void> | void,
  samples   = 2_000,
  batchSize = 100,
  warmup    = 500,
  annotation = '',
): Promise<PercentileResult> {
  for (let i = 0; i < warmup; i++) await fn(i);

  const ns = new Float64Array(samples);
  let base = warmup;
  for (let s = 0; s < samples; s++) {
    const t0 = performance.now();
    for (let b = 0; b < batchSize; b++) await fn(base++);
    ns[s] = ((performance.now() - t0) / batchSize) * 1_000_000; // ns per op
  }

  ns.sort(); // in-place sort for O(1) percentile indexing
  const mean      = ns.reduce((a, b) => a + b, 0) / samples;
  const opsPerSec = Math.round(1_000_000_000 / mean);
  const p50 = ns[Math.floor(samples * 0.50)];
  const p95 = ns[Math.floor(samples * 0.95)];
  const p99 = ns[Math.floor(samples * 0.99)];
  const max = ns[samples - 1];

  row(label, opsPerSec, mean, annotation);
  const indent = ' '.repeat(COL_LABEL + 4);
  console.log(
    `  ${indent}${C.dim}` +
    `p50 ${fmtLat(p50).padStart(9)}  ` +
    `p95 ${fmtLat(p95).padStart(9)}  ` +
    `p99 ${fmtLat(p99).padStart(9)}  ` +
    `max ${fmtLat(max).padStart(9)}${C.reset}`,
  );
  return { opsPerSec, nsPerOp: mean, p50, p95, p99, max };
}

/**
 * Runs `fn` for `durationMs` milliseconds, recording ops/s in `windowMs`
 * buckets.  Reports mean / min / max throughput and the coefficient of
 * variation (CV = σ/μ):
 *   CV < 5 %  → stable  (green)  — GC / JIT overhead well amortised
 *   CV 5–15 % → jitter  (yellow) — occasional GC pause or eviction spike
 *   CV > 15 % → unstable (red)   — investigate heap growth or eviction
 */
async function soakBench(
  label:      string,
  fn:         (i: number) => Promise<void> | void,
  durationMs = 10_000,
  windowMs   = 1_000,
  annotation = '',
): Promise<void> {
  for (let i = 0; i < 2_000; i++) await fn(i);

  const windows: number[] = [];
  let iter   = 2_000;
  let wStart = performance.now();
  let wOps   = 0;
  const dead = performance.now() + durationMs;

  while (performance.now() < dead) {
    await fn(iter++);
    wOps++;
    const now = performance.now();
    if (now - wStart >= windowMs) {
      windows.push((wOps / (now - wStart)) * 1_000);
      wOps   = 0;
      wStart = now;
    }
  }

  if (windows.length < 2) return;

  const mean   = windows.reduce((a, b) => a + b, 0) / windows.length;
  const minW   = Math.min(...windows);
  const maxW   = Math.max(...windows);
  const stddev = Math.sqrt(windows.reduce((a, b) => a + (b - mean) ** 2, 0) / windows.length);
  const cv     = stddev / mean;
  const cvCol  = cv < 0.05 ? C.green : cv < 0.15 ? C.yellow : C.red;
  const ann    = annotation ? `  ${C.gray}${annotation}${C.reset}` : '';
  console.log(
    `  ${pad(label, COL_LABEL)}${C.dim}` +
    `avg ${fmtOps(mean).padStart(10)}  ` +
    `min ${fmtOps(minW).padStart(10)}  ` +
    `max ${fmtOps(maxW).padStart(10)}  ` +
    `${C.reset}CV ${cvCol}${(cv * 100).toFixed(1)}%${C.reset}${ann}`,
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

// Duration for the stability soak. Override with SOAK_MS=60000 pnpm bench
// for a 1-minute soak; use SOAK_MS=3600000 for a proper 1-hour stress run.
const SOAK_DURATION_MS = Number(process.env['SOAK_MS'] ?? 10_000);
// Window granularity. Smaller = more GC pause visibility.
//   1000 ms (default): clean summary, GC pauses washed out into window mean
//    100 ms: a single 20 ms major-GC pause shows as a ~20 % dip — clearly visible in CV
//     50 ms: highest resolution; min/max capture individual pause spikes
const SOAK_WINDOW_MS   = Number(process.env['SOAK_WINDOW_MS'] ?? 1_000);

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'tricache-bench-'));
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ } }
}

// Standalone L1 (pure RAM, no disk spill, no Redis)
const l1 = new SmartMemoryCache({
  maxBytes:   400 * 1024 * 1024,
  maxEntries: 50_000,
  categories: {
    default:   { maxEntries: 50_000, maxSizeBytes: 400 * 1024 * 1024 },
    analytics: { maxEntries: 10_000, maxSizeBytes: 100 * 1024 * 1024 },
  },
  logger: consoleLogger,
});

const benchDir = makeTempDir();

// CacheService instance (Redis disabled — local tiers only)
const svc = CacheService.reset({
  disableRedis:       true,
  oomProtection:      false,  // disable OOM timer to avoid interference
  metricsIntervalMs:  0,      // no background metrics tick
  l1MaxBytes:         400 * 1024 * 1024,
  l1MaxEntries:       50_000,
  diskCacheDir:       benchDir,
});

// ─────────────────────────────────────────────────────────────────────────────
//  1. Raw L1 throughput
// ─────────────────────────────────────────────────────────────────────────────

header('L1 SmartMemoryCache — raw throughput');
note('Single-threaded JS. No await. These numbers are your absolute ceiling.');

// Pool sizes are powers of 2 so the hot path can use a bitwise AND mask instead of
// integer modulo. `i % n` requires a full CPU division; `i & MASK` is a single AND
// instruction that V8's JIT emits inline without a helper call.
const hotKeys     = Array.from({ length: 8_192 }, (_, i) => `hot:${i}`);
const coldKeys    = Array.from({ length: 4_096 }, (_, i) => `never:${i}`);
const tinyKeys    = Array.from({ length: 4_096 }, (_, i) => `s:${i}`);
const tinyVals    = Array.from({ length: 4_096 }, (_, i) => ({ n: i }));
const smallKeys   = Array.from({ length: 4_096 }, (_, i) => `b:${i}`);
const smallVal    = { d: 'a'.repeat(480), n: 0 };
const largeKeys   = Array.from({ length: 4_096 }, (_, i) => `l:${i}`);
const largeVal    = { data: 'y'.repeat(2_048), rows: Array.from({ length: 20 }, (_, k) => ({ id: k })) };
const critKeys    = Array.from({ length: 1_024 }, (_, i) => `auth:tok:${i}`);
const critVal     = { token: 'x'.repeat(40) };
const patternPool = Array.from({ length:   128 }, (_, i) => `s:${i}*`);

// Precomputed masks (pool.length - 1, valid because sizes are powers of 2)
const HOT_MASK  = hotKeys.length     - 1;  // 0x1FFF = 8191
const COLD_MASK = coldKeys.length    - 1;  // 0x0FFF = 4095
const KEY_MASK  = tinyKeys.length    - 1;  // 0x0FFF = 4095 — shared for tiny/small/large
const CRIT_MASK = critKeys.length    - 1;  // 0x03FF = 1023
const PAT_MASK  = patternPool.length - 1;  // 0x007F = 127

for (let i = 0; i < hotKeys.length; i++) {
  l1.set(hotKeys[i], { id: i, payload: 'x'.repeat(32) }, 60_000, CachePriority.NORMAL);
}

await bench('get — hot hit (8 K resident entries)', i => {
  l1.get(hotKeys[i & HOT_MASK]);
}, 500_000, 5_000, 'bloom → Map lookup');

await bench('get — cold miss (key never set)', i => {
  l1.get(coldKeys[i & COLD_MASK]);
}, 500_000, 5_000, 'bloom gates → early return');

await bench('set — tiny  payload (always pack())', i => {
  l1.set(tinyKeys[i & KEY_MASK], tinyVals[i & KEY_MASK], 60_000);
}, 200_000, 2_000, 'pack() + Map.set + bloom.add');

await bench('set — small payload (≈ 512B)', i => {
  l1.set(smallKeys[i & KEY_MASK], smallVal, 60_000);
}, 100_000, 1_000, 'pack() — same unified path as tiny, larger payload');

await bench('set — large (≥ 512B, msgpackr compress)', i => {
  l1.set(largeKeys[i & KEY_MASK], largeVal, 60_000);
}, 100_000, 1_000, 'pack() + byte-size estimate');

await bench('set — CRITICAL priority (never evicted)', i => {
  l1.set(critKeys[i & CRIT_MASK], critVal, 300_000, CachePriority.CRITICAL);
}, 100_000, 1_000, 'same path as NORMAL but skipped in eviction sort');

await bench('delete — exact key', i => {
  l1.delete(hotKeys[i & HOT_MASK]);
}, 100_000, 1_000, 'Map.delete (bloom has no remove)');

await bench('deletePattern — glob wildcard', i => {
  l1.deletePattern(patternPool[i & PAT_MASK]);
}, 20_000, 200, 'full Map scan — O(n) linear');

// ─────────────────────────────────────────────────────────────────────────────
//  2. Bloom filter cost breakdown
// ─────────────────────────────────────────────────────────────────────────────

header('Bloom filter — cost breakdown');
note('Bloom is O(k) per op (k=7 hash rounds). A definite-miss avoids a Map lookup entirely.');
note('False positives still trigger a Map.get() that returns undefined — wasted work.');

// Pre-compute pools to eliminate string allocation on the hot path.
const bfHotKeys  = Array.from({ length: 8_192 }, (_, i) => `bf:${i}`);
const bfMissKeys = Array.from({ length: 4_096 }, (_, i) => `bloom-miss:novel-${i}`);
const BF_HOT_MASK  = bfHotKeys.length  - 1;  // 8191
const BF_MISS_MASK = bfMissKeys.length - 1;  // 4095

for (let i = 0; i < bfHotKeys.length; i++) l1.set(bfHotKeys[i], i, 60_000);

await bench('get — definite miss (novel key, never set)', i => {
  l1.get(bfMissKeys[i & BF_MISS_MASK]);
}, 500_000, 5_000, '7 hash rounds → bit check → return null');

await bench('get — hit path (key confirmed in bloom)', i => {
  l1.get(bfHotKeys[i & BF_HOT_MASK]);
}, 500_000, 5_000, '7 hash rounds → Map.get → return cached value');

// ─────────────────────────────────────────────────────────────────────────────
//  3. Compression cost vs savings
// ─────────────────────────────────────────────────────────────────────────────

header('Serialization — msgpackr pack() throughput by payload size');
note('All payloads serialized via msgpackr pack() — no JSON path at any size.');
note('Throughput falls with payload size: pack() must encode more bytes per call.');

for (const sz of [128, 256, 512, 1_024, 4_096, 16_384] as const) {
  const val     = { payload: 'z'.repeat(sz), id: 42 };
  const cmpKeys = Array.from({ length: 2_048 }, (_, i) => `cmp:${sz}:${i}`);
  const CMP_MASK = cmpKeys.length - 1;  // 2047
  await bench(
    `set ${String(sz).padStart(6)}B payload`,
    i => { l1.set(cmpKeys[i & CMP_MASK], val, 60_000); },
    50_000, 500,
    'pack() path',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  4. CacheService end-to-end paths
// ─────────────────────────────────────────────────────────────────────────────

header('CacheService — end-to-end path costs');
note('Each get() adds: namespace prefix + inflight-Map check + L1/disk/L2 lookup chain.');

await svc.set('e2e:warm', { v: 1 }, 300);

await bench('get — L1 warm hit (no fetchFn call)', async () => {
  await svc.get('e2e:warm', async () => ({ v: 1 }), 300);
}, 100_000, 1_000, 'inflight check → l1.get → return');

let fetchCalls = 0;
await bench('get — L1 miss → fetchFn (TTL=0)', async i => {
  await svc.get(`miss:e2e:${i}`, async () => ({ fetched: ++fetchCalls }), 0);
}, 10_000, 100, 'Promise microtask + l1.set on fill');

// SWR: serve stale immediately + revalidate in background
await svc.set('swr:key', { stale: true }, 300);
await new Promise(r => setTimeout(r, 5));
let swrFetches = 0;
await bench('get — SWR stale serve + bg revalidate', async () => {
  await svc.get('swr:key', async () => ({ fresh: ++swrFetches }), 300);
}, 20_000, 200, 'serves stale instantly; revalidate is non-blocking');

await bench('set — CacheService.set()', async i => {
  await svc.set(`set:e2e:${i % 2_000}`, { n: i }, 60);
}, 50_000, 500, 'l1.set + disk.save (async, fire-and-forget)');

await bench('delete — exact key', async i => {
  await svc.delete(`set:e2e:${i % 2_000}`);
}, 50_000, 500, 'l1.delete + disk.delete + backplane (no-op, Redis off)');

await bench('delete — glob *', async i => {
  await svc.delete(`set:e2e:${i % 50}*`);
}, 5_000, 50, 'l1.deletePattern O(n) + disk glob scan');

// ─────────────────────────────────────────────────────────────────────────────
//  5. Concurrency & "thread locking" analysis
// ─────────────────────────────────────────────────────────────────────────────

header('Concurrency — serial vs parallel, and the inflight-Map "lock"');
note('Node.js is SINGLE-THREADED. No OS threads, no mutexes, no true parallelism.');
note('Concurrency = Promise.all() — all coroutines share the same event-loop thread.');
note('"Lock" in tricache = the inflight Map:');
note('  First getter creates a Promise and stores it. All later callers attach .then().');
note('  fetchFn fires EXACTLY ONCE. All waiters get the same result when it resolves.');
note('  There is no blocking — the "lock holder" simply registered first on the Map.');
note('');
note('What to look for:');
note('  parallel CPU ≈ serial CPU → bottleneck is JS execution (single-threaded, expected)');
note('  parallel I/O > serial I/O → event-loop overlap: multiple awaits resolve per tick');

// ── 5a. Same-key contention (inflight-Map coalescing) ──────────────────────

header('  5a. Same-key contention — inflight-Map coalescing');
note('  All N coroutines race to get the SAME key simultaneously.');
note('  The first one to see a miss creates an inflight Promise (the "lock").');
note('  All others attach .then() to it — they never call fetchFn.');
note('  fetchFn should fire EXACTLY ONCE regardless of fan-out.');

// Drain fire-and-forget disk writes from sections 1–4 before timing the coalescing loop.
// Without this, fan=2 absorbs the entire libuv I/O-callback backlog (making it look slow)
// while fan=5+ run on an already-empty queue and appear fast.
await new Promise<void>(r => setTimeout(r, 100));

for (const fan of [2, 5, 10, 50, 100]) {
  const k = `contention:fan${fan}`;
  let calls = 0;
  await svc.delete(k);

  const start  = performance.now();
  const batch  = Array.from({ length: fan }, (_, j) =>
    svc.get(k, async () => {
      calls++;
      await new Promise<void>(r => setTimeout(r, 1)); // simulate 1 ms I/O
      return { winner: j };
    }, 300)
  );
  await Promise.all(batch);
  const ms = performance.now() - start;

  const coalesced  = fan - calls;
  const efficiency = ((coalesced / (fan - 1)) * 100).toFixed(0);
  console.log(
    `  ${C.dim}  fan=${String(fan).padStart(3)}: fetchFn called ${calls}×,` +
    ` ${coalesced} coalesced, ${ms.toFixed(1)} ms wall-time,` +
    ` coalescing efficiency ${efficiency}%${C.reset}`
  );
}
note('  100% coalescing efficiency = inflight map working perfectly.');
note('  <100% means some coroutines saw an empty inflight map (key expired mid-flight).');

// ── 5b. Distinct-key parallel fan-out ──────────────────────────────────────

header('  5b. Distinct-key parallel fan-out — no coalescing possible');
note('  Each coroutine hits a DIFFERENT key. No inflight sharing possible.');
note('  All N fetchFns fire concurrently. Throughput reveals event-loop concurrency.');

const serialCpu = await bench(
  '  Serial   — CPU fetch (no await), 1 key/call',
  async i => { await svc.get(`cpu:s:${i}`, async () => ({ x: Math.sqrt(i) }), 30); },
  5_000, 100, 'sequential event-loop ticks',
);

const parallelCpu = await benchParallel(
  '  Parallel — CPU fetch, 20 concurrent keys',
  async i => { await svc.get(`cpu:p:${i}`, async () => ({ x: Math.sqrt(i) }), 30); },
  20, 250, 'all fire, JS still single-threaded',
);

console.log(
  `  ${C.dim}  CPU-bound parallel/serial ratio: ` +
  `${(parallelCpu.opsPerSec / serialCpu.opsPerSec).toFixed(2)}× ` +
  `— expect ~1.0 (no I/O to overlap)${C.reset}`
);

const serialIo = await bench(
  '  Serial   — I/O fetch (setTimeout 0), 1 key/call',
  async i => {
    await svc.get(`io:s:${i}`, async () => {
      await new Promise<void>(r => setTimeout(r, 0));
      return { x: i };
    }, 30);
  },
  2_000, 50, 'sequential: each waits for previous I/O to settle',
);

const parallelIo = await benchParallel(
  '  Parallel — I/O fetch, 20 concurrent keys',
  async i => {
    await svc.get(`io:p:${i}`, async () => {
      await new Promise<void>(r => setTimeout(r, 0));
      return { x: i };
    }, 30);
  },
  20, 100, 'concurrent: all I/O callbacks queue in same tick',
);

console.log(
  `  ${C.dim}  I/O-bound parallel/serial ratio: ` +
  `${(parallelIo.opsPerSec / serialIo.opsPerSec).toFixed(2)}× ` +
  `— expect >1.0 (I/O overlap across Promise.all)${C.reset}`
);

// ── 5c. Mixed read/write ratio sweep ──────────────────────────────────────

header('  5c. Mixed read/write ratio sweep (10 concurrent, 3000 batches each)');
note('  set() is NOT deduplicated by the inflight map — every set touches the Map.');
note('  Higher write ratio = more Map.set mutations = lower overall throughput.');
note('  This reveals whether your workload is write-bound or read-bound.');

const ratios: Array<[string, number]> = [
  ['100% reads /   0% writes', 0.00],
  [' 95% reads /   5% writes', 0.05],
  [' 80% reads /  20% writes', 0.20],
  [' 50% reads /  50% writes', 0.50],
  [' 20% reads /  80% writes', 0.80],
  ['  0% reads / 100% writes', 1.00],
];

for (const [label, writeRatio] of ratios) {
  await benchParallel(
    `  ${label}`,
    async i => {
      if (Math.random() < writeRatio) {
        await svc.set(`mix:${i % 500}`, { n: i }, 60);
      } else {
        await svc.get(`mix:${i % 500}`, async () => ({ n: i }), 60);
      }
    },
    10, 3_000,
    writeRatio === 0   ? 'pure reads — no Map mutations'
    : writeRatio === 1 ? 'all writes — max Map mutation overhead'
    : '',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  6. Eviction pressure
// ─────────────────────────────────────────────────────────────────────────────

header('Eviction pressure — L1 over-capacity behaviour');
note('Eviction is triggered when entries > maxEntries or sizeBytes > maxBytes.');
note('Now uses reservoir sampling: O(n) pass + O(16 log 16) sort instead of O(n log n) full sort.');
note('At small n the dominant cost is synchronous msgpackr pack() per spill (before first await).');
note('Evicted entries spill to disk asynchronously (fire-and-forget, non-blocking).');

const evictDir = makeTempDir();
const tightSvc = CacheService.reset({
  disableRedis:  true,
  oomProtection: false,
  l1MaxEntries:  200,
  l1MaxBytes:    2 * 1024 * 1024,
  diskCacheDir:  evictDir,
});

for (let i = 0; i < 100; i++) await tightSvc.set(`evict:pre:${i}`, { i }, 300);

const headroomRes = await bench(
  'set — L1 has headroom (no eviction)',
  async i => { await tightSvc.set(`evict:ok:${i % 50}`, { n: i }, 300); },
  10_000, 100, 'fast path: capacity check passes, Map.set only',
);

for (let i = 0; i < 200; i++) await tightSvc.set(`evict:fill:${i}`, { i }, 300);

const evictRes = await bench(
  'set — L1 full, eviction on every set',
  async i => { await tightSvc.set(`evict:over:${i}`, { n: i, data: 'z'.repeat(256) }, 300); },
  5_000, 50, 'O(catSize) categoryKeys scan + O(16 log 16) sort; Phase 2 skipped when catOvf',
);

console.log(
  `  ${C.dim}  Eviction overhead: ${(evictRes.nsPerOp / headroomRes.nsPerOp).toFixed(1)}× slower than headroom path${C.reset}`
);
note('If eviction is >10× slower: increase maxEntries to reduce pressure.');
note('Prefer exact-key deletes over relying on eviction for hot-key churn.');

await tightSvc.destroy();

// ─────────────────────────────────────────────────────────────────────────────
//  6b. Latency distributions — p50 / p95 / p99 / max under key scenarios
// ─────────────────────────────────────────────────────────────────────────────
//
// Mean (avg) hides spikes.  p99 and max reveal GC pauses, eviction bursts,
// and JIT deoptimisations — the "scary bugs" in production cache systems.
//
// Batching strategy:
//   Sub-µs ops (L1 get ≈ 350 ns) are timed in batches of 100.
//   Each recorded sample = (batch wall-time / 100), giving < 1 % error.
//   Slower async ops (set with disk spill) use smaller batches (5–10) to
//   avoid one outlier poisoning the whole sample.
//

header('Latency distributions — p50/p95/p99/max under key scenarios');
note('mean = batch-timed average.  Each row → p50 / p95 / p99 / max on the sub-row below.');
note('Scenario A: L1 hot get — tight distribution expected; max should be < 5× p50.');
note('Scenario B: CacheService set, headroom — async disk.save() adds tail; p99 ≈ µs range.');
note('Scenario C: CacheService set, full L1 — reservoir eviction shows up as p99/max spike.');

{
  const pdDir1 = makeTempDir();
  const pdDir2 = makeTempDir();

  // ── A. L1 hot get ───────────────────────────────────────────────────────
  // Uses the global `l1` instance which already has entries from §1.
  // Keys rotate over 1 024 entries so L1 stays hot (no eviction).
  const pdHotKeys = Array.from({ length: 1_024 }, (_, i) => `pd:hot:${i}`);
  for (const k of pdHotKeys) l1.set(k, { n: 1 }, 120_000);
  const PD_MASK = pdHotKeys.length - 1;

  await percentileBench(
    'L1 get — hot hit, headroom',
    i => { l1.get(pdHotKeys[i & PD_MASK]); },
    2_000, 100, 500,
    'bloom + Map.get; tight distribution expected — no eviction',
  );

  // ── B. CacheService set with headroom ───────────────────────────────────
  const pdSvcHead = CacheService.reset({
    disableRedis: true, oomProtection: false,
    l1MaxEntries: 50_000, l1MaxBytes: 400 * 1024 * 1024,
    diskCacheDir: pdDir1,
  });
  for (let i = 0; i < 100; i++) await pdSvcHead.set(`pds:pre:${i}`, { n: i }, 300);

  await percentileBench(
    'CacheService set — L1 headroom',
    async i => { await pdSvcHead.set(`pds:h:${i % 1_000}`, { n: i }, 300); },
    1_000, 10, 100,
    'pack + Map.set + async disk.save; p99 shows disk-write tail',
  );

  // ── C. CacheService set under full L1 ───────────────────────────────────
  // L1 is deliberately sized to 200 entries so eviction fires on every set.
  // Eviction = O(catSize) scan + reservoir sort — p99/max spikes reveal cost.
  const pdSvcFull = CacheService.reset({
    disableRedis: true, oomProtection: false,
    l1MaxEntries: 200, l1MaxBytes: 2 * 1024 * 1024,
    diskCacheDir: pdDir2,
  });
  for (let i = 0; i < 200; i++) await pdSvcFull.set(`pds:fill:${i}`, { n: i }, 300);

  await percentileBench(
    'CacheService set — L1 full, eviction every set',
    async i => { await pdSvcFull.set(`pds:ov:${i}`, { n: i, data: 'z'.repeat(64) }, 300); },
    800, 5, 50,
    'reservoir sort on every set; p99/max spike = eviction + disk spill',
  );

  note('p99/max >> p50 on the eviction path is expected — reservoir + synchronous disk.save().');
  note('If p99 > 50 ms: disk is the bottleneck — check disk tier or increase l1MaxEntries.');
  note('If p99 on headroom path > 5× mean: GC is pausing — reduce heap with lower l1MaxBytes.');

  await pdSvcHead.destroy();
  await pdSvcFull.destroy();
  cleanup(pdDir1, pdDir2);
}

// ─────────────────────────────────────────────────────────────────────────────
//  7. OOM guard eviction latency
// ─────────────────────────────────────────────────────────────────────────────

header('OOM guard — heap-triggered emergency eviction');
note('OOM polls process.memoryUsage().heapUsed/heapTotal every oomCheckIntervalMs.');
note('When ratio > oomHeapThreshold it calls evictPercentage(oomEvictPercent).');
note('Threshold=0.001 forces every check to trigger. Timer interval=10ms for fast testing.');

const oomDir = makeTempDir();
const oomSvc = CacheService.reset({
  disableRedis:       true,
  oomProtection:      true,
  oomHeapThreshold:   0.001,   // always exceeded
  oomCheckIntervalMs: 10,
  oomEvictPercent:    0.20,
  l1MaxEntries:       5_000,
  diskCacheDir:       oomDir,
});

for (let i = 0; i < 5_000; i++) await oomSvc.set(`oom:${i}`, { i }, 300);

const mBefore = oomSvc.metrics();
console.log(`  ${C.dim}  Pre-eviction:  L1 entries=${mBefore.l1.entries}, ${fmtBytes(mBefore.l1.sizeBytes)} used${C.reset}`);

await new Promise(r => setTimeout(r, 80)); // wait for 8 timer ticks

const mAfter = oomSvc.metrics();
console.log(`  ${C.dim}  Post-eviction: L1 entries=${mAfter.l1.entries}, eviction rounds=${mAfter.oom.evictions}${C.reset}`);
console.log(`  ${C.dim}  Entries removed per round: ~${((mBefore.l1.entries - mAfter.l1.entries) / Math.max(1, mAfter.oom.evictions)).toFixed(0)}${C.reset}`);
console.log(`  ${C.dim}  Last trigger:  ${mAfter.oom.lastTriggeredAt ? new Date(mAfter.oom.lastTriggeredAt).toISOString() : 'null'}${C.reset}`);

await oomSvc.destroy();

// ─────────────────────────────────────────────────────────────────────────────
//  8. metrics() snapshot overhead
// ─────────────────────────────────────────────────────────────────────────────

header('metrics() snapshot & Prometheus text cost');
note('metrics() reads counters O(1) + calls l1.getStats() which scans bloom bits.');
note('toPrometheusText() is string concatenation — O(k) where k ≈ 30 metric lines.');

await bench('metrics() snapshot', () => {
  svc.metrics();
}, 100_000, 1_000, 'O(1) counters + O(bloom-bits) scan');

await bench('toPrometheusText(metrics())', () => {
  CacheService.toPrometheusText(svc.metrics());
}, 50_000, 500, 'string concat ~30 metric lines');

// ─────────────────────────────────────────────────────────────────────────────
//  9. Realistic workload simulation
// ─────────────────────────────────────────────────────────────────────────────
// (section number preserved; encryption is §10 inserted after)

header('Realistic workload — 80% hot read / 15% cold miss / 5% write');
note('Simulates a typical web-server request fan-out with a warm cache.');
note('Parallel variant uses 20-coroutine fan-out to simulate concurrent requests.');

const HOT_KEYS  = 2_000;
const MISS_KEYS = 500;

for (let i = 0; i < HOT_KEYS; i++) await svc.set(`rw:hot:${i}`, { data: `v-${i}` }, 600);

let realFetches = 0;
const realisticFn = async (i: number): Promise<void> => {
  const r = Math.random();
  if (r < 0.80) {
    await svc.get(`rw:hot:${i % HOT_KEYS}`,  async () => ({ data: `v-${i}` }), 600);
  } else if (r < 0.95) {
    await svc.get(`rw:miss:${i % MISS_KEYS}`, async () => { realFetches++; return { v: i }; }, 10);
  } else {
    await svc.set(`rw:hot:${i % HOT_KEYS}`,  { data: `updated-${i}` }, 600);
  }
};

await bench('Serial  realistic workload', realisticFn, 20_000, 500);
await benchParallel('Parallel realistic workload (20×)', realisticFn, 20, 1_000);

// ─────────────────────────────────────────────────────────────────────────────
//  10. Final summary
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
//  10. AES-256-GCM encryption overhead
// ─────────────────────────────────────────────────────────────────────────────

header('AES-256-GCM encryption — string (Redis) and buffer (disk) paths');
note('IVs are pre-generated in a pool of 64. randomFillSync() fills the Buffer in-place — no allocation on refill.');
note('Auth-tag generation and GCM finalisation are the dominant CPU cost per call.');
note('Decrypt path has no randomBytes cost but must verify the 128-bit auth tag.');

// Generate a deterministic 32-byte key for the benchmark (safe — not a real secret)
const encKey = Buffer.alloc(32, 0xab).toString('base64'); // 32 × 0xab
const enc = new CacheEncryption(encKey, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

// Cross-size JIT warmup: V8 compiles `encrypt`/`decrypt` against the first string/buffer
// shapes it sees. Without this, switching from 64B → 512B mid-loop triggers a deopt +
// recompile, inflating the 512B timed run. Warming all three sizes first gives the JIT
// a stable polymorphic view before any measurements start.
for (const wBytes of [64, 512, 4_096]) {
  const ws  = 'x'.repeat(wBytes);
  const wc  = enc.encrypt(ws);
  const wb  = Buffer.alloc(wBytes, 0x42);
  const wcb = enc.encryptBuffer(wb);
  for (let i = 0; i < 300; i++) { enc.encrypt(ws); enc.decrypt(wc); enc.encryptBuffer(wb); enc.decryptBuffer(wcb); }
}

for (const bytes of [64, 512, 4_096] as const) {
  const plainStr  = 'x'.repeat(bytes);
  const cipherStr = enc.encrypt(plainStr);
  const plainBuf  = Buffer.alloc(bytes, 0x42);
  const cipherBuf = enc.encryptBuffer(plainBuf);

  await bench(
    `encrypt (string)  ${String(bytes).padStart(5)}B`,
    () => { enc.encrypt(plainStr); },
    50_000, 500,
    'IV pool + GCM update/final + base64',
  );
  await bench(
    `decrypt (string)  ${String(bytes).padStart(5)}B`,
    () => { enc.decrypt(cipherStr); },
    50_000, 500,
    'base64 decode + GCM update/final + auth-tag verify',
  );
  await bench(
    `encryptBuffer     ${String(bytes).padStart(5)}B`,
    () => { enc.encryptBuffer(plainBuf); },
    50_000, 500,
    'IV pool + GCM + pre-alloc output buffer',
  );
  await bench(
    `decryptBuffer     ${String(bytes).padStart(5)}B`,
    () => { enc.decryptBuffer(cipherBuf); },
    50_000, 500,
    'magic check + GCM + auth-tag verify',
  );
}

note('Rule of thumb: if encrypt latency > 50 µs, the bottleneck is likely GC from large');
note('Buffer allocations — consider reusing IV buffers or batching writes.');

// ─── AES-128-GCM ─────────────────────────────────────────────────────────────
header('AES-128-GCM encryption — 10 cipher rounds vs 14 for AES-256. Same IV/tag overhead.');
note('16-byte key. ~10% faster on non-AES-NI hardware; negligible difference with AES-NI.');
note('Same AEAD guarantees as AES-256-GCM: authenticated encryption with 128-bit tag.');

const enc128Key = Buffer.alloc(16, 0xab).toString('base64'); // 16 × 0xab
const enc128 = new CacheEncryption(enc128Key, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, 'aes-128-gcm');

for (const bytes of [64, 512, 4_096] as const) {
  const plainStr128  = 'x'.repeat(bytes);
  const cipherStr128 = enc128.encrypt(plainStr128);
  const plainBuf128  = Buffer.alloc(bytes, 0x42);
  const cipherBuf128 = enc128.encryptBuffer(plainBuf128);

  await bench(
    `[128] encrypt (string)  ${String(bytes).padStart(5)}B`,
    () => { enc128.encrypt(plainStr128); },
    50_000, 500,
    'AES-128-GCM: IV pool + GCM update/final + base64',
  );
  await bench(
    `[128] decrypt (string)  ${String(bytes).padStart(5)}B`,
    () => { enc128.decrypt(cipherStr128); },
    50_000, 500,
    'base64 decode + GCM update/final + auth-tag verify',
  );
  await bench(
    `[128] encryptBuffer     ${String(bytes).padStart(5)}B`,
    () => { enc128.encryptBuffer(plainBuf128); },
    50_000, 500,
    'AES-128-GCM: IV pool + GCM + pre-alloc output buffer',
  );
  await bench(
    `[128] decryptBuffer     ${String(bytes).padStart(5)}B`,
    () => { enc128.decryptBuffer(cipherBuf128); },
    50_000, 500,
    'magic check + GCM + auth-tag verify',
  );
}

// ─── AES-128-CTR ─────────────────────────────────────────────────────────────
header('AES-128-CTR encryption — AES-NI keystream, no GHASH auth-tag computation.');
note('16-byte key. Same AES-NI hardware path as GCM but skips the Galois-field MAC step.');
note('Removes ~1–2 µs of GHASH overhead per call — biggest gain at large payloads.');
note('No authentication: use only when integrity is guaranteed by transport (TLS, HMAC).');
note('IV is the full 128-bit AES block (initial counter block), unlike 96-bit GCM IVs.');

const encCtrKey = Buffer.alloc(16, 0xab).toString('base64'); // 16 × 0xab
const encCtr = new CacheEncryption(encCtrKey, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, 'aes-128-ctr');

for (const bytes of [64, 512, 4_096] as const) {
  const plainStrCtr  = 'x'.repeat(bytes);
  const cipherStrCtr = encCtr.encrypt(plainStrCtr);
  const plainBufCtr  = Buffer.alloc(bytes, 0x42);
  const cipherBufCtr = encCtr.encryptBuffer(plainBufCtr);

  await bench(
    `[ctr] encrypt (string)  ${String(bytes).padStart(5)}B`,
    () => { encCtr.encrypt(plainStrCtr); },
    50_000, 500,
    'AES-128-CTR: IV pool + stream-cipher update + base64 (no GHASH)',
  );
  await bench(
    `[ctr] decrypt (string)  ${String(bytes).padStart(5)}B`,
    () => { encCtr.decrypt(cipherStrCtr); },
    50_000, 500,
    'base64 decode + CTR update (no auth-tag verify)',
  );
  await bench(
    `[ctr] encryptBuffer     ${String(bytes).padStart(5)}B`,
    () => { encCtr.encryptBuffer(plainBufCtr); },
    50_000, 500,
    'AES-128-CTR: IV pool + stream-cipher + pre-alloc output buffer (no GHASH)',
  );
  await bench(
    `[ctr] decryptBuffer     ${String(bytes).padStart(5)}B`,
    () => { encCtr.decryptBuffer(cipherBufCtr); },
    50_000, 500,
    'magic check + CTR update (no auth-tag verify)',
  );
}

// ─── XOR obfuscation ──────────────────────────────────────────────────────────
header('XOR obfuscation — NOT cryptographic. 32-bit word-level loop (4 B/iter) for 4-byte-aligned keys.');
note('WARNING: XOR provides obfuscation only — it is NOT secure encryption.');
note('Use for dev environments, hot-reload caches, or non-sensitive data only.');
note('Self-inverse: encrypt(encrypt(x)) === x. No IV, no auth tag.');
note('Fast path: readUInt32LE/writeUInt32LE compile to a single 32-bit XOR CPU instruction.');
note('4× fewer loop iterations than byte-by-byte for 4-byte-aligned keys (16, 32 B).');
note('Small payloads: no cipher context setup → dominates AES. Large: word XOR narrows the gap vs AES-NI.');

const xorKey = Buffer.alloc(32, 0xcd).toString('base64'); // 32 × 0xcd
const encXor = new CacheEncryption(xorKey, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, 'xor');

for (const bytes of [64, 512, 4_096] as const) {
  const plainStrXor  = 'x'.repeat(bytes);
  const cipherStrXor = encXor.encrypt(plainStrXor);
  const plainBufXor  = Buffer.alloc(bytes, 0x42);
  const cipherBufXor = encXor.encryptBuffer(plainBufXor);

  await bench(
    `[xor] mask   (string)  ${String(bytes).padStart(5)}B`,
    () => { encXor.encrypt(plainStrXor); },
    100_000, 500,
    'XOR obfuscation: utf8 → Buffer + 32-bit word XOR + base64',
  );
  await bench(
    `[xor] unmask (string)  ${String(bytes).padStart(5)}B`,
    () => { encXor.decrypt(cipherStrXor); },
    100_000, 500,
    'base64 decode + 32-bit word XOR + utf8 decode (self-inverse)',
  );
  await bench(
    `[xor] maskBuffer       ${String(bytes).padStart(5)}B`,
    () => { encXor.encryptBuffer(plainBufXor); },
    100_000, 500,
    'XOR obfuscation: 32-bit word XOR + pre-alloc output buffer',
  );
  await bench(
    `[xor] unmaskBuffer     ${String(bytes).padStart(5)}B`,
    () => { encXor.decryptBuffer(cipherBufXor); },
    100_000, 500,
    'magic check + 32-bit word XOR (self-inverse)',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  12. Multi-tenancy — category competition & namespace isolation
// ─────────────────────────────────────────────────────────────────────────────

header('Multi-tenancy — category competition & namespace isolation');
note('Two categories share one L1: user: (HIGH priority, limit 200) vs analytics: (LOW, limit 100).');
note('Category limits are soft — two-phase reservoir sampling ensures the overflowing category');
note('is always represented in the eviction pool (≥ EVICT candidates from that category first).');
note('With a priority spread, HIGH-priority entries reliably resist LOW-priority floods.');

// ── 12a. Category starvation test ─────────────────────────────────────────

const catL1 = new SmartMemoryCache({
  maxBytes:   4 * 1024 * 1024,
  maxEntries: 400,
  categories: {
    'user:':      { maxEntries: 200, maxSizeBytes: 2 * 1024 * 1024 },
    'analytics:': { maxEntries: 100, maxSizeBytes: 1 * 1024 * 1024 },
    'default':    { maxEntries: 100, maxSizeBytes: 1 * 1024 * 1024 },
  },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
});

// Fill user: to its 200-entry limit at HIGH priority
for (let i = 0; i < 200; i++) {
  catL1.set(`user:${i}`, { id: i, name: `u${i}` }, 300_000, CachePriority.HIGH);
}
const userCountBefore = catL1.getStats().categories['user:']?.entries ?? 0;

// Flood analytics: well beyond its 100-entry limit at LOW priority.
// Each set() triggers ensureCapacity → smartEvict → 4 entries evicted from
// 16-sampled pool. analytics: entries carry a -100 score penalty (catBonus)
// so they are preferentially selected over HIGH-priority user: entries.
const analFloodKeys = Array.from({ length: 2_048 }, (_, i) => `analytics:${i}`);
const ANAL_FLOOD_MASK = analFloodKeys.length - 1;

await bench(
  'analytics: flood beyond limit into full L1',
  i => { catL1.set(analFloodKeys[i & ANAL_FLOOD_MASK], { report: i, d: 'a'.repeat(64) }, 60_000, CachePriority.LOW); },
  10_000, 100,
  'two-phase sampling: category-local phase guarantees ≥ EVICT overflowing entries in pool',
);

{
  const statsPost = catL1.getStats();
  const userAfter = statsPost.categories['user:']?.entries      ?? 0;
  const analAfter = statsPost.categories['analytics:']?.entries ?? 0;
  const userLost  = userCountBefore - userAfter;
  const protection = ((1 - userLost / Math.max(1, userCountBefore)) * 100).toFixed(1);
  console.log(`  ${C.dim}  user: before → after analytics: flood: ${userCountBefore} → ${userAfter} (${userLost} evicted)${C.reset}`);
  console.log(`  ${C.dim}  analytics: entries stabilised at: ${analAfter} / 100 limit${C.reset}`);
  const colour = parseFloat(protection) >= 90 ? C.green : C.yellow;
  console.log(`  ${C.dim}  user: protection rate: ${colour}${protection}%${C.reset}${C.dim} — ${parseFloat(protection) >= 90 ? 'HIGH priority effective against LOW flood (two-phase sampling working)' : 'cross-category starvation visible — two-phase sampling may need larger EVICT window'}${C.reset}`);
}

// ── 12b. Get throughput after flooding ─────────────────────────────────────

// Re-warm user: entries that may have been evicted
for (let i = 0; i < 64; i++) catL1.set(`user:${i}`, { id: i }, 300_000, CachePriority.HIGH);

const catHotUserKeys = Array.from({ length: 64 }, (_, i) => `user:${i}`);
const CAT_USER_MASK  = catHotUserKeys.length - 1;

await bench(
  'get user: hot hit — after analytics: flood',
  i => { catL1.get(catHotUserKeys[i & CAT_USER_MASK]); },
  200_000, 2_000,
  'bloom → Map.get; HIGH-priority entries re-warm instantly',
);

// ── 12c. Namespace isolation correctness check ─────────────────────────────

const nsADir = makeTempDir();
const nsBDir = makeTempDir();

const nsA = CacheService.reset({ namespace: 'org_a', disableRedis: true, oomProtection: false, metricsIntervalMs: 0, diskCacheDir: nsADir });
const nsB = CacheService.reset({ namespace: 'org_b', disableRedis: true, oomProtection: false, metricsIntervalMs: 0, diskCacheDir: nsBDir });

await nsA.set('user:1', { tenant: 'A' }, 300);
await nsB.set('user:1', { tenant: 'B' }, 300);

// Delete from org_a — must not affect org_b's copy of the same key
await nsA.delete('user:1');
const aMiss = await nsA.get('user:1', async () => null, 1);
const bHit  = await nsB.get('user:1', async () => null, 1) as { tenant: string } | null;
const isIsolated = aMiss === null && bHit?.tenant === 'B';
console.log(
  `  ${C.dim}  Key isolation: org_a.delete('user:1') → org_b still holds value — ` +
  (isIsolated ? `${C.green}✓ isolated${C.reset}` : `${C.red}✗ leaked to org_b${C.reset}`)
);

// ── 12d. Namespace throughput parity ──────────────────────────────────────

header('  12d. Namespace throughput parity — two tenants, same 80/15/5 workload');
note('  Each namespace has its own L1, disk dir, inflight Map, and pub/sub channel.');
note('  Throughput should be ~identical — no shared mutable state between instances.');

const NS_HOT = 500;
for (let i = 0; i < NS_HOT; i++) {
  await nsA.set(`hot:${i}`, { v: i }, 300);
  await nsB.set(`hot:${i}`, { v: i }, 300);
}

// Pre-generate a deterministic random sequence shared by both tenant benchmarks.
// This ensures org_a and org_b see the exact same operation distribution so
// JIT-warmth differences (org_a runs first) don't skew the parity ratio.
const NS_RAND = Array.from({ length: 10_200 }, () => Math.random());

const nsMixed = (ns: CacheService) => async (i: number): Promise<void> => {
  const r = NS_RAND[i % NS_RAND.length];
  if      (r < 0.80) { await ns.get(`hot:${i % NS_HOT}`,  async () => ({ v: i }), 300); }
  else if (r < 0.95) { await ns.get(`miss:${i % 100}`, async () => ({ v: i }), 5); }
  else               { await ns.set(`hot:${i % NS_HOT}`,  { v: i }, 300); }
};

// Interleaved warmup: alternate between both closures so the JIT compiles and
// optimises the shared CacheService / inflight-Map hot paths identically for
// both namespaces before either timed run begins.  Without this, org_b would
// inherit org_a's JIT-compiled code for free, inflating its measured ops/s.
const fnA = nsMixed(nsA);
const fnB = nsMixed(nsB);
const PARITY_WARMUP = 400;
for (let i = 0; i < PARITY_WARMUP; i++) {
  await fnA(i);
  await fnB(i);
}

// warmup=0: the interleaved pass above already warmed both call-sites equally.
const nsResA = await bench('  org_a — 80/15/5 workload', fnA, 10_000, 0, 'independent L1 + disk + inflight Map');
const nsResB = await bench('  org_b — 80/15/5 workload', fnB, 10_000, 0, 'independent L1 + disk + inflight Map');
console.log(
  `  ${C.dim}  Throughput ratio A/B: ${(nsResA.opsPerSec / nsResB.opsPerSec).toFixed(2)}× — expect ≈ 1.0 (fully independent)${C.reset}`
);

await nsA.destroy();
await nsB.destroy();

// ─────────────────────────────────────────────────────────────────────────────
//  13. v0.4.0 new features — hotKeys, setIfAbsent, negative caching, refresh-ahead
// ─────────────────────────────────────────────────────────────────────────────

header('hotKeys(n) — Count-Min Sketch hit ranking');
note('Iterates all live L1 entries, queries sketch.estimate() per key, then sorts.');
note('Cost is O(entries) for the scan + O(entries log entries) for the sort.');
note('Larger L1 = slower hotKeys(). Consider calling at low frequency (e.g. every 10 s).');

// Pre-fill svc with entries and simulate uneven access so the sketch has signal.
for (let i = 0; i < 2_000; i++) await svc.set(`hkb:${i}`, { n: i }, 300);
for (let i = 0; i < 600; i++) await svc.get(`hkb:${i % 2_000}`, async () => ({ n: i }), 300);

await bench('hotKeys(10)  — 2 K live L1 entries', () => {
  svc.hotKeys(10);
}, 10_000, 500, 'O(n) sketch scan + O(n log n) sort + slice(0,10)');

await bench('hotKeys(100) — 2 K live L1 entries', () => {
  svc.hotKeys(100);
}, 10_000, 500, 'same scan+sort, larger output slice');

// ─────────────────────────────────────────────────────────────────────────────

header('setIfAbsent() — conditional write (L1-first, Redis NX fallback)');
note('Fast path (key present in L1): l1.has() returns true → immediate false, no write.');
note('Slow path (key absent from L1): l1.has() miss → l1.set() + bloom update → true.');
note('With Redis disabled, there is no network hop; the L1 check is the entire cost.');

const SIA_SIZE = 2_048;
const SIA_MASK = SIA_SIZE - 1;
for (let i = 0; i < SIA_SIZE; i++) await svc.set(`sia:hot:${i}`, 'v', 300);

await bench('setIfAbsent — key already in L1 (no-op fast path)', async i => {
  await svc.setIfAbsent(`sia:hot:${i & SIA_MASK}`, 'v', 300);
}, 50_000, 1_000, 'l1.has() → true → return false immediately');

// Fresh unique keys so L1 never pre-has them — tests the write path.
let siaNewIdx = 0;
await bench('setIfAbsent — new key, L1 miss → write', async () => {
  await svc.setIfAbsent(`sia:new:${siaNewIdx++}`, 'v', 300);
}, 20_000, 200, 'l1.has() miss → l1.set() + bloom.add → return true');

// ─────────────────────────────────────────────────────────────────────────────

header('Negative caching (notFoundTtl) — null-result L1 hit vs normal TTL routing');
note('null results are cached like any other value — L1 get() cannot distinguish null from');
note('"real" data. The only difference is the TTL written: notFoundTtl instead of ttlSeconds.');
note('Subsequent L1 hits for null return immediately — no fetchFn call, no TTL logic.');

// Pre-populate null sentinels with notFoundTtl=5 s
const NF_SIZE = 1_024;
const NF_MASK = NF_SIZE - 1;
for (let i = 0; i < NF_SIZE; i++) {
  await svc.get(`nf:${i}`, async () => null, 60, { notFoundTtl: 5 });
}

await bench('get — warm null hit (notFoundTtl cached)', async i => {
  await svc.get(`nf:${i & NF_MASK}`, async () => null, 60, { notFoundTtl: 5 });
}, 50_000, 1_000, 'null served from L1 — identical path to any non-null L1 hit');

// Compare: same key, same TTL, non-null value — should be the same throughput.
for (let i = 0; i < NF_SIZE; i++) await svc.set(`nf:real:${i}`, { v: i }, 300);

await bench('get — warm non-null hit (same L1 path, for comparison)', async i => {
  await svc.get(`nf:real:${i & NF_MASK}`, async () => ({ v: i }), 300);
}, 50_000, 1_000, 'non-null L1 hit — baseline to confirm null path has no extra overhead');

// ─────────────────────────────────────────────────────────────────────────────

header('Refresh-ahead overhead — extra cost added to a warm L1 hit');
note('refresh-ahead adds: two local reads (optRefreshAhead, optXfetchBeta — normalised from opts once at get() entry) + two arithmetic ops.');
note('No second Map lookup — expiresAt/ttlMs/delta are already carried in the CacheHit object.');
note('When the key is fresh (not near expiry), the threshold check is false → no recompute.');
note('Expected overhead: ~10–15% with a consistent opts shape at each call site.');
note('Benchmark shows higher (>20%) because the baseline and refreshAhead benches share the');
note('same get() function, making the opts.refreshAhead IC bimorphic. The arithmetic floor is');
note('~40–60 ns (one subtract + one multiply + one compare on pre-read properties).');

await svc.set('ra:bench', { n: 1 }, 300);

const raBaseline = await bench('get — warm hit, NO refreshAhead (baseline)', async () => {
  await svc.get('ra:bench', async () => ({ n: 2 }), 300);
}, 50_000, 1_000, 'bloom → l1.get → return');

const raAhead = await bench('get — warm hit, refreshAhead=0.8 (fresh key, no recompute)', async () => {
  await svc.get('ra:bench', async () => ({ n: 2 }), 300, { refreshAhead: 0.8 });
}, 50_000, 1_000, 'bloom → l1.get → threshold check (false) → return; no recompute');

console.log(
  `  ${C.dim}  Refresh-ahead overhead: ` +
  `${((raAhead.nsPerOp - raBaseline.nsPerOp)).toFixed(1)} ns/op extra ` +
  `(${((raAhead.nsPerOp / raBaseline.nsPerOp - 1) * 100).toFixed(1)}% overhead)${C.reset}`
);
note('If overhead > 10%: get() has been called with different opts shapes (IC pollution from');
note('mixed call sites). In production with a consistent opts shape at each call site, overhead');
note('will be lower. The arithmetic minimum (subtraction + multiply + compare) costs ~40–60 ns.');

// ─────────────────────────────────────────────────────────────────────────────
//  14. Amortized disk janitor — purgeNextBucket vs purgeExpired
// ─────────────────────────────────────────────────────────────────────────────

header('Amortized disk janitor — purgeNextBucket() vs purgeExpired()');
note('Two modes depending on node:sqlite availability:');
note('  File-only  — V3 filenames: readdirSync + filename expiry parse; no decrypt for non-expired.');
note('  SQLite     — purgeExpired():    single indexed SQL query (no FS walk). O(log n) expiry check.');
note('  SQLite     — purgeNextBucket(): same SQL query PLUS readdirSync one orphan bucket (crash-recovery).');
note('  SQLite paradox: purgeExpired faster than purgeNextBucket — SQL-only vs SQL + readdirSync.');
note('  Windows readdirSync overhead (~70 µs/call) dominates purgeNextBucket in SQLite mode.');
note('  Production impact at 1 call/30 s: 70 µs / 30 000 ms = 0.0002% CPU — benchmark artifact.');

{
  const janitorDir = makeTempDir();

  // Import DiskTier directly (already imported at top via CacheService internals — use a clean instance)
  const { DiskTier: DT } = await import('../src/disk-tier.js');
  const jDisk = new DT({
    dir: janitorDir,
    maxBytes: 50 * 1024 * 1024,
    entryMaxBytes: 1024 * 1024,
    forbiddenPrefixes: [],
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  // Seed 200 long-lived entries spread across buckets
  const { pack: jPack } = await import('msgpackr');
  const { CachePriority: jCP } = await import('../src/types.js');
  for (let i = 0; i < 200; i++) {
    const data = jPack({ n: i });
    await jDisk.save(`bench:janitor:${i}`, {
      data,
      isCompressed: true,
      expiresAt: Date.now() + 300_000,
      size: data.byteLength,
      hits: 1,
      lastAccess: Date.now(),
      priority: jCP.NORMAL,
    });
  }

  const jMode = jDisk.indexMode;
  console.log(`  ${C.dim}  Seeded ${jDisk.stats.files} live entries across disk buckets${C.reset}`);
  console.log(`  ${C.dim}  Mode: ${jMode === 'sqlite' ? 'SQLite index (node:sqlite available)' : 'file-only (V3 filename expiry parse)'}${C.reset}`);

  const pnbDesc = jMode === 'sqlite'
    ? 'SQL: all expired rows (indexed) + readdirSync one orphan bucket (crash-recovery)'
    : 'readdirSync one bucket + filename expiry parse; no file read for live entries';
  const peDesc  = jMode === 'sqlite'
    ? 'SQL: single indexed query; no filesystem walk'
    : 'readdirSync all 256 buckets + filename expiry parse; O(fileCount) but no decrypt';

  // Measure purgeNextBucket (one-bucket tick, no entries expire)
  await bench('purgeNextBucket() — one bucket tick (no expiry)', () => {
    jDisk.purgeNextBucket();
  }, 10_000, 256, pnbDesc);

  // Measure purgeExpired full scan (none expire)
  await bench('purgeExpired()   — full 256-bucket scan (no expiry)', () => {
    jDisk.purgeExpired();
  }, 500, 5, peDesc);

  if (jMode === 'sqlite') {
    console.log(`  ${C.dim}  SQLite: purgeExpired (SQL-only) is faster than purgeNextBucket (SQL + orphan readdirSync).${C.reset}`);
    console.log(`  ${C.dim}  The ~70 µs orphan scan is a Windows readdirSync cost — on Linux it would be ~1–2 µs.${C.reset}`);
  } else {
    console.log(`  ${C.dim}  File-only: purgeNextBucket is 1/256th of the readdirSync calls vs purgeExpired.${C.reset}`);
    console.log(`  ${C.dim}  Same total work spread across 256 ticks (128-min full cycle).${C.reset}`);
  }

  try { rmSync(janitorDir, { recursive: true, force: true }); } catch { /* ok */ }
}

// ─────────────────────────────────────────────────────────────────────────────
//  15. categoryKeys trailing-wildcard fast path vs O(N) regex scan
// ─────────────────────────────────────────────────────────────────────────────

header('deletePattern — categoryKeys O(1) fast path vs O(N) regex scan');
note('When the trailing-wildcard pattern prefix exactly matches a configured category,');
note('deletePattern() looks up the pre-built categoryKeys Set instead of scanning the Map.');
note('Fast path: O(catSize) key iteration only. Slow path: O(N) regex test per key.');
note('Speedup is proportional to N / catSize — most pronounced when N is large.');

{
  const CAT_ENTRIES = 2_000;
  const CAT_SIZE    = 200;  // user: category holds 200 keys

  // Cache with 'user:' as an explicit category — fast path fires on deletePattern('user:*')
  const fpCache = new SmartMemoryCache({
    maxBytes:   100 * 1024 * 1024,
    maxEntries: CAT_ENTRIES,
    categories: {
      'user:':    { maxEntries: CAT_SIZE, maxSizeBytes: 10 * 1024 * 1024 },
      'default':  { maxEntries: CAT_ENTRIES - CAT_SIZE, maxSizeBytes: 90 * 1024 * 1024 },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  // Fill 200 user: entries + 1800 default entries
  for (let i = 0; i < CAT_SIZE;                i++) fpCache.set(`user:${i}`,    { id: i }, 300_000);
  for (let i = 0; i < CAT_ENTRIES - CAT_SIZE;  i++) fpCache.set(`default:${i}`, { id: i }, 300_000);

  // Cache WITHOUT 'user:' as a category — forces the O(N) regex scan for same pattern
  const regexCache = new SmartMemoryCache({
    maxBytes:   100 * 1024 * 1024,
    maxEntries: CAT_ENTRIES,
    categories: { 'default': { maxEntries: CAT_ENTRIES, maxSizeBytes: 100 * 1024 * 1024 } },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
  for (let i = 0; i < CAT_SIZE;                i++) regexCache.set(`user:${i}`,    { id: i }, 300_000);
  for (let i = 0; i < CAT_ENTRIES - CAT_SIZE;  i++) regexCache.set(`default:${i}`, { id: i }, 300_000);

  // Warmup both paths equally
  for (let r = 0; r < 5; r++) {
    for (let i = 0; i < CAT_SIZE; i++) fpCache.set(`user:${i}`, { id: i }, 300_000);
    fpCache.deletePattern('user:*');
    for (let i = 0; i < CAT_SIZE; i++) regexCache.set(`user:${i}`, { id: i }, 300_000);
    regexCache.deletePattern('user:*');
  }

  // Re-seed for timed runs (each bench iteration deletes+reseeds to keep the measurement honest)
  const fpRun = (): void => {
    // Reseed with a fixed pool of CAT_SIZE keys (overwrite, not insert) so the bloom
    // filter never accumulates unbounded phantom insertions across iterations.
    for (let i = 0; i < CAT_SIZE; i++) fpCache.set(`user:${i}`, { id: i }, 300_000);
    fpCache.deletePattern('user:*');
  };

  const rxRun = (): void => {
    for (let i = 0; i < CAT_SIZE; i++) regexCache.set(`user:${i}`, { id: i }, 300_000);
    regexCache.deletePattern('user:*');
  };

  const fpRes = await bench(
    `deletePattern('user:*') — categoryKeys fast path (${CAT_ENTRIES} entries, cat=${CAT_SIZE})`,
    fpRun, 2_000, 20,
    'O(catSize) index lookup + Set iteration — skips full Map scan',
  );

  const rxRes = await bench(
    `deletePattern('user:*') — O(N) regex scan   (${CAT_ENTRIES} entries, cat=${CAT_SIZE})`,
    rxRun, 2_000, 20,
    'O(N) Map.keys() iteration + RegExp.test per key',
  );

  const speedup = rxRes.nsPerOp / fpRes.nsPerOp;
  const colour  = speedup >= 1.2 ? C.green : speedup >= 1.05 ? C.yellow : C.red;
  // Theoretical scan speedup is N/catSize = 10×, but each iteration also runs CAT_SIZE set()
  // calls (equal cost for both paths) that dominate the iteration time. The O(catSize) delete
  // work is also identical. Net: scan savings are a small fraction of total iteration cost,
  // so measured speedup is typically 1.0–1.1×. Benefit is pronounced at larger N.
  console.log(
    `  ${C.dim}  Fast-path speedup: ${colour}${speedup.toFixed(2)}×${C.reset}${C.dim} ` +
    `(scan is ~${(CAT_ENTRIES / CAT_SIZE).toFixed(0)}× faster; total limited by equal O(catSize) delete work + ${CAT_SIZE} set() per iteration)${C.reset}`
  );
}

divider();
const fm = svc.metrics();
console.log(`\n${C.bold}  Final cache state${C.reset}`);
console.log(`  ${C.dim}namespace          : ${fm.namespace || '(default)'}${C.reset}`);
console.log(`  ${C.dim}uptime             : ${(fm.uptimeMs / 1000).toFixed(1)} s${C.reset}`);
console.log(`  ${C.dim}total gets         : ${fm.gets.total.toLocaleString()}${C.reset}`);
console.log(`  ${C.dim}L1 hit rate        : ${(fm.gets.l1HitRate * 100).toFixed(1)}%${C.reset}`);
console.log(`  ${C.dim}disk hits          : ${fm.gets.diskHits.toLocaleString()}${C.reset}`);
console.log(`  ${C.dim}fetch calls        : ${fm.gets.fetches.toLocaleString()}${C.reset}`);
console.log(`  ${C.dim}stampedes prevented: ${fm.gets.stampedePrevented.toLocaleString()}${C.reset}`);
console.log(`  ${C.dim}total sets         : ${fm.sets.total.toLocaleString()}${C.reset}`);
console.log(`  ${C.dim}total deletes      : ${fm.deletes.total.toLocaleString()}${C.reset}`);
console.log(`  ${C.dim}bloom FP rate      : ${(fm.bloom.falsePositiveRate * 100).toFixed(3)}% (cumulative — includes all probes since process start; not representative of current filter state)${C.reset}`);
console.log(`  ${C.dim}                     current filter has ${fm.l1.entries} live entries; actual live FP rate ≈ 0% after last rebuild${C.reset}`);
console.log(`  ${C.dim}compression saved  : ${fmtBytes(fm.compression.bytesSaved)}${C.reset}`);
console.log(`  ${C.dim}L1 entries         : ${fm.l1.entries.toLocaleString()} / ${(fm.l1.maxBytes / 1024 / 1024).toFixed(0)} MB cap${C.reset}`);
console.log(`  ${C.dim}L1 used            : ${fmtBytes(fm.l1.sizeBytes)}${C.reset}`);
console.log(`  ${C.dim}disk files         : ${fm.disk.files}${C.reset}`);

console.log(`\n${C.bold}${C.green}  Bottleneck cheat-sheet${C.reset}`);
console.log(`  ${C.dim}• L1 hot get > 5 M/s?     → bloom + Map.get are your ceiling. Nothing to optimise.${C.reset}`);
console.log(`  ${C.dim}• L1 hot get < 1 M/s?     → GC pressure. Reduce maxEntries or entry payload size.${C.reset}`);
console.log(`  ${C.dim}• set (large) slow?        → msgpackr cost scales with payload size. Reduce payload size or split large values.${C.reset}`);
console.log(`  ${C.dim}• glob delete slow?        → O(n) Map scan. Prefer namespaced exact deletes.${C.reset}`);
console.log(`  ${C.dim}• coalescing efficiency<100% → keys expiring mid-flight; increase TTL.${C.reset}`);
console.log(`  ${C.dim}• parallel ≈ serial (CPU)  → expected — JS is single-threaded.${C.reset}`);
console.log(`  ${C.dim}• parallel >> serial (I/O) → I/O overlap via Promise.all event-loop ticks.${C.reset}`);
console.log(`  ${C.dim}• eviction >>10× headroom  → cache is over-full; increase l1MaxEntries.${C.reset}`);
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
//  13. Count-Min Sketch — burst-flood protection
// ─────────────────────────────────────────────────────────────────────────────

header('Count-Min Sketch — burst-flood protection');
note('50 long-resident NORMAL keys each receive 100 gets (builds sketch frequency).');
note('A burst of 60 brand-new NORMAL keys is then set, forcing eviction.');
note('Survivor count shows how many residents the sketch saved vs a baseline without it.');

{
  const RESIDENTS = 50;
  const BURST     = 60;
  const GETS_EACH = 100;
  const CAP       = 90; // force eviction during burst

  const sketchL1 = new SmartMemoryCache({
    maxBytes:   50 * 1024 * 1024,
    maxEntries: CAP,
    categories: { default: { maxEntries: CAP, maxSizeBytes: 50 * 1024 * 1024 } },
    logger:     consoleLogger,
  });

  // Seed residents and warm the sketch
  for (let i = 0; i < RESIDENTS; i++) sketchL1.set(`res:${i}`, i, 120_000, CachePriority.NORMAL);
  for (let i = 0; i < RESIDENTS; i++) {
    for (let g = 0; g < GETS_EACH; g++) sketchL1.get(`res:${i}`);
  }

  // Burst-flood — triggers eviction
  for (let i = 0; i < BURST; i++) sketchL1.set(`burst:${i}`, i, 120_000, CachePriority.NORMAL);

  let survived = 0;
  for (let i = 0; i < RESIDENTS; i++) { if (sketchL1.get(`res:${i}`) !== null) survived++; }

  const survivedPct = ((survived / RESIDENTS) * 100).toFixed(0);
  console.log(`  ${'resident survival (sketch on)'.padEnd(COL_LABEL)}${C.cyan}${String(`${survived}/${RESIDENTS}  (${survivedPct}%)`).padStart(COL_OPS)}${C.reset}`);

  // Throughput: sketch estimate cost
  const keys = Array.from({ length: 1000 }, (_, i) => `res:${i % RESIDENTS}`);
  let ki = 0;
  await bench(
    'sketch estimate (1 000-key rotation)',
    () => { sketchL1.get(keys[ki++ % keys.length]); },
    200_000, 5_000,
    'L1 get with CountMinSketch.estimate() in score()',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
//  14. Iterator interface — keys() / values() / entries() throughput
// ─────────────────────────────────────────────────────────────────────────────

header('Iterator interface — keys() / values() / entries()');
note('L1 populated with 500 entries. Measures full-scan generator throughput vs raw Map iteration.');

{
  const iterL1 = new SmartMemoryCache({
    maxBytes:   50 * 1024 * 1024,
    maxEntries: 500,
    categories: { default: { maxEntries: 500, maxSizeBytes: 50 * 1024 * 1024 } },
    logger:     consoleLogger,
  });
  for (let i = 0; i < 500; i++) iterL1.set(`iter:${i}`, { n: i }, 120_000);

  const iterSvc = CacheService.reset({
    disableRedis: true,
    namespace:    'bmark',
    l1MaxEntries: 500,
    l1MaxBytes:   50 * 1024 * 1024,
    diskCacheDir: mkdtempSync(path.join(os.tmpdir(), 'tricache-iter-')),
  });
  for (let i = 0; i < 500; i++) await iterSvc.set(`key:${i}`, { n: i }, 120);

  // Warm the liveEntries path before measuring any generators.
  // NOTE: keys() and values() each use dedicated generators (liveKeys/liveValues) that
  // avoid [key,entry] tuple allocation; they show best numbers when measured after warmup
  // via their own path. entries() uses liveEntries and benefits most from this warm.
  // Because all generators iterate the same underlying Map, V8 JIT budget is shared:
  // numbers for any single method are best-case when that method dominates call traffic.
  for (let w = 0; w < 200; w++) {
    for (const _ of iterL1.liveEntries()) {}
    for (const _ of iterSvc.entries()) {}
  }

  await bench(
    'L1 liveEntries() full scan (500 entries)',
    () => { for (const _ of iterL1.liveEntries()) {} },
    10_000, 500,
    'generator yields [key, SmartCacheEntry] for each non-expired entry',
  );

  await bench(
    'CacheService.entries() full scan (500 entries)',
    () => { for (const _ of iterSvc.entries()) {} },
    10_000, 500,
    'yields [strippedKey, value] pairs',
  );

  await bench(
    'CacheService.keys() full scan (500 entries)',
    () => { for (const _ of iterSvc.keys()) {} },
    10_000, 500,
    'namespace prefix stripped per yield — no [key,entry] tuple allocation',
  );

  await bench(
    'CacheService.values() full scan (500 entries)',
    () => { for (const _ of iterSvc.values()) {} },
    10_000, 500,
    'yield* delegation — no intermediate generator frame',
  );

  // Raw Map baseline for comparison
  const rawMap = new Map<string, number>();
  for (let i = 0; i < 500; i++) rawMap.set(`iter:${i}`, i);
  await bench(
    'raw Map iteration baseline (500 entries)',
    () => { for (const _ of rawMap) {} },
    10_000, 500,
    'reference: no expiry check, no generator overhead',
  );

  await iterSvc.destroy();
}

// ─────────────────────────────────────────────────────────────────────────────
//  16. WasmBloomFilter — writeKey hot-path micro-benchmarks
// ─────────────────────────────────────────────────────────────────────────────

header('WasmBloomFilter — writeKey encodeInto hot-path');
note('WASM module compiled once at module load; each new WasmBloomFilter() is an instantiation only.');
note('writeKey now uses TextEncoder.encodeInto() — zero heap allocation per call.');
note('All key pools are pre-allocated so string construction is not on the hot path.');

{
  const { WasmBloomFilter } = await import('../src/wasm/bloom-filter-wasm.js');

  // ── Instantiation cost ──────────────────────────────────────────────────
  // Module-level BLOOM_WASM_MODULE means instantiation is near-instant.
  // Each iteration creates a fresh instance to measure the real per-instantiation cost.
  await bench(
    'WasmBloomFilter — new instance (module pre-compiled)',
    () => { new WasmBloomFilter(); },
    1_000, 100,
    'new WebAssembly.Instance(BLOOM_WASM_MODULE) — no recompile',
  );

  const wf = new WasmBloomFilter();

  // ── Short ASCII keys ────────────────────────────────────────────────────
  // Pre-allocate a pool of 4096 keys (power of 2 for mask trick).
  // These are typical cache keys: short, ASCII-only, no allocation on hot path.
  const asciiPool = Array.from({ length: 4_096 }, (_, i) => `user_session:${i.toString(16).padStart(6, '0')}`);
  const ASCII_MASK = asciiPool.length - 1;

  // Warm encodeInto's JIT path before measuring
  for (let i = 0; i < 500; i++) wf.mightContain(asciiPool[i & ASCII_MASK]);

  await bench(
    'mightContain — short ASCII key (≤ 20 chars)',
    i => { wf.mightContain(asciiPool[i & ASCII_MASK]); },
    500_000, 5_000,
    'encodeInto → WASM memory → 7 hash rounds → bit check',
  );

  await bench(
    'add — short ASCII key (≤ 20 chars)',
    i => { wf.add(asciiPool[i & ASCII_MASK]); },
    500_000, 5_000,
    'encodeInto → WASM memory → 7 hash rounds → bit set',
  );

  // ── Long ASCII keys (> 64 chars) ────────────────────────────────────────
  // encodeInto's native C++ implementation outpaces a JS element-by-element
  // loop for longer keys — this verifies the crossover is beneficial.
  const longAsciiPool = Array.from({ length: 2_048 }, (_, i) =>
    `namespace:tenant_${i}:resource:v2:${('a'.repeat(48))}:${i}`
  );
  const LONG_ASCII_MASK = longAsciiPool.length - 1;

  for (let i = 0; i < 500; i++) wf.mightContain(longAsciiPool[i & LONG_ASCII_MASK]);

  await bench(
    'mightContain — long ASCII key (≈ 80 chars)',
    i => { wf.mightContain(longAsciiPool[i & LONG_ASCII_MASK]); },
    500_000, 5_000,
    'encodeInto at native speed; 1 byte/char, capped at 512B',
  );

  // ── Multi-byte UTF-8 keys ───────────────────────────────────────────────
  // Pre-allocate a pool of UTF-8 strings that previously triggered encode()
  // allocation on every call. With encodeInto, these are now zero-allocation.
  const mbPool = Array.from({ length: 2_048 }, (_, i) =>
    `キャッシュ_session_${i}_🎴_пользователь`
  );
  const MB_MASK = mbPool.length - 1;

  for (let i = 0; i < 500; i++) wf.mightContain(mbPool[i & MB_MASK]);

  await bench(
    'mightContain — multi-byte UTF-8 key (Kanji+emoji+Cyrillic)',
    i => { wf.mightContain(mbPool[i & MB_MASK]); },
    100_000, 1_000,
    'encodeInto zero-alloc; was encode() heap-alloc on every call',
  );

  // ── Long multi-byte key near the 512-byte boundary ──────────────────────
  // This was the worst-case for the old encode() path: full string encoded to
  // ~3× the output size, then sliced. encodeInto stops exactly at the boundary.
  const longMbKey = '日本語キャッシュシステム_'.repeat(18); // ~540 UTF-8 bytes → truncated at 512
  for (let i = 0; i < 500; i++) wf.mightContain(longMbKey);

  await bench(
    'mightContain — long multi-byte key (> 512B UTF-8, truncated)',
    () => { wf.mightContain(longMbKey); },
    100_000, 1_000,
    'encodeInto fills exactly 512B; old encode() allocated ~1620B buffer',
  );

  // ── Surrogate-pair boundary safety ─────────────────────────────────────
  // 510 ASCII + 4-byte emoji: encodeInto writes 510 bytes and skips the emoji
  // rather than writing a partial 4-byte sequence. Confirm no crash + throughput.
  const emojiAtBoundary = 'A'.repeat(510) + '🌟'.repeat(10);
  for (let i = 0; i < 200; i++) wf.mightContain(emojiAtBoundary);

  await bench(
    'mightContain — emoji straddling 512B boundary (surrogate-safe)',
    () => { wf.mightContain(emojiAtBoundary); },
    100_000, 1_000,
    'encodeInto skips partial surrogate; writes 510B cleanly',
  );

  wf.reset();
}

// ─────────────────────────────────────────────────────────────────────────────
//  17. Adaptive TTL — LatencyTracker overhead analysis
// ─────────────────────────────────────────────────────────────────────────────

header('Adaptive TTL (§17) — LatencyTracker overhead analysis');
note('Tracker fires ONLY on fetchFn calls (cache misses). L1 warm hits are NOT affected.');
note('record(): O(1) ring-buffer write into a pre-allocated Float64Array per key.');
note('p95():    ≤32-element sort (adaptiveTtlSamples default=32). Effectively O(1).');
note('metrics() snapshot: O(trackedKeys × log trackedKeys) sort — call at low frequency.');

{
  const atDir1 = makeTempDir();
  const atDir2 = makeTempDir();
  const atDir3 = makeTempDir();

  // Use distinct namespaces so all three instances co-exist simultaneously.
  const atOff = CacheService.reset({
    namespace: 'at-off', disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    diskCacheDir: atDir1, adaptiveTtl: false,
  });
  const atOn = CacheService.reset({
    namespace: 'at-on', disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    diskCacheDir: atDir2, adaptiveTtl: true, adaptiveTtlSamples: 32,
    adaptiveTtlMin: 1, adaptiveTtlMax: 86400, adaptiveTtlMultiplier: 20,
  });
  const atFetch3 = CacheService.reset({
    namespace: 'at-fetch', disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    diskCacheDir: atDir3, adaptiveTtl: false,
  });

  await atOff.set('warm', { v: 1 }, 600);
  await atOn.set('warm',  { v: 1 }, 600);

  // ── 17a. Warm L1 hit — tracker is NOT on the hot-hit path ──────────────

  header('  17a. Warm L1 hit — adaptiveTtl overhead on the hot path');
  note('  Tracker is only reached inside the fetchPromise IIFE — which is never created on a hit.');
  note('  Expect zero observable overhead vs baseline.');

  const hitOff = await bench(
    '  get — L1 warm hit, adaptiveTtl=false (baseline)',
    async () => { await atOff.get('warm', async () => ({ v: 1 }), 600); },
    100_000, 1_000,
    'no tracker — pure inflight-check → l1.get → return',
  );

  const hitOn = await bench(
    '  get — L1 warm hit, adaptiveTtl=true  (tracker on)',
    async () => { await atOn.get('warm',  async () => ({ v: 1 }), 600); },
    100_000, 1_000,
    'tracker only fires in fetchFn branch — not reached on L1 hit',
  );

  {
    const delta = hitOn.nsPerOp - hitOff.nsPerOp;
    const pct   = ((hitOn.nsPerOp / hitOff.nsPerOp - 1) * 100).toFixed(1);
    const col   = Math.abs(delta) < 500 ? C.green : Math.abs(delta) < 2_000 ? C.yellow : C.red;
    console.log(
      `  ${C.dim}  Hot-path delta: ${col}${delta >= 0 ? '+' : ''}${delta.toFixed(0)} ns/op` +
      ` (${pct}%)${C.reset}${C.dim} — expect ≈ 0 (tracker not reached on L1 hit)${C.reset}`
    );
  }

  // ── 17b. Cold miss / fetch — overhead of record() + p95() ──────────────

  header('  17b. Cold miss / fetch — record() + p95() overhead');
  note('  Seeding 128 keys with ≥6 samples each so p95() fires (triggers ≥5-sample path).');

  const APOOL  = 128;
  const APMASK = APOOL - 1;

  // Seed ≥5 samples per key so p95() is computed on every measured iteration.
  for (let k = 0; k < APOOL; k++) {
    const key = `pool:${k}`;
    for (let s = 0; s < 6; s++) {
      await atOn.delete(key);
      await atOn.get(key, async () => ({ n: k }), 300);
    }
  }

  const missOff = await bench(
    '  get — cold miss, adaptiveTtl=false (baseline)',
    async (i) => {
      const key = `miss:${i & APMASK}`;
      await atFetch3.delete(key);
      await atFetch3.get(key, async () => ({ n: i }), 300);
    },
    5_000, 100,
    'delete + instant fetchFn + l1.set — no tracker',
  );

  const missOn = await bench(
    '  get — cold miss, adaptiveTtl=true  (record+p95 active)',
    async (i) => {
      const key = `pool:${i & APMASK}`;
      await atOn.delete(key);
      await atOn.get(key, async () => ({ n: i }), 300);
    },
    5_000, 100,
    'delete + fetchFn + record() ring-buf write + ≤32-elem sort',
  );

  {
    const delta = missOn.nsPerOp - missOff.nsPerOp;
    const pct   = ((missOn.nsPerOp / missOff.nsPerOp - 1) * 100).toFixed(1);
    const col   = delta < 5_000 ? C.green : delta < 20_000 ? C.yellow : C.red;
    console.log(
      `  ${C.dim}  Fetch-path overhead: ${col}${delta >= 0 ? '+' : ''}${delta.toFixed(0)} ns/op` +
      ` (${pct}%)${C.reset}${C.dim} — record() O(1) write + ≤32-elem Array.sort${C.reset}`
    );
    note('  Fetch latency is always dominated by I/O. The tracker adds µs, not ms.');
  }

  // ── 17c. metrics() adaptiveTtl snapshot cost ───────────────────────────

  header('  17c. metrics() — adaptiveTtl snapshot overhead');
  note('  snapshot() sorts all tracked keys by p95Ms descending, then slices the top 20.');

  const metricsOff = await bench(
    `  metrics() — adaptiveTtl=false (baseline, ${APOOL} keys in pool)`,
    () => { atOff.metrics(); },
    50_000, 1_000,
    'no adaptiveTtl section in output — baseline',
  );

  const metricsOn = await bench(
    `  metrics() — adaptiveTtl=true  (${APOOL} tracked keys, top-20 snapshot)`,
    () => { atOn.metrics(); },
    50_000, 1_000,
    `O(${APOOL}) scan + O(${APOOL} log ${APOOL}) sort + slice(0,20)`,
  );

  {
    const delta = metricsOn.nsPerOp - metricsOff.nsPerOp;
    const pct   = ((metricsOn.nsPerOp / metricsOff.nsPerOp - 1) * 100).toFixed(1);
    const col   = delta < 10_000 ? C.green : delta < 50_000 ? C.yellow : C.red;
    console.log(
      `  ${C.dim}  metrics() overhead: ${col}${delta >= 0 ? '+' : ''}${delta.toFixed(0)} ns/op` +
      ` (${pct}%)${C.reset}${C.dim} — O(${APOOL} log ${APOOL}) sort, scales with tracked key count${C.reset}`
    );
    note('  Recommendation: poll metrics() every 10–30 s — snapshot cost is fully amortised.');
  }

  await atOff.destroy();
  await atOn.destroy();
  await atFetch3.destroy();
  cleanup(atDir1, atDir2, atDir3);
}

// ─────────────────────────────────────────────────────────────────────────────
//  18. Stability soak — throughput over sustained load
// ─────────────────────────────────────────────────────────────────────────────
//
// Samples throughput in 1-second windows for SOAK_DURATION_MS milliseconds.
// Coefficient of Variation (CV = σ/μ) shows whether throughput is stable:
//
//   CV < 5 %  → stable  (green)  — GC pauses & JIT fully amortised
//   CV 5–15 % → jitter  (yellow) — occasional GC pause or eviction spike
//   CV > 15 % → unstable (red)   — investigate heap growth or eviction churn
//
// Default run is 10 seconds — long enough to catch first-gen GC pauses and
// JIT recompilation but short enough to not dominate CI wall-time.
//
// For a proper long-duration soak (heap growth, bloom saturation, GC
// degeneration over time), increase via the environment variable:
//
//   SOAK_MS=3600000 pnpm bench
//

header(`Stability soak — ${SOAK_DURATION_MS / 1_000} s sustained load (${SOAK_WINDOW_MS} ms windows)`);
note('CV = σ/μ. < 5% stable (green), 5–15% minor jitter (yellow), > 15% unstable (red).');
note(`Run with SOAK_MS=60000 pnpm bench for a 1-minute soak (default ${SOAK_DURATION_MS / 1_000} s).`);
note(`Run with SOAK_WINDOW_MS=100 pnpm bench to expose individual GC pause spikes (default ${SOAK_WINDOW_MS} ms).`);
note('Reports event-loop utilisation (ELU) and GC pause events. Event-loop delay shown only when timer callbacks can fire (I/O-bound workloads); in pure-microtask workloads use CV above as the stability signal.');

{
  const soakDir1 = makeTempDir();
  const soakDir2 = makeTempDir();

  // Force a full GC cycle before the soak to clear accumulated garbage from
  // all previous benchmark sections. Without this, heap is near-full from
  // msgpack Buffers, Promise objects, and disk-write backlog, causing
  // concurrent GC to compete with the soak and inflate CV.
  // Requires --expose-gc (added to the bench npm script).
  const gc = (globalThis as any).gc as (() => void) | undefined;
  gc?.(); gc?.(); // two passes: first collects objects, second collects finalizers

  // ── Event-loop & GC instrumentation ─────────────────────────────────────
  // Measured across all three soak sub-benchmarks combined, reflecting the
  // behaviour of a real long-running process rather than a single operation.
  const eluStart      = nodePerf.eventLoopUtilization();
  // setInterval-based delay tracking: measures how late the JS timer fires vs scheduled.
  // monitorEventLoopDelay (native histogram) silently produces wrong results at 100% CPU
  // utilisation — its HDR histogram stays empty and percentile() returns the bucket floor
  // while max returns 0, creating an impossible max < p50 in the output.
  const DELAY_TICK_MS = 5;
  let   _tickBase     = performance.now();
  const rawDelaysMs: number[] = [];          // excess delay per tick (ms)
  const delayTicker = setInterval(() => {
    const now    = performance.now();
    rawDelaysMs.push(Math.max(0, now - _tickBase - DELAY_TICK_MS));
    _tickBase = now;
  }, DELAY_TICK_MS);
  const gcPauses: number[] = [];             // duration in ms per GC pause
  const gcObs = new PerformanceObserver(list => {
    for (const e of list.getEntries()) gcPauses.push(e.duration);
  });
  gcObs.observe({ entryTypes: ['gc'] });

  const soakSvc = CacheService.reset({
    disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    l1MaxEntries: 50_000, l1MaxBytes: 400 * 1024 * 1024,
    diskCacheDir: soakDir1,
  });
  // Pre-warm: ensures L1 is populated and JIT is fully compiled before windows start.
  for (let i = 0; i < 5_000; i++) await soakSvc.set(`sk:hot:${i % 2_000}`, { n: i }, 300);

  // ── A. Hot get — should be very stable, GC is main source of jitter ────
  await soakBench(
    'L1 hot get — sustained',
    async i => { await soakSvc.get(`sk:hot:${i % 2_000}`, async () => ({ n: i }), 300); },
    SOAK_DURATION_MS, SOAK_WINDOW_MS,
    'bloom → Map.get; expect CV < 5%',
  );

  // ── B. Set with headroom — disk spill is async so shouldn't dominate ───
  await soakBench(
    'CacheService set — headroom, sustained',
    async i => { await soakSvc.set(`sk:set:${i % 2_000}`, { n: i }, 300); },
    SOAK_DURATION_MS, SOAK_WINDOW_MS,
    'pack + Map.set + fire-and-forget disk.save; expect CV < 10%',
  );

  // ── C. Set under eviction — reservoir sort fires on every op ───────────
  // Force GC before the eviction soak: fire-and-forget disk.save() calls from sections A/B
  // accumulate garbage; clearing it here prevents concurrent GC from inflating CV.
  gc?.();
  const soakSvcEvict = CacheService.reset({
    disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    l1MaxEntries: 200, l1MaxBytes: 2 * 1024 * 1024,
    diskCacheDir: soakDir2,
  });
  for (let i = 0; i < 200; i++) await soakSvcEvict.set(`sk:fill:${i}`, { n: i }, 300);

  await soakBench(
    'CacheService set — eviction every set, sustained',
    async i => { await soakSvcEvict.set(`sk:ov:${i}`, { n: i }, 300); },
    SOAK_DURATION_MS, SOAK_WINDOW_MS,
    'reservoir eviction every set; CV reveals GC/eviction interaction',
  );

  // ── Event-loop & GC health report ─────────────────────────────────────
  clearInterval(delayTicker);
  gcObs.disconnect();
  const elu    = nodePerf.eventLoopUtilization(eluStart);
  const eluPct = (elu.utilization * 100).toFixed(1);
  const eluCol = elu.utilization > 0.95 ? C.red : elu.utilization > 0.80 ? C.yellow : C.green;
  // Sorted array guarantees p50 ≤ p99 ≤ max. Show µs when < 1 ms for sub-ms readability.
  // Guard: in pure-microtask workloads (cache hits, synchronous-resolve async paths) the
  // libuv timers phase is starved by the microtask queue — setInterval never fires and the
  // array stays empty. Guard against that and explain it rather than showing 0.0 µs.
  console.log(`  ${C.dim}  event-loop utilisation : ${eluCol}${eluPct}%${C.reset}${C.dim}  (100% expected in a benchmark; > 80% in production warrants investigation)${C.reset}`);
  rawDelaysMs.sort((a, b) => a - b);
  const fmtMs = (ms: number) => ms < 1 ? `${(ms * 1e3).toFixed(1)} µs` : `${ms.toFixed(2)} ms`;
  if (rawDelaysMs.length >= 10) {
    const delayP50 = rawDelaysMs[Math.floor(rawDelaysMs.length * 0.50)];
    const delayP99 = rawDelaysMs[Math.floor(rawDelaysMs.length * 0.99)];
    const delayMax = rawDelaysMs[rawDelaysMs.length - 1];
    const p99Col = delayP99 > 50 ? C.red : delayP99 > 10 ? C.yellow : C.green;
    console.log(`  ${C.dim}  event-loop p50 delay   : ${fmtMs(delayP50)}${C.reset}`);
    console.log(`  ${C.dim}  event-loop p99 delay   : ${p99Col}${fmtMs(delayP99)}${C.reset}${delayP99 > 10 ? `${C.dim}  ← GC / IO pressure${C.reset}` : ''}`);
    console.log(`  ${C.dim}  event-loop max delay   : ${fmtMs(delayMax)}${C.reset}`);
  } else {
    console.log(`  ${C.dim}  event-loop delay       : n/a — libuv timer phase starved by pure-microtask workload (${rawDelaysMs.length} tick${rawDelaysMs.length === 1 ? '' : 's'} recorded); use CV above as the stability signal${C.reset}`);
  }
  if (gcPauses.length) {
    const sortedGc = gcPauses.slice().sort((a, b) => a - b);
    const gcP50ms  = sortedGc[Math.floor(sortedGc.length / 2)].toFixed(2);
    const gcMaxMs  = sortedGc[sortedGc.length - 1].toFixed(2);
    console.log(`  ${C.dim}  GC pauses              : ${gcPauses.length} events, p50 ${gcP50ms} ms, max ${gcMaxMs} ms${C.reset}`);
  } else {
    console.log(`  ${C.dim}  GC pauses              : none observed (V8 concurrent GC may produce pauses < 1 ms not visible here)${C.reset}`);
  }

  const mem = process.memoryUsage();
  const heapPct = (mem.heapUsed / mem.heapTotal * 100).toFixed(1);
  const heapCol = mem.heapUsed / mem.heapTotal > 0.90 ? C.red
                : mem.heapUsed / mem.heapTotal > 0.75 ? C.yellow
                : C.green;
  console.log(
    `  ${C.dim}  heap after soak: ` +
    `${fmtBytes(mem.heapUsed)} used / ${fmtBytes(mem.heapTotal)} total ` +
    `(${heapCol}${heapPct}%${C.reset}${C.dim})${C.reset}`,
  );
  if (mem.heapUsed / mem.heapTotal > 0.90) {
    note('heap > 90% after soak — risk of OOM on longer runs. Lower l1MaxBytes or set l1EvictionWatermark: 0.8.');
  }

  await soakSvcEvict.destroy();
  await soakSvc.destroy();
  cleanup(soakDir1, soakDir2);
}

await svc.destroy();
cleanup(benchDir, evictDir, oomDir, nsADir, nsBDir);

// ─────────────────────────────────────────────────────────────────────────────
//  19. v0.6.1 features — evictSetBefore, disableDisk, worker pool
// ─────────────────────────────────────────────────────────────────────────────

// ── 19a. evictSetBefore — staleness fence (Fix 2 / Fix 4) ────────────────────
//
// When the backplane pub/sub socket reconnects after a gap > backplaneMaxStalenessMs,
// evictSetBefore(disconnectedAt) is called to flush L1 entries written before the gap.
// The cost is O(entries) for the Map scan + bloom rebuild when entries are evicted.
// Understanding this cost matters for sizing backplaneMaxStalenessMs vs L1 size.

header('§19a. evictSetBefore — staleness fence flush cost vs L1 size');
note('O(entries) Map scan + conditional bloom rebuild (only when entries are actually evicted).');
note('CRITICAL live entries are skipped — they are preserved even during a full flush.');
note('Two measurements: scan-only (cutoff=0, nothing evicted) vs full flush (Infinity, all evicted).');

for (const [label, count] of [['1 K entries', 1_000], ['5 K entries', 5_000], ['20 K entries', 20_000]] as Array<[string, number]>) {
  const evL1 = new SmartMemoryCache({
    maxBytes:   200 * 1024 * 1024,
    maxEntries: count + 100,
    categories: { default: { maxEntries: count + 100, maxSizeBytes: 200 * 1024 * 1024 } },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });

  for (let i = 0; i < count; i++) evL1.set(`e:${i}`, { n: i }, 300_000, CachePriority.NORMAL);

  // ── Measurement 1: scan-only (nothing evicted) ────────────────────────
  // cutoff=0: setAt = expiresAt - ttlMs ≥ 0, so setAt < 0 is never true.
  // Models the common case: backplane reconnects quickly, all L1 entries are fresh.
  await bench(
    `evictSetBefore scan-only, 0 evictions — ${label}`,
    () => { evL1.evictSetBefore(0); },
    5_000, 50,
    'cutoff=0 → setAt≥0 for all entries → pure O(n) Map scan; no bloom rebuild',
  );

  // ── Measurement 2: full flush (all entries evicted + bloom rebuild) ────
  // Infinity cutoff: setAt < ∞ always → all entries evicted.
  // Models a long backplane outage: everything is stale, cache is nuked.
  // Refill is included in the measured time; annotated accordingly.
  await bench(
    `evictSetBefore full flush + refill   — ${label}`,
    () => {
      evL1.evictSetBefore(Infinity);
      for (let i = 0; i < count; i++) evL1.set(`e:${i}`, { n: i }, 300_000, CachePriority.NORMAL);
    },
    20, 3,
    `O(n) scan + bloom rebuild + ${count} set() refill; bloom rebuild dominates at large N`,
  );
}

// ── 19b. disableDisk — ephemeral-mode throughput vs disk-enabled ──────────────
//
// In serverless/ephemeral environments (Lambda, Cloud Run, Fly.io), disableDisk:true
// removes all I/O from the hot path. This section quantifies the overhead eliminated.

header('§19b. disableDisk:true vs default — serverless throughput lift');
note('disableDisk:true skips all disk.save() (L1 spill), disk.load() (L1.5 reads),');
note('and all disk janitor ticks. Only L1 RAM tier is active.');
note('Overhead is only visible under L1 eviction pressure (spill path). Hot hits are identical.');

{
  const ddDiskDir   = makeTempDir();
  const ddNoDiskDir = makeTempDir();

  const ddWithDisk = CacheService.reset({
    namespace: 'dd-disk', disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    l1MaxEntries: 300, l1MaxBytes: 10 * 1024 * 1024,
    diskCacheDir: ddDiskDir,
    disableDisk:  false,
  });

  const ddNoDisk = CacheService.reset({
    namespace: 'dd-nodisk', disableRedis: true, oomProtection: false, metricsIntervalMs: 0,
    l1MaxEntries: 300, l1MaxBytes: 10 * 1024 * 1024,
    diskCacheDir: ddNoDiskDir,
    disableDisk:  true,
  });

  // Pre-fill both to L1 capacity so every set() triggers eviction (and disk spill for the disk instance)
  for (let i = 0; i < 300; i++) {
    await ddWithDisk.set(`pre:${i}`, { n: i }, 300);
    await ddNoDisk.set(`pre:${i}`, { n: i }, 300);
  }

  // ── 19b-1. L1 hot hit — identical path, should show no difference ──────
  header('  19b-1. L1 hot hit — disableDisk has no effect (hit returns from RAM)');
  note('  The disk.load() path is only reached on an L1 miss. Hot hits are identical.');

  await bench(
    '  get — L1 hot hit, disk ENABLED',
    async i => { await ddWithDisk.get(`pre:${i % 300}`, async () => ({ n: i }), 300); },
    50_000, 500, 'bloom → Map.get → return; disk never reached',
  );

  await bench(
    '  get — L1 hot hit, disk DISABLED (disableDisk:true)',
    async i => { await ddNoDisk.get(`pre:${i % 300}`, async () => ({ n: i }), 300); },
    50_000, 500, 'same path — no observable difference expected',
  );

  // ── 19b-2. set under eviction — disk spill (async) is eliminated ────────
  header('  19b-2. set under eviction — fire-and-forget disk.save() eliminated');
  note('  Each set() triggers L1 eviction. Evicted entries are spilled to disk (async setImmediate).');
  note('  With disableDisk:true the spill is a no-op — no I/O queued, no file descriptor opened.');
  note('  Main-thread cost difference is the setImmediate closure creation + disk.save() path.');

  const diskRes = await bench(
    '  set — eviction pressure, disk ENABLED  (spill fires async)',
    async i => { await ddWithDisk.set(`ov:${i}`, { n: i }, 300); },
    5_000, 100, 'l1.set → evict → setImmediate(disk.save) — I/O async',
  );

  const noDiskRes = await bench(
    '  set — eviction pressure, disk DISABLED (spill is no-op)',
    async i => { await ddNoDisk.set(`ov:${i}`, { n: i }, 300); },
    5_000, 100, 'l1.set → evict → diskSpill guard check → return',
  );

  const liftPct = ((diskRes.nsPerOp - noDiskRes.nsPerOp) / diskRes.nsPerOp * 100).toFixed(1);
  const liftCol = parseFloat(liftPct) > 5 ? C.green : parseFloat(liftPct) > 0 ? C.yellow : C.dim;
  console.log(
    `  ${C.dim}  Main-thread savings (eviction path): ${liftCol}${liftPct}%${C.reset}${C.dim}` +
    ` (disk.save() is async — real I/O savings are in OS file descriptors / syscalls, not latency)${C.reset}`,
  );

  await ddWithDisk.destroy();
  await ddNoDisk.destroy();
  cleanup(ddDiskDir, ddNoDiskDir);
}

// ── 19c. Worker pool — off-thread AES-GCM vs sync ───────────────────────────
//
// Worker thread offload is only beneficial when payloads are large enough to
// amortise the IPC round-trip (~50–200 µs on Node.js). Below ~64 KB, sync
// AES-GCM is faster. This section measures the crossover point.
//
// Note: workers are spawned from src/serialize-worker.ts via tsx (dev) or
// from dist/serialize-worker.js (production). The throughput shown here is
// for a single worker — real usage uses workerPoolSize (default: min(4,CPUs)).

header('§19c. Worker pool — off-thread AES-GCM throughput vs sync (per round-trip)');
note('IPC round-trip cost amortises at ~64–128 KB (varies by CPU / Node.js version).');
note('Below threshold: sync AES-GCM wins (no IPC overhead).');
note('Above threshold: worker offload frees the event loop for concurrent work.');
note('workerPoolSize=1 here to show per-round-trip cost; pool(4) gives ~4× throughput.');

{
  const { WorkerPool } = await import('../src/worker-pool.js');
  const { CacheEncryption: BenchEnc } = await import('../src/encryption.js');

  const key32 = crypto.randomBytes(32).toString('base64');
  const enc   = new BenchEnc(key32, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} });

  // Helper: measure sync encrypt+decrypt (main-thread, no worker)
  const syncRoundTrip = (plaintext: string): void => {
    const ct = enc.encrypt(plaintext);
    enc.decrypt(ct);
  };

  let pool: InstanceType<typeof WorkerPool> | null = null;
  try {
    pool = new WorkerPool({
      keyBase64: key32,
      mode:      'aes-256-gcm',
      size:      1, // single worker — measures per-round-trip IPC cost
    });
    if (!pool.isAvailable) {
      pool = null;
      note('Worker pool unavailable in this environment — run pnpm build first for compiled workers.');
    }
  } catch {
    note('Worker pool init failed — worker benchmark skipped.');
  }

  for (const [label, sizeBytes] of [
    ['4 KB',    4 * 1024],
    ['16 KB',  16 * 1024],
    ['64 KB',  64 * 1024],
    ['128 KB', 128 * 1024],
    ['512 KB', 512 * 1024],
  ] as Array<[string, number]>) {
    const plaintext = 'x'.repeat(sizeBytes);

    await bench(
      `sync AES-256-GCM round-trip   (${label})`,
      () => { syncRoundTrip(plaintext); },
      Math.max(500, Math.round(5_000_000 / sizeBytes)), 50,
      'main-thread encrypt+decrypt; no IPC cost',
    );

    if (pool?.isAvailable) {
      await bench(
        `worker AES-256-GCM round-trip (${label})`,
        async () => {
          const ct = await pool!.encrypt(plaintext);
          await pool!.decrypt(ct);
        },
        Math.max(100, Math.round(500_000 / sizeBytes)), 10,
        'IPC → worker → encrypt → IPC back; use for payloads > workerThresholdBytes',
      );
    }
  }

  await pool?.destroy();
}

process.exit(0);


