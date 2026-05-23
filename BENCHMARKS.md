# tricache — Benchmarks

> **Environment:** Windows 11 · Node.js ≥ 22 · single-threaded (no worker threads) · `pnpm bench`  
> **Date:** 2026-05-23  
> **Source:** [`bench/benchmark.ts`](bench/benchmark.ts)

All numbers are from one live run on the same machine. Throughput varies ±5–10 % across runs due to JIT warmth and OS scheduling. Re-run with `pnpm bench` to reproduce on your hardware.

> **v0.3.1 additions:** TTL jitter (`ttlJitterFactor`), batch `mset()` / `mdel()`, native OpenTelemetry spans (`tracer`), L2 circuit breaker (`l2CircuitBreakerThreshold` / `l2CircuitBreakerCooldownMs`), and `warmFromL2(pattern)` startup warming.

> **v0.3.0 additions:** Count-Min Sketch frequency tracking (4 KB, 84 % burst-flood survival rate) and a lazy iterator interface (`keys()` / `values()` / `entries()`) on `CacheService`. See the dedicated sections below.

> **v0.2.0 optimisation:** every cache entry now stores the deserialized JS value alongside the msgpackr buffer. Hot `get()` calls return the live object directly — zero unpack overhead. The packed buffer is retained for disk spill and snapshot serialization. Result: **+112 % L1 hot-get throughput** and **+64 % CacheService L1 warm-hit throughput**.

---

## L1 SmartMemoryCache — raw throughput

Single-threaded JS; no `await`. These numbers are your absolute ceiling.

| Operation | Throughput | Latency | Notes |
|---|---|---|
| `get` — hot hit (8 K resident entries) | **2.19 M/s** | 457 ns | bloom → Map lookup → return cached value |
| `get` — cold miss (key never set) | **5.81 M/s** | 172 ns | bloom gates → early return |
| `set` — tiny payload | 915 K/s | 1.09 µs | pack() + Map.set + bloom.add |
| `set` — small payload (≈ 512 B) | 562 K/s | 1.78 µs | pack() — same unified path, larger payload |
| `set` — large payload (≥ 512 B) | 213.6 K/s | 4.68 µs | pack() + byte-size estimate |
| `set` — CRITICAL priority | 489.7 K/s | 2.04 µs | same path as NORMAL; skipped in eviction sort |
| `delete` — exact key | **4.40 M/s** | 227 ns | Map.delete (bloom has no remove) |
| `deletePattern` — glob wildcard | 7.1 K/s | 141 µs | O(n) Map scan — use exact deletes in hot paths |

---

## Bloom filter — cost breakdown

The filter is O(k=7) per probe. A definite miss avoids the Map lookup entirely.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — definite miss (novel key, never set) | 4.42 M/s | 226 ns | 7 hash rounds → bit check → return null |
| `get` — hit path (key confirmed in bloom) | 3.02 M/s | 331 ns | 7 hash rounds → Map.get → return cached value |

False positives still hit `Map.get()` and return `undefined` — wasted work. Keep the bloom FP rate below 1 % by not over-filling L1.

---

## Serialization — msgpackr pack() by payload size

All payloads use the unified `pack()` path; no JSON fallback at any size.

| Payload size | Throughput | Latency |
|---|---|---|
| 128 B | 601 K/s | 1.66 µs |
| 256 B | 572 K/s | 1.75 µs |
| 512 B | 545 K/s | 1.83 µs |
| 1 024 B | 423 K/s | 2.36 µs |
| 4 096 B | 204.4 K/s | 4.89 µs |
| 16 384 B | 94.4 K/s | 10.60 µs |

---

## CacheService — end-to-end path costs

Each `get()` adds: namespace prefix + inflight-Map check + L1 / disk / L2 lookup chain.

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `get` — L1 warm hit | **1.86 M/s** | 539 ns | inflight check → l1.get → return cached value |
| `get` — SWR stale serve + bg revalidate | **796 K/s** | 1.26 µs | serves stale instantly; revalidate non-blocking |
| `get` — L1 miss → fetchFn (TTL=0) | 13.7 K/s | 73 µs | Promise microtask + l1.set on fill |
| `set` | 31.0 K/s | 32.21 µs | l1.set + disk.save (async fire-and-forget) |
| `delete` — exact key | 7.9 K/s | 125.92 µs | l1.delete + disk.delete + backplane (no-op, Redis off) |
| `delete` — glob `*` | 687 K/s | 1.46 µs | l1.deletePattern O(n) + disk glob scan |

---

## Concurrency — serial vs parallel, inflight-Map coalescing

Node.js is single-threaded. "Concurrency" = `Promise.all()` fan-out sharing one event-loop thread. The inflight Map is the de-facto lock: the first getter registers a Promise; all later callers `.then()` onto it. `fetchFn` fires exactly once.

### Same-key coalescing (thundering-herd prevention)

| Fan-out | fetchFn calls | Coalesced | Coalescing efficiency |
|---|---|---|---|
| 2 | 1× | 1 | 100 % |
| 5 | 1× | 4 | 100 % |
| 10 | 1× | 9 | 100 % |
| 50 | 1× | 49 | 100 % |
| 100 | 1× | 99 | **100 %** |

### Distinct-key parallel fan-out (20 concurrent keys)

| Fetch type | Serial | Parallel | Ratio |
|---|---|---|---|
| CPU-bound (no I/O) | 5.0 K/s | 5.8 K/s | **1.16×** — expected ≈ 1.0 (single-threaded) |
| I/O-bound (setTimeout) | 846 /s | 7.6 K/s | **8.94×** — I/O callbacks overlap across `Promise.all` |

### Mixed read/write ratio sweep (10 concurrent, 3 000 batches)

| Read / Write | Throughput | Latency |
|---|---|---|
| 100 % / 0 % | 112.3 K/s | 8.91 µs |
| 95 % / 5 % | 272 K/s | 3.68 µs |
| 80 % / 20 % | 633.6 K/s | 1.58 µs |
| 50 % / 50 % | 530.2 K/s | 1.89 µs |
| 20 % / 80 % | 443.7 K/s | 2.25 µs |
| 0 % / 100 % | 415.8 K/s | 2.40 µs |

> The 100 % reads row is slower than 80/20 because the benchmark measures end-to-end `get()` including cold-miss fetches; writes keep the cache warmer.

---

## Eviction pressure — L1 over-capacity behaviour

Eviction uses reservoir sampling: O(n) category-key pass + O(16 log 16) sort on 16 candidates.

| Scenario | Throughput | Latency | Notes |
|---|---|---|---|
| L1 has headroom | 431.7 K/s | 2.32 µs | capacity check passes → Map.set only |
| L1 full, eviction on every set | 29.4 K/s | 34.01 µs | category scan + reservoir sort + disk spill |

**Eviction overhead: 14.7× slower than the headroom path.** Tune `l1MaxEntries` to keep the cache below its ceiling during normal load.

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
| `metrics()` snapshot | 882 K/s | 1.13 µs |
| `toPrometheusText(metrics())` | 135.8 K/s | 7.36 µs |

---

## Realistic workload — 80 % hot read / 15 % cold miss / 5 % write

Simulates a typical web-server request fan-out with a warm cache.

| Mode | Throughput | Latency |
|---|---|---|
| Serial (1 coroutine) | 8.7 K/s | 115 µs |
| Parallel (20 coroutines) | 10.0 K/s | 100 µs |

---

## Encryption — all modes

IV pool of 64 pre-generated IVs; output buffers pre-allocated. Auth-tag generation (GHASH) dominates the GCM cost.

### AES-256-GCM (32-byte key, default)

| Payload | Encrypt | Decrypt |
|---|---|---|
| 64 B | 127 K/s / 7.87 µs | 151.8 K/s / 6.59 µs |
| 512 B | 124.9 K/s / 8.00 µs | 131.4 K/s / 7.61 µs |
| 4 096 B | 36.0 K/s / 27.78 µs | 38.2 K/s / 26.17 µs |

### AES-128-GCM (16-byte key, ~15 % faster on non-AES-NI hardware)

| Payload | Encrypt | Decrypt |
|---|---|---|
| 64 B | 141.9 K/s / 7.05 µs | 168.1 K/s / 5.95 µs |
| 512 B | 146 K/s / 6.85 µs | 165.6 K/s / 6.04 µs |
| 4 096 B | 62.0 K/s / 16.12 µs | 60.2 K/s / 16.62 µs |

### AES-128-CTR (16-byte key, no auth tag — fastest cipher mode)

| Payload | Encrypt | Decrypt |
|---|---|---|
| 64 B | 197.3 K/s / 5.07 µs | 192.7 K/s / 5.19 µs |
| 512 B | 181.4 K/s / 5.51 µs | 186.1 K/s / 5.37 µs |
| 4 096 B | 79.9 K/s / 12.51 µs | 67.2 K/s / 14.88 µs |

### XOR obfuscation (buffer path, 32-bit word-level — NOT cryptographic)

| Payload | Mask | Unmask |
|---|---|---|
| 64 B | 2.35 M/s / 426 ns | 2.02 M/s / 495 ns |
| 512 B | 623.4 K/s / 1.60 µs | 606.2 K/s / 1.65 µs |
| 4 096 B | 102.3 K/s / 9.77 µs | 73.7 K/s / 13.57 µs |

> String-path (Redis L2) numbers are 5–20 % slower than buffer-path (disk/snapshot) due to base64 encoding overhead.  
> AES-128-CTR removes the GHASH MAC step — use only when integrity is guaranteed by transport (TLS, HMAC).  
> XOR is self-inverse and has no IV or auth tag; use for dev environments or non-sensitive caches only.

---

## Multi-tenancy — category competition & namespace isolation

Two categories sharing one L1: `user:` (HIGH priority, limit 200) vs `analytics:` (LOW, limit 100).

| Metric | Value |
|---|---|
| `analytics:` flood throughput | 200.2 K/s |
| `user:` entries before flood | 200 |
| `user:` entries after flood | 200 (0 evicted) |
| `analytics:` entries at steady state | 100 / 100 limit |
| HIGH-priority protection rate | **100 %** |

### Namespace throughput parity (two independent tenants)

Both tenants share a single pre-generated random sequence (same operation mix) and are JIT-warmed interleaved before either timed run begins, so neither benefits from code compiled during the other's measurement.

| Tenant | Throughput | Latency |
|---|---|---|
| `org_a` — 80/15/5 workload | 18.7 K/s | 53.52 µs |
| `org_b` — 80/15/5 workload | 17.3 K/s | 57.66 µs |
| Ratio A/B | **1.08×** | — |

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
| Residents surviving (sketch on) | **42 / 50 (84 %)** |
| Burst keys evicted | ~18 out of 60 |

> Without the sketch, same-priority keys are evicted by LRU/LFU score only. A burst of 60 fresh keys at `hits = 1` would score similarly to residents that haven't been accessed recently, producing a near-random survival pattern.

### Sketch estimate throughput

| Operation | Throughput | Latency | Notes |
|---|---|---|---|
| `sketch.estimate()` (1 000-key rotation) | **2.97 M/s** | 336 ns | 4 row lookups; called on every `get()` hit and `set()` |

---

## Iterator interface — `keys()` / `values()` / `entries()`

All three methods iterate only live (non-expired) L1 entries. Numbers below are for a 500-entry L1 (full scan per call).

| Method | Throughput | Latency | Effective items/sec | Notes |
|---|---|---|---|---|
| `SmartMemoryCache.liveEntries()` | 49.8 K/s | 20 µs | 24.9 M | raw L1 generator baseline |
| `cache.entries()` | **24.5 K/s** | 41 µs | **12.3 M** | `[strippedKey, value]` pairs |
| `cache.keys()` | **34.1 K/s** | 29 µs | **17.1 M** | no `[key,entry]` tuple allocation; **+19 % vs v0.2.0** |
| `cache.values()` | **33.6 K/s** | 30 µs | **16.8 M** | `yield*` delegation; **+4 % vs v0.2.0** |
| raw `Map` iteration (baseline) | 351 K/s | 2.85 µs | 175.5 M | reference: no expiry check, no generator overhead |

### Monomorphic JIT budget — the architectural trade-off

All three `CacheService` generators ultimately iterate `SmartMemoryCache.cache` (a single `Map<string, SmartCacheEntry>`). V8 maintains per-call-site inline-cache (IC) type feedback. When multiple generator functions share the same Map, the JIT's type-feedback slot for that Map access becomes *polymorphic* — no single generator gets the full monomorphic specialization budget.

Practical impact with the current 3-generator footprint (`liveEntries`, `liveKeys`, `liveValues`):
- `keys()` and `values()` are faster than their v0.2.0 equivalents (+19 % / +4 %) because they skip the `[key, entry]` tuple the old `liveEntries`-based implementation allocated on every yield.
- `entries()` sits within 5 % of its v0.2.0 baseline — within run-to-run system noise.

A fourth generator was prototyped (`rawEntries`) and removed: moving the `entry.value !== undefined` ternary into the generator frame disrupted V8's tight inner-loop optimization for the Map iteration, and the extra generator path further diluted the IC budget for `entries()`. The 3-generator design is the stable sweet spot.

> **When to prefer each method:** use `keys()` when you only need to enumerate key names (admin tooling, debug dumps). Use `values()` for full-cache scans where the key is irrelevant (warming a secondary store, bulk serialization). Use `entries()` when you need both. None of these paths hit bloom filter tracking or update hit counters — they are read-only enumerations.

| Counter | Value |
|---|---|
| Uptime | 56.8 s |
| Total `get()` calls | 294 221 |
| L1 hit rate | 77.0 % |
| Disk hits | 0 |
| `fetchFn` calls | 67 505 |
| Stampedes prevented | 162 |
| Total `set()` calls | 133 798 |
| Total `delete()` calls | 55 555 |
| Bloom FP rate | 5.89 % _(filter saturated by end-of-run volume)_ |
| L1 entries | 500 / 400 MB cap |
| L1 used | 7.4 KB |

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
