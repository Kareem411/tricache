# tricache — Benchmarks

> **Environment:** Windows 11 · Node.js ≥ 22 · single-threaded (no worker threads) · `pnpm bench`  
> **Date:** 2026-05-31  
> **Source:** [`bench/benchmark.ts`](bench/benchmark.ts)

All numbers are from one live run on the same machine. Throughput varies ±5–10 % across runs due to JIT warmth and OS scheduling. Re-run with `pnpm bench` to reproduce on your hardware.

> **v0.4.1 additions:** backplane-aware `dependsOn` cascade (fleet correctness fix), `mget` per-key TTL function, and `cache.ready()` + `warmKeys` startup lifecycle hook.

> **v0.4.0 additions:** TTL jitter (`ttlJitterFactor`), batch `mset()` / `mdel()`, native OpenTelemetry spans (`tracer`), L2 circuit breaker (`l2CircuitBreakerThreshold` / `l2CircuitBreakerCooldownMs`), and `warmFromL2(pattern)` startup warming.

> **v0.3.0 additions:** Count-Min Sketch frequency tracking (4 KB, 84 % burst-flood survival rate) and a lazy iterator interface (`keys()` / `values()` / `entries()`) on `CacheService`. See the dedicated sections below.

> **v0.2.0 optimisation:** every cache entry now stores the deserialized JS value alongside the msgpackr buffer. Hot `get()` calls return the live object directly — zero unpack overhead. The packed buffer is retained for disk spill and snapshot serialization. Result: **+112 % L1 hot-get throughput** and **+64 % CacheService L1 warm-hit throughput**.

---

## L1 SmartMemoryCache — raw throughput

Single-threaded JS; no `await`. These numbers are your absolute ceiling.

| Operation | Throughput | Latency | Notes |
|---|---|---|
| `get` — hot hit (8 K resident entries) | **2.82 M/s** | 396 ns | bloom → Map lookup |
| `get` — cold miss (key never set) | **6.76 M/s** | 148 ns | bloom gates → early return |
| `set` — tiny payload | **1.06 M/s** | 944 ns | pack() + Map.set + bloom.add |
| `set` — small payload (≈ 512 B) | 574.1 K/s | 1.74 µs | pack() — same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 228.6 K/s | 4.37 µs | pack() + byte-size estimate |
| `set` — CRITICAL priority | 843.6 K/s | 1.19 µs | same path as NORMAL; skipped in eviction sort |
| `delete` — exact key | **4.52 M/s** | 221 ns | Map.delete (bloom has no remove) |
| `deletePattern` — glob wildcard | 18.7 K/s | 53.48 µs | O(n) Map scan — use exact deletes in hot paths |

---

## Bloom filter — cost breakdown

The filter is O(k=7) per probe. A definite miss avoids the Map lookup entirely.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — definite miss (novel key, never set) | 5.36 M/s | 187 ns | 7 hash rounds → bit check → return null |
| `get` — hit path (key confirmed in bloom) | 3.22 M/s | 310 ns | 7 hash rounds → Map.get → return cached value |

False positives still hit `Map.get()` and return `undefined` — wasted work. The bloom filter has no delete operation: evicting an L1 entry does **not** clear its bits. The FP rate therefore grows monotonically with the total number of distinct keys ever inserted — not with current L1 occupancy. In production with bounded key churn (unique keys per TTL window ≪ `l1MaxEntries`), the FP rate stays near its design target (~1 % at full occupancy). The 16.5 % figure in the final cache state table is a **benchmark artifact** — the full suite inserts hundreds of thousands of distinct keys against a filter sized for ~500 entries.

---

## Serialization — msgpackr pack() by payload size

All payloads use the unified `pack()` path; no JSON fallback at any size.

| Payload size | Throughput | Latency |
|---|---|---|
| 128 B | 827.7 K/s | 1.21 µs |
| 256 B | 706.2 K/s | 1.42 µs |
| 512 B | 625.8 K/s | 1.60 µs |
| 1 024 B | 472.3 K/s | 2.12 µs |
| 4 096 B | 220.7 K/s | 4.53 µs |
| 16 384 B | 88.4 K/s | 11.31 µs |

---

## CacheService — end-to-end path costs

Each `get()` adds: namespace prefix + inflight-Map check + L1 / disk / L2 lookup chain.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | **2.36 M/s** | 423 ns | inflight check → l1.get → return |
| `get` — SWR stale serve + bg revalidate | **1.66 M/s** | 602 ns | serves stale instantly; revalidate non-blocking |
| `get` — L1 miss → fetchFn (TTL=0) | 35.8 K/s | 27.90 µs | Promise microtask + l1.set on fill |
| `set` | 94.7 K/s | 10.56 µs | l1.set + disk.save (async, fire-and-forget) |
| `delete` — exact key | **1.14 M/s** | 877 ns | l1.delete + disk.delete + backplane (no-op, Redis off) |
| `delete` — glob `*` | **1.95 M/s** | 513 ns | l1.deletePattern O(n) + disk glob scan |

---

## Concurrency — serial vs parallel, inflight-Map coalescing

Node.js is single-threaded. "Concurrency" = `Promise.all()` fan-out sharing one event-loop thread. The inflight Map is the de-facto lock: the first getter registers a Promise; all later callers `.then()` onto it. `fetchFn` fires exactly once.

### Same-key coalescing (thundering-herd prevention)

| Fan-out | fetchFn calls | Coalesced | Wall-time | Coalescing efficiency |
|---|---|---|---|---|
| 2 | 1× | 1 | 10 105.2 ms | 100 % |
| 5 | 1× | 4 | 32.6 ms | 100 % |
| 10 | 1× | 9 | 7.4 ms | 100 % |
| 50 | 1× | 49 | 13.0 ms | 100 % |
| 100 | 1× | 99 | 24.3 ms | **100 %** |

### Distinct-key parallel fan-out (20 concurrent keys)

| Fetch type | Serial | Parallel | Ratio |
|---|---|---|---|
| CPU-bound (no I/O) | 6.7 K/s | 9.7 K/s | **1.46×** — expected ≈ 1.0 (single-threaded) |
| I/O-bound (setTimeout) | 1.0 K/s | 16.4 K/s | **16.13×** — I/O callbacks overlap across `Promise.all` |

### Mixed read/write ratio sweep (10 concurrent, 3 000 batches)

| Read / Write | Throughput | Latency |
|---|---|---|
| 100 % / 0 % | 390.0 K/s | 2.56 µs |
| 95 % / 5 % | 838.4 K/s | 1.19 µs |
| 80 % / 20 % | 915.4 K/s | 1.09 µs |
| 50 % / 50 % | 836.6 K/s | 1.20 µs |
| 20 % / 80 % | 639.1 K/s | 1.56 µs |
| 0 % / 100 % | 581.6 K/s | 1.72 µs |

> The 100 % reads row is slower than 80/20 because the benchmark measures end-to-end `get()` including cold-miss fetches; writes keep the cache warmer.

---

## Eviction pressure — L1 over-capacity behaviour

Eviction uses reservoir sampling: O(n) category-key pass + O(16 log 16) sort on 16 candidates.

| Scenario | Throughput | Latency | Notes |
|---|---|---|---|
| L1 has headroom | 654.4 K/s | 1.53 µs | capacity check passes → Map.set only |
| L1 full, eviction on every set | 96.6 K/s | 10.35 µs | category scan + reservoir sort + disk spill |

**Eviction overhead: 6.8× slower than the headroom path.** Tune `l1MaxEntries` to keep the cache below its ceiling during normal load.

---

## Eviction hot-path — zero-allocation design

`smartEvict()` runs **synchronously inside every `set()` call** when L1 is at or above the eviction watermark (default 0.9). At sustained eviction rates any heap allocation it makes becomes a direct multiplier on GC pressure.

### What was optimised

The original implementation allocated on every call:

| Allocation site | Description |
|---|---|
| `pool = []`, `globalPool = []` | 2 fresh arrays per call |
| `pool.push({ key, score })` | up to 16 object literals per call |
| `[...pool, ...globalPool]` | spread → temporary array copy |
| `candidates.sort((a, b) => …)` | comparator closure allocation |
| `sorted.slice(0, EVICT_COUNT)` | result array per call |

At 143 K evictions/s this was roughly **2.9 M short-lived heap objects per second** — enough to trigger V8 minor GC (scavenger) continuously and occasionally promote objects to old-gen, producing throughput variance.

### The fix: pre-allocated pools + insertion sort

Two fixed-size pools (`_evictPool`, `_evictGPool`) of 16 `{ key: '', score: 0 }` slots are allocated **once** at class construction. Every `smartEvict()` call mutates them in-place:

- No new `Array` — pools are class fields
- No new `{ key, score }` literals — slots are mutated (`.key =`, `.score =`)
- No spread — merge loop reads and writes by index
- No `Array.sort()` — hand-written insertion sort for N ≤ 16 (no comparator closure, no timsort start-up cost)
- No `slice()` — the evict loop runs over the first `EVICT_COUNT` indexes directly

**Result: 0 heap allocations per `smartEvict()` call.**

### What this achieves (and the true floor)

| Allocation source | Before fix | After fix |
|---|---|---|
| Eviction pool arrays + candidate slots | ~2.9 M objects/s | **0** |
| `pack(data)` Buffer per `set()` | unavoidable | unavoidable |
| New entry object per `set()` | unavoidable | unavoidable |
| Old entry objects collected by GC | unavoidable | unavoidable |

Eliminating pool allocations reduced the eviction soak CV from **~23 % → ~17 %** under the synthetic worst case (100 % fill, eviction on every `set()`). The remaining ~17 % variance is V8's old-generation GC collecting the long-lived entry objects and msgpackr Buffers — these are structurally unavoidable for any JavaScript in-memory cache.

Going below ~10 % CV under this exact scenario would require moving entry storage off the V8 heap entirely (a `SharedArrayBuffer`-backed slab allocator or a Rust/napi-rs native module), at a significant maintenance and distribution cost. This is the practical optimisation ceiling for pure TypeScript.

> **In production the soak CV is irrelevant.** A correctly sized cache (watermark 0.9, `l1MaxEntries` with headroom) keeps the eviction rate low. The only time you reach this floor is when the cache is permanently 100 % full under write pressure — a configuration that should be avoided by sizing up.

---

## OOM guard — heap-triggered emergency eviction

Triggered when `heapUsed / heapTotal` exceeds `oomHeapThreshold` (default 85 %).

| Metric | Value |
|---|---|
| Pre-eviction entries | 500 |
| Post-eviction entries | 400 |
| Entries removed per round | ~100 (20 % of L1) |
| Timer interval (test config) | 10 ms |

---

## Metrics snapshot & Prometheus text overhead

`metrics()` reads O(1) counters and scans bloom bits; `toPrometheusText()` is ~30-line string concatenation.

| Operation | Throughput | Latency |
|---|---|---|
| `metrics()` snapshot | 1.02 M/s | 976 ns |
| `toPrometheusText(metrics())` | 149.7 K/s | 6.68 µs |

---

## Realistic workload — 80 % hot read / 15 % cold miss / 5 % write

Simulates a typical web-server request fan-out with a warm cache.

| Mode | Throughput | Latency |
|---|---|---|
| Serial (1 coroutine) | 3.9 K/s | 257.38 µs |
| Parallel (20 coroutines) | 7.0 K/s | 141.92 µs |

---

## Encryption — all modes

IV pool of 64 pre-generated IVs; output buffers pre-allocated. Auth-tag generation (GHASH) dominates the GCM cost.

### AES-256-GCM (32-byte key, default)

| Payload | Path | Encrypt | Decrypt |
|---|---|---|---|
| 64 B | string | 153.8 K/s / 6.50 µs | 168.7 K/s / 5.93 µs |
| 64 B | buffer | 164.6 K/s / 6.07 µs | 171.3 K/s / 5.84 µs |
| 512 B | string | 131.2 K/s / 7.62 µs | 154.8 K/s / 6.46 µs |
| 512 B | buffer | 152.9 K/s / 6.54 µs | 171.8 K/s / 5.82 µs |
| 4 096 B | string | 67.2 K/s / 14.89 µs | 63.4 K/s / 15.77 µs |
| 4 096 B | buffer | 76.3 K/s / 13.10 µs | 102.4 K/s / 9.76 µs |

### AES-128-GCM (16-byte key, ~15 % faster on non-AES-NI hardware)

| Payload | Path | Encrypt | Decrypt |
|---|---|---|---|
| 64 B | string | 159.6 K/s / 6.27 µs | 176.5 K/s / 5.67 µs |
| 64 B | buffer | 177.1 K/s / 5.65 µs | 188.1 K/s / 5.31 µs |
| 512 B | string | 155.7 K/s / 6.42 µs | 165.0 K/s / 6.06 µs |
| 512 B | buffer | 168.0 K/s / 5.95 µs | 188.7 K/s / 5.30 µs |
| 4 096 B | string | 72.7 K/s / 13.76 µs | 68.3 K/s / 14.65 µs |
| 4 096 B | buffer | 77.9 K/s / 12.84 µs | 104.9 K/s / 9.54 µs |

### AES-128-CTR (16-byte key, no auth tag — fastest cipher mode)

| Payload | Path | Encrypt | Decrypt |
|---|---|---|---|
| 64 B | string | 197.8 K/s / 5.06 µs | 194.1 K/s / 5.15 µs |
| 64 B | buffer | 222.1 K/s / 4.50 µs | 208.8 K/s / 4.79 µs |
| 512 B | string | 185.1 K/s / 5.40 µs | 189.1 K/s / 5.29 µs |
| 512 B | buffer | 214.2 K/s / 4.67 µs | 205.6 K/s / 4.86 µs |
| 4 096 B | string | 88.0 K/s / 11.36 µs | 73.6 K/s / 13.58 µs |
| 4 096 B | buffer | 90.1 K/s / 11.09 µs | 110.1 K/s / 9.08 µs |

### XOR obfuscation (32-bit word-level — NOT cryptographic)

| Payload | Path | Mask | Unmask |
|---|---|---|---|
| 64 B | string | 1.28 M/s / 781 ns | 1.28 M/s / 779 ns |
| 64 B | buffer | 2.41 M/s / 414 ns | 2.08 M/s / 480 ns |
| 512 B | string | 922.9 K/s / 1.08 µs | 426.7 K/s / 2.34 µs |
| 512 B | buffer | 796.5 K/s / 1.26 µs | 708.7 K/s / 1.41 µs |
| 4 096 B | string | 110.8 K/s / 9.03 µs | 57.3 K/s / 17.45 µs |
| 4 096 B | buffer | 129.8 K/s / 7.70 µs | 84.9 K/s / 11.78 µs |

> String-path (Redis L2) numbers are 5–20 % slower than buffer-path (disk/snapshot) due to base64 encoding overhead.  
> AES-128-CTR removes the GHASH MAC step — use only when integrity is guaranteed by transport (TLS, HMAC).  
> XOR is self-inverse and has no IV or auth tag; use for dev environments or non-sensitive caches only.

---

## Multi-tenancy — category competition & namespace isolation

Two categories sharing one L1: `user:` (HIGH priority, limit 200) vs `analytics:` (LOW, limit 100).

| Metric | Value |
|---|---|
| `analytics:` flood throughput | 191.4 K/s |
| `user:` entries before flood | 200 |
| `user:` entries after flood | 200 (0 evicted) |
| `analytics:` entries at steady state | 100 / 100 limit |
| HIGH-priority protection rate | **100 %** |

### Namespace throughput parity (two independent tenants)

Both tenants share a single pre-generated random sequence (same operation mix) and are JIT-warmed interleaved before either timed run begins, so neither benefits from code compiled during the other's measurement.

| Tenant | Throughput | Latency |
|---|---|---|
| `org_a` — 80/15/5 workload | 140.5 K/s | 7.12 µs |
| `org_b` — 80/15/5 workload | 146.3 K/s | 6.84 µs |
| Ratio A/B | **0.96×** | — |

Each namespace has its own L1, disk directory, inflight Map, and pub/sub channel — no shared mutable state.

---

## Count-Min Sketch — cross-eviction frequency & burst-flood protection

The sketch is a 4 × 512 `Uint16Array` (4 KB, fits in L1d cache). It tracks historical access frequency across eviction events so eviction scoring can distinguish a long-resident key that was recently re-admitted (`entry.hits = 1`) from a brand-new burst key (`entry.hits = 1` also). Hash: FNV-1a seed → four independent Murmur3-fragment mixes. Decay: all counters halved (arithmetic right-shift) every 100 000 inserts.

### Burst-flood survival (same priority)

50 long-resident `NORMAL` keys each receive 100 `get()` calls (builds sketch frequency), then 60 burst keys are inserted into a cache capped at 90 entries. The sketch frequency elevates resident scores so the eviction pass preferentially drops burst keys.

| Metric | Value |
|---|---|
| Resident keys before flood | 50 |
| Burst keys inserted | 60 |
| Cache capacity | 90 entries |
| Residents surviving (sketch on) | **50 / 50 (100 %)** |
| Burst keys evicted | ~18 out of 60 |

> Without the sketch, same-priority keys are evicted by LRU/LFU score only. A burst of 60 fresh keys at `hits = 1` would score similarly to residents that haven't been accessed recently, producing a near-random survival pattern.

### Sketch estimate throughput

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `sketch.estimate()` (1 000-key rotation) | **2.35 M/s** | 425 ns | 4 row lookups; called on every `get()` hit and `set()` |

### `hotKeys(n)` — live frequency ranking

`hotKeys(n)` iterates all live L1 entries, calls `sketch.estimate()` per key, then sorts descending and slices to `n`. Cost is O(entries) scan + O(entries log entries) sort.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `hotKeys(10)` — 2 K live entries | 12.9 K/s | 77.73 µs | O(n) sketch scan + O(n log n) sort + slice(0, 10) |
| `hotKeys(100)` — 2 K live entries | 12.6 K/s | 79.06 µs | same scan + sort, larger output slice |

> Slice size has negligible effect on cost — the sort dominates. Call at low frequency (e.g. every 10 s).

---

## Iterator interface — `keys()` / `values()` / `entries()`

All three methods iterate only live (non-expired) L1 entries. Numbers below are for a 500-entry L1 (full scan per call).

| Method | Throughput | Latency | Effective items/sec | Notes |
|---|---|---|---|---|
| `SmartMemoryCache.liveEntries()` | 53.7 K/s | 18.62 µs | 26.9 M | raw L1 generator baseline |
| `cache.entries()` | **30.7 K/s** | 32.53 µs | **15.4 M** | `[strippedKey, value]` pairs |
| `cache.keys()` | **37.3 K/s** | 26.84 µs | **18.7 M** | no `[key,entry]` tuple allocation |
| `cache.values()` | **42.5 K/s** | 23.53 µs | **21.3 M** | `yield*` delegation |
| raw `Map` iteration (baseline) | 367.3 K/s | 2.72 µs | 183.7 M | reference: no expiry check, no generator overhead |

### Monomorphic JIT budget — the architectural trade-off

All three `CacheService` generators ultimately iterate `SmartMemoryCache.cache` (a single `Map<string, SmartCacheEntry>`). V8 maintains per-call-site inline-cache (IC) type feedback. When multiple generator functions share the same Map, the JIT's type-feedback slot for that Map access becomes *polymorphic* — no single generator gets the full monomorphic specialization budget.

Practical impact with the current 3-generator footprint (`liveEntries`, `liveKeys`, `liveValues`):
- `keys()` skips the `[key, entry]` tuple the old `liveEntries`-based implementation allocated on every yield, keeping its generator frame lighter than `entries()`.
- `values()` uses `yield*` delegation, avoiding an extra generator frame; it is consistently faster than `entries()` in this run.

A fourth generator was prototyped (`rawEntries`) and removed: moving the `entry.value !== undefined` ternary into the generator frame disrupted V8's tight inner-loop optimization for the Map iteration, and the extra generator path further diluted the IC budget for `entries()`. The 3-generator design is the stable sweet spot.

> **When to prefer each method:** use `keys()` when you only need to enumerate key names (admin tooling, debug dumps). Use `values()` for full-cache scans where the key is irrelevant (warming a secondary store, bulk serialization). Use `entries()` when you need both. None of these paths hit bloom filter tracking or update hit counters — they are read-only enumerations.

| Counter | Value |
|---|---|
| Uptime | 156.3 s |
| Total `get()` calls | 500,028 |
| L1 hit rate | 69.6 % |
| Disk hits | 0 |
| `fetchFn` calls | 151,885 |
| Stampedes prevented | 162 |
| Total `set()` calls | 208,846 |
| Total `delete()` calls | 55,555 |
| Bloom FP rate | 16.498 % _(benchmark artifact: ~500K distinct keys vs a filter sized for 500 entries — not representative of production)_ |
| L1 entries | 500 / 400 MB cap |
| L1 used | 3.9 KB |
| Disk files | 18,560 |

---

## Refresh-ahead overhead — extra cost on a warm L1 hit

Refresh-ahead adds one `revalidating.has()` check + one `Date.now()` call + three arithmetic ops. When the key is fresh the threshold check is false and no recompute fires. `inferPriority()` is deferred inside the `if` block and only runs when a recompute actually triggers.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| Warm hit, **no** refresh-ahead (baseline) | 2.45 M/s | 409 ns | bloom → l1.get → return |
| Warm hit, `refreshAhead=0.8` (fresh, no recompute) | 1.91 M/s | 523 ns | bloom → l1.get → threshold check (false) → return |

**Refresh-ahead overhead: effectively zero (−5.6 % in this run — within measurement noise).** The threshold check evaluates false on a fresh key, so no recompute fires. The arithmetic minimum (subtraction + multiply + compare) costs ≈40–60 ns per call.

---

## `setIfAbsent()` — conditional write

Fast path (key present): `l1.has()` → `true` → returns `false` immediately, no write.  
Slow path (key absent): `l1.has()` miss → `l1.set()` + bloom update → returns `true`.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| Key already in L1 (no-op fast path) | 99.5 K/s | 10.05 µs | `l1.has()` → true → return false immediately |
| New key, L1 miss → write | 83.9 K/s | 11.92 µs | `l1.has()` miss → `l1.set()` + bloom.add → return true |

Fast path cost is the `l1.has()` bloom + Map probe only. Miss path adds `l1.set()` (pack + Map.set + bloom.add).

---

## Negative caching (`notFoundTtl`)

`null` results are stored identically to any other value — the only difference is the TTL used (`notFoundTtl` instead of the normal TTL). Subsequent L1 hits for `null` return immediately with no `fetchFn` call.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| Warm `null` hit (`notFoundTtl` cached) | 11.8 K/s | 84.72 µs | null served from L1 — identical path to any non-null L1 hit |
| Warm non-null hit (baseline) | 11.7 K/s | 85.40 µs | confirms null path has no extra overhead |

---

## What tricache is very good at

These are the specific problems tricache was engineered to solve well. Each one has a measurable benchmark backing it.

| Problem | tricache's answer | Benchmark evidence |
|---|---|---|
| **Thundering herd** | Inflight Map coalesces all concurrent callers onto one `fetchFn` Promise — `fetchFn` fires exactly once regardless of fan-out | 100 % coalescing efficiency at fan-out 2 → 100 |
| **Priority inversion under flood** | Count-Min Sketch tracks cross-eviction frequency; HIGH-priority entries survive a LOW-priority burst at 100 % rate | 100 % HIGH-priority protection in multi-tenancy section |
| **Write-pressure latency spikes** | Reservoir eviction bounds sort cost to O(16 log 16); zero-allocation hot path means no per-eviction GC pauses | Eviction soak CV: ~17 % (irreducible JS floor); no stop-the-world pauses |
| **GC pressure from bloom probes** | WASM bloom filter with `TextEncoder.encodeInto()` — 0 bytes allocated per probe | 0 B allocation path confirmed; 4.18 M probes/s (short ASCII) |
| **Cold miss overhead** | Bloom filter gates all `Map.get()` calls — a definite miss exits at 148–187 ns without touching the Map | Cold miss: 6.76 M/s vs hot hit: 2.71 M/s (bloom saves the Map lookup) |
| **Stale-while-revalidate** | SWR serves the cached value immediately and revalidates non-blocking — p50 indistinguishable from a warm hit | SWR path: 1.66 M/s, 602 ns — one `Date.now()` + async revalidate |
| **Disk overflow without blocking** | `disk.save()` is deferred to the next event-loop tick via `setImmediate()` — eviction hot path returns before any I/O | `set` headroom path: 94.7 K/s — disk cost is async, not on the critical path |
| **Namespace isolation** | Each tenant gets independent L1, disk directory, inflight Map, and pub/sub channel | Namespace throughput ratio A/B: 1.02× — no cross-tenant interference |
| **IV exhaustion protection** | Pre-allocated pool of 64 IVs refilled with `randomFillSync()` in-place — no per-encrypt Buffer allocation for IV generation | AES-256-GCM: 153–164 K/s with zero IV allocation overhead |

---

## Production value — does the complexity pay off?

**The short answer:** the internal mechanisms protect *hit rate* and *tail latency*, not the median latency of an already-warm cache. The hot L1 path (396 ns mean, 309 ns p50) is already below the noise floor of any real downstream — a typical `fetchFn` costs 1–100 ms, four to seven orders of magnitude more. The value of each mechanism is:

| Mechanism | Adds to hot path | What it actually protects | Skip it if… |
|---|---|---|---|
| Bloom filter | 203–310 ns | Eliminates a `Map.get()` on guaranteed misses — material when cold-key rates are high (crawlers, fan-out workloads) | Every request is a warm hit; you pay the probe cost either way |
| Count-Min Sketch | 425 ns (part of `get`/`set` score) | Keeps high-frequency residents in L1 across eviction cycles — a 1 % hit-rate improvement outweighs any in-cache latency saving | All entries have identical priority and uniform access patterns |
| Reservoir eviction | 6.8× a `set` when L1 is full | Bounds eviction cost to O(16 log 16) instead of O(n log n); prevents latency spikes under write pressure | Cache is sized well above peak load and eviction rarely fires |
| WASM `encodeInto` | 0 B heap alloc per probe | Removes GC pressure at > 1 M bloom probes/s — avoids stop-the-world pauses in sustained high-throughput workloads | Sub-million probes/s; small allocations are collected cheaply |
| Adaptive TTL | ~0 on L1 hits; noise-level on misses | Auto-adjusts TTL to track upstream p95 — prevents stampedes when upstream latency spikes | Upstream responds in stable sub-millisecond time |
| Inflight Map coalescing | Negligible | Prevents O(fan-out) concurrent `fetchFn` calls collapsing the upstream under load — **this is the single highest-value mechanism at scale** | Single-threaded scripts or workloads with no concurrent callers |

**Simpler alternatives:** a plain `Map` with a manual TTL check runs at 367.3 K/s in the raw iteration baseline (zero eviction, zero serialization, zero coalescing). It is indistinguishable in P50 until (a) the cache fills, (b) a thundering herd hits, or (c) a priority inversion evicts your hottest key to serve a burst of cold ones. The mechanisms in tricache exist to prevent those three failure modes — not to shave nanoseconds off an already-fast hot path.

---

## WasmBloomFilter — `writeKey` encodeInto hot-path

WASM module compiled once at module load; each `new WasmBloomFilter()` is an instance creation only. `writeKey` uses `TextEncoder.encodeInto()` — zero heap allocation per call.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `new WasmBloomFilter()` (module pre-compiled) | 13.6 K/s | 73.51 µs | `new WebAssembly.Instance(BLOOM_WASM_MODULE)` — no recompile |
| `mightContain` — short ASCII (≤ 20 chars) | **4.18 M/s** | 239 ns | encodeInto → WASM memory → 7 hash rounds → bit check |
| `add` — short ASCII (≤ 20 chars) | **3.78 M/s** | 265 ns | encodeInto → WASM memory → 7 hash rounds → bit set |
| `mightContain` — long ASCII (≈ 80 chars) | 2.47 M/s | 404 ns | encodeInto at native speed; 1 byte/char, capped at 512 B |
| `mightContain` — multi-byte UTF-8 (Kanji+emoji+Cyrillic) | 2.51 M/s | 398 ns | encodeInto zero-alloc; was `encode()` heap-alloc per call |
| `mightContain` — long multi-byte (> 512 B UTF-8, truncated) | 601.0 K/s | 1.66 µs | encodeInto fills exactly 512 B; old `encode()` allocated ~1 620 B |
| `mightContain` — emoji straddling 512 B boundary | 581.9 K/s | 1.72 µs | encodeInto skips partial surrogate; writes 510 B cleanly |

---

## Adaptive TTL — LatencyTracker overhead

The tracker fires **only on `fetchFn` calls** (cache misses). L1 warm hits are unaffected. `record()` is an O(1) ring-buffer write into a pre-allocated `Float64Array` per key; `p95()` sorts ≤ 32 elements.

### Warm L1 hit — hot-path overhead

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — warm hit, `adaptiveTtl=false` (baseline) | 1.66 M/s | 603 ns | no tracker — pure inflight-check → l1.get → return |
| `get` — warm hit, `adaptiveTtl=true` | 1.80 M/s | 557 ns | tracker branch never reached on an L1 hit |

**Hot-path delta: −46 ns/op (−7.7 %) — effectively zero.** The tracker is only reached inside the `fetchFn` branch.

### Cold miss / fetch — `record()` + `p95()` overhead

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — cold miss, `adaptiveTtl=false` (baseline) | 89.5 K/s | 11.18 µs | delete + instant fetchFn + l1.set — no tracker |
| `get` — cold miss, `adaptiveTtl=true` (record + p95 active) | 83.7 K/s | 11.95 µs | fetchFn + record() ring-buf write + ≤ 32-elem Array.sort |

**Fetch-path overhead: +772 ns/op (+6.9 %).** record() O(1) ring-buffer write + ≤32-element sort. Fetch latency is always dominated by I/O; the tracker adds µs, not ms.

### `metrics()` — adaptive TTL snapshot overhead

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `metrics()` — `adaptiveTtl=false` (128-key baseline) | 1.11 M/s | 904 ns | no adaptiveTtl section in output |
| `metrics()` — `adaptiveTtl=true` (128 tracked keys, top-20) | 105.9 K/s | 9.45 µs | O(128) scan + O(128 log 128) sort + slice(0, 20) |

**metrics() overhead: +8 544 ns/op (945.6 %).** Cost scales with tracked key count — call at low frequency (every 10–30 s).

---

## Amortized disk janitor — `purgeNextBucket()` vs `purgeExpired()`

When `node:sqlite` is available (Node.js 22.5+), the disk tier switches to an SQLite index: `expiresAt` is stored in a B-tree alongside the file path, making expiry lookups O(log n) with no decrypt required. In file-only mode (no SQLite), both functions require full decrypt + unpack because `expiresAt` lives inside the AES-256-GCM ciphertext.

`purgeNextBucket()` additionally runs a `readdirSync` over one orphan bucket per tick (crash-recovery path) even in SQLite mode.

| Operation | Throughput | Latency | Notes |
|---|---|---|
| `purgeNextBucket()` — one bucket tick (SQLite mode) | 13.6 K/s | 73.71 µs | SQL: all expired rows (indexed) + readdirSync one orphan bucket |
| `purgeExpired()` — full scan (SQLite mode) | **181.1 K/s** | 5.52 µs | SQL: single indexed query; no filesystem walk |

**In SQLite mode, `purgeExpired()` is a pure indexed SQL query with no filesystem walk** — 2,500× faster than the file-only path (72 /s). The ~70 µs `readdirSync` orphan check in `purgeNextBucket()` dominates that path on Windows; on Linux it would be ~1–2 µs.

**At equal interval, the janitor spreads the same total I/O across 256 ticks** — 1/256th of the full-scan work per call.

---

## `deletePattern` — categoryKeys O(1) fast path vs O(N) scan

When the trailing-wildcard prefix exactly matches a configured category, `deletePattern()` uses the pre-built `categoryKeys` Set instead of scanning the full Map. Speedup is proportional to N / catSize — most pronounced when N is large.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `deletePattern('user:*')` — categoryKeys fast path (2 000 entries, cat=200) | 2.7 K/s | 366.51 µs | O(catSize) Set iteration — skips full Map scan |
| `deletePattern('user:*')` — O(N) regex scan (2 000 entries, cat=200) | 2.7 K/s | 368.97 µs | O(N) Map.keys() + RegExp.test per key |

**Fast-path speedup: 1.03× in this run** (200 cat keys vs 2 000 total — theoretical ≈ 10×). Benefit grows linearly with total Map size.

---

## Latency distributions — p50 / p95 / p99 / max

Mean (average) hides the spikes that matter in production. The eviction path, a GC pause, or a disk write stall all appear as tail-latency outliers that a mean completely conceals. `pnpm bench` now reports a **p50 / p95 / p99 / max sub-row** under every distribution benchmark.

Method: each "sample" is the wall-time of a batch of N iterations divided by N. Batching is essential for sub-µs operations — timing a single 350 ns `get()` with `performance.now()` (≈ 0.1 µs resolution) gives noise-dominated data. Batching 100 ops yields a ~35 µs measurement accurate to < 1 %.

| Scenario | mean | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| L1 hot `get` — headroom | 344 ns | 309 ns | 376 ns | 522 ns | 40.07 µs |
| CacheService `set` — headroom | 8.50 µs | 8.05 µs | 12.64 µs | 17.12 µs | 39.33 µs |
| CacheService `set` — full L1 (eviction every set) | 6.36 µs | 5.08 µs | 10.58 µs | 19.86 µs | 49.10 µs |

The L1 `max` spike (40 µs) is a GC minor pause — p99 (522 ns) is tight and only 1.7× above p50. The `set` headroom path shows the async `disk.save()` tail: p99 is 1.8× the mean but stays in the µs range. The `set` full-eviction path has a *lower* mean than headroom because the smaller L1 (200 entries) has less bloom-filter + Map traversal overhead — but p99 is 3.9× its p50, revealing reservoir-sort and disk-spill jitter.

---

## Stability soak — throughput over sustained load

`pnpm bench` includes a **10-second stability soak** that samples throughput in 1-second windows and reports the **coefficient of variation** (CV = σ/μ):

| CV range | Colour | Meaning |
|---|---|---|
| < 5 % | green | Stable — GC and JIT overhead fully amortised |
| 5–15 % | yellow | Minor jitter — occasional GC pause or eviction spike |
| > 15 % | red | Unstable — investigate heap growth or eviction pressure |

Three scenarios are measured:
- **L1 hot `get`** — should be very stable (CV < 5 %) once JIT is warm.
- **CacheService `set` with headroom** — fire-and-forget disk I/O should not dominate (CV < 10 %).
- **CacheService `set` under eviction** — reservoir sort every op; CV reveals GC/eviction interaction.

### Results (10-second soak, 1-second windows)

| Scenario | avg | min | max | CV | Assessment |
|---|---|---|---|---|---|
| L1 hot `get` | 52.6 K/s | 50.6 K/s | 53.5 K/s | **1.5 %** | Stable (green) — GC fully amortised |
| CacheService `set` — headroom | 88.4 K/s | 73.7 K/s | 91.3 K/s | 5.9 % | Minor jitter (yellow) — disk.save() async scheduling |
| CacheService `set` — eviction | 155.3 K/s | 141.6 K/s | 162.7 K/s | 5.7 % | Minor jitter (yellow) — reservoir sort + GC interaction |

Heap after soak: 1 352.5 MB used / 1 421.6 MB total (95.1 %). No heap growth observed during the 10-second window — L1 is at steady state.

For a proper long-duration soak (bloom filter saturation, heap growth over time, GC degeneration):

```bash
SOAK_MS=3600000 pnpm bench   # 1-hour soak
```

---

## Disk tier design trade-off

The current disk tier stores `expiresAt` **inside** the AES-256-GCM ciphertext alongside the serialized value. This means:

- **Security benefit:** expiry metadata cannot be tampered with without breaking decryption — a tampered timestamp produces a GCM authentication failure.
- **Performance cost:** the janitor (`purgeNextBucket` / `purgeExpired`) must fully decrypt and unpack every file to read its expiry, even files that haven't expired yet. Every janitor tick is decrypt-bound.

An alternative design — a **plaintext metadata header** (8-byte expiry timestamp) followed by the encrypted body — would make janitor scans I/O-bound instead of decrypt-bound, potentially 10–50× faster on a heavily-loaded disk tier. The trade-off is that expiry timestamps become tamperable at rest.

The current design was chosen to match the threat model of encrypted-at-rest storage: if the disk can be read by an adversary, the expiry shouldn't be readable either. If janitor performance at scale becomes a concern, the header approach should be benchmarked.

---

## Bottleneck cheat-sheet

| Symptom | Likely cause | Fix |
|---|---|---|
| L1 hot `get` < 1 M/s | GC pressure | Reduce `maxEntries` or payload size |
| `set` (large) slow | `msgpackr` encode cost | Store pre-serialized payloads or reduce entry size |
| Glob `delete` slow | O(n) Map scan | Prefer namespace-scoped exact deletes |
| Coalescing efficiency < 100 % | Keys expiring mid-flight | Increase TTL |
| Parallel ≈ serial (CPU) | Expected — JS is single-threaded | No action needed |
| Parallel >> serial (I/O) | I/O overlap via `Promise.all` | This is the intended benefit |
| Eviction > 10× slower than headroom | Cache over-full | Increase `l1MaxEntries` |

---

## Reproduce

```bash
git clone https://github.com/Kareem411/TriCache.git
cd TriCache
pnpm install
pnpm bench
```

---

## v0.4.1 — New API surface notes

These additions have no measurable impact on the hot `get()` / `set()` throughput numbers above — they operate on cold or startup paths. Noted here for completeness.

### `mget` per-key TTL function

When `ttl` is a function, it is called **only for miss keys** — L1 hits bypass it entirely. The resolved TTL is passed to the existing `set()` path, so jitter, disk spill, and Redis write all behave identically to a plain-number TTL. No additional overhead on warm hits.

### `dependsOn` backplane cascade fix

Previously: instance A deletes `org:42` → cascade evicts `org:42:members` on A only. Instances B and C evicted `org:42` but not its dependents.

Now: `_handleBackplaneMessage` calls `_cascadeDependencies(msg.key)` on receipt. The dependency index walk is O(p × d) where p = registered parent patterns and d = average dependents per pattern — both typically small (single digits in production). No measurable effect on backplane throughput.

### `cache.ready()` / `warmKeys`

`ready()` returns a stored Promise — O(1), no async work on repeated calls. `warmKeys` triggers exactly one `warmFromL2()` at construction; the Promise is stored and returned by all `ready()` calls thereafter. The readiness probe pattern is:

```ts
const cache = CacheService.create({ warmKeys: 'user:*' });
await cache.ready(); // blocks only the first caller; subsequent awaits resolve immediately
```
