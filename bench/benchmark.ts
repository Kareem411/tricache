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
}, 500_000, 5_000, '7 hash rounds → Map.get → decompress if needed');

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
const userCountBefore = catL1.getStats().categories['user:'] ?? 0;

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
  const userAfter = statsPost.categories['user:']      ?? 0;
  const analAfter = statsPost.categories['analytics:'] ?? 0;
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

const nsMixed = (ns: CacheService) => async (i: number): Promise<void> => {
  const r = Math.random();
  if      (r < 0.80) { await ns.get(`hot:${i % NS_HOT}`,  async () => ({ v: i }), 300); }
  else if (r < 0.95) { await ns.get(`miss:${i % 100}`, async () => ({ v: i }), 5); }
  else               { await ns.set(`hot:${i % NS_HOT}`,  { v: i }, 300); }
};

const nsResA = await bench('  org_a — 80/15/5 workload', nsMixed(nsA), 10_000, 200, 'independent L1 + disk + inflight Map');
const nsResB = await bench('  org_b — 80/15/5 workload', nsMixed(nsB), 10_000, 200, 'independent L1 + disk + inflight Map');
console.log(
  `  ${C.dim}  Throughput ratio A/B: ${(nsResA.opsPerSec / nsResB.opsPerSec).toFixed(2)}× — expect ≈ 1.0 (fully independent)${C.reset}`
);

await nsA.destroy();
await nsB.destroy();

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
cleanup(benchDir, evictDir, oomDir, nsADir, nsBDir);
process.exit(0);

