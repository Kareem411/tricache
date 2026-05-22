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
 * 10. End-to-end: realistic workload (80% hot read, 15% cold miss, 5% write)
 *
 * Concurrency notes printed inline explain whether an operation is truly
 * concurrent, where the "lock" is (the inflight Map), and which path wins.
 */

import { CacheService }                 from '../src/cache-service';
import { SmartMemoryCache }             from '../src/smart-memory-cache';
import { CachePriority, consoleLogger } from '../src/types';
import os   from 'os';
import path from 'path';
import { rmSync, mkdtempSync } from 'fs';

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

// ─── Setup ────────────────────────────────────────────────────────────────────

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

for (let i = 0; i < 10_000; i++) {
  l1.set(`hot:${i}`, { id: i, payload: 'x'.repeat(32) }, 60_000,
    { priority: CachePriority.NORMAL });
}

await bench('get — hot hit (10 K resident entries)', i => {
  l1.get(`hot:${i % 10_000}`);
}, 500_000, 5_000, 'bloom → Map lookup');

await bench('get — cold miss (key never set)', i => {
  l1.get(`never:${i}`);
}, 500_000, 5_000, 'bloom gates → early return');

await bench('set — tiny  (< 512B, no compression)', i => {
  l1.set(`s:${i % 5_000}`, { n: i }, 60_000);
}, 200_000, 2_000, 'Map.set + bloom.add');

await bench('set — small (≈ 512B, boundary)', i => {
  l1.set(`b:${i % 5_000}`, { d: 'a'.repeat(480), n: i }, 60_000);
}, 100_000, 1_000, 'JSON.stringify size check near threshold');

const largeVal = { data: 'y'.repeat(2_048), rows: Array.from({ length: 20 }, (_, k) => ({ id: k })) };
await bench('set — large (≥ 512B, msgpackr compress)', i => {
  l1.set(`l:${i % 5_000}`, largeVal, 60_000);
}, 100_000, 1_000, 'pack() + byte-size estimate');

await bench('set — CRITICAL priority (never evicted)', i => {
  l1.set(`auth:tok:${i % 1_000}`, { token: 'x'.repeat(40) }, 300_000,
    { priority: CachePriority.CRITICAL });
}, 100_000, 1_000, 'same path as NORMAL but skipped in eviction sort');

await bench('delete — exact key', i => {
  l1.delete(`hot:${i % 10_000}`);
}, 100_000, 1_000, 'Map.delete (bloom has no remove)');

await bench('deletePattern — glob wildcard', i => {
  l1.deletePattern(`s:${i % 100}*`);
}, 20_000, 200, 'full Map scan — O(n) linear');

// ─────────────────────────────────────────────────────────────────────────────
//  2. Bloom filter cost breakdown
// ─────────────────────────────────────────────────────────────────────────────

header('Bloom filter — cost breakdown');
note('Bloom is O(k) per op (k=7 hash rounds). A definite-miss avoids a Map lookup entirely.');
note('False positives still trigger a Map.get() that returns undefined — wasted work.');

for (let i = 0; i < 10_000; i++) l1.set(`bf:${i}`, i, 60_000);

await bench('get — definite miss (novel key, never set)', i => {
  l1.get(`bloom-miss:novel-${i}`);
}, 500_000, 5_000, '7 hash rounds → bit check → return null');

await bench('get — hit path (key confirmed in bloom)', i => {
  l1.get(`bf:${i % 10_000}`);
}, 500_000, 5_000, '7 hash rounds → Map.get → decompress if needed');

// ─────────────────────────────────────────────────────────────────────────────
//  3. Compression cost vs savings
// ─────────────────────────────────────────────────────────────────────────────

header('Compression — size vs latency trade-off');
note('msgpackr invoked when JSON.stringify(value).length >= 512 bytes.');
note('Compressed entries save heap but cost ~1–3 µs per set. Reads pay unpack() cost.');

for (const sz of [128, 256, 512, 1_024, 4_096, 16_384] as const) {
  const val        = { payload: 'z'.repeat(sz), id: 42 };
  const compressed = sz >= 512;
  await bench(
    `set ${String(sz).padStart(6)}B payload`,
    i => { l1.set(`cmp:${sz}:${i % 2_000}`, val, 60_000); },
    50_000, 500,
    compressed ? 'pack() path' : 'plain JSON path',
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
  5_000, 50, 'O(n log n) sort on 200 entries per call',
);

console.log(
  `  ${C.dim}  Eviction overhead: ${(evictRes.nsPerOp / headroomRes.nsPerOp).toFixed(1)}× slower than headroom path${C.reset}`
);
note('If eviction is >10× slower: increase maxEntries to reduce pressure.');
note('Prefer exact-key deletes over relying on eviction for hot-key churn.');

await tightSvc.destroy();

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
console.log(`  ${C.dim}bloom FP rate      : ${(fm.bloom.falsePositiveRate * 100).toFixed(3)}%${C.reset}`);
console.log(`  ${C.dim}compression saved  : ${fmtBytes(fm.compression.bytesSaved)}${C.reset}`);
console.log(`  ${C.dim}L1 entries         : ${fm.l1.entries.toLocaleString()} / ${(fm.l1.maxBytes / 1024 / 1024).toFixed(0)} MB cap${C.reset}`);
console.log(`  ${C.dim}L1 used            : ${fmtBytes(fm.l1.sizeBytes)}${C.reset}`);
console.log(`  ${C.dim}disk files         : ${fm.disk.files}${C.reset}`);

console.log(`\n${C.bold}${C.green}  Bottleneck cheat-sheet${C.reset}`);
console.log(`  ${C.dim}• L1 hot get > 5 M/s?     → bloom + Map.get are your ceiling. Nothing to optimise.${C.reset}`);
console.log(`  ${C.dim}• L1 hot get < 1 M/s?     → GC pressure. Reduce maxEntries or entry payload size.${C.reset}`);
console.log(`  ${C.dim}• set (large) slow?        → msgpackr cost. Raise the 512B compression threshold.${C.reset}`);
console.log(`  ${C.dim}• glob delete slow?        → O(n) Map scan. Prefer namespaced exact deletes.${C.reset}`);
console.log(`  ${C.dim}• coalescing efficiency<100% → keys expiring mid-flight; increase TTL.${C.reset}`);
console.log(`  ${C.dim}• parallel ≈ serial (CPU)  → expected — JS is single-threaded.${C.reset}`);
console.log(`  ${C.dim}• parallel >> serial (I/O) → I/O overlap via Promise.all event-loop ticks.${C.reset}`);
console.log(`  ${C.dim}• eviction >>10× headroom  → cache is over-full; increase l1MaxEntries.${C.reset}`);
console.log('');

await svc.destroy();
cleanup(benchDir, evictDir, oomDir);
process.exit(0);

