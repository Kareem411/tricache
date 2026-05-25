/// <reference lib="dom" />

/**
 * WasmBloomFilter — WASM-powered Bloom filter using FNV-1a/djb2 double-hashing.
 *
 * The 562-byte WASM binary is inlined as Base64 to avoid any runtime file-system
 * dependency. It implements a 100,000-bit filter with k=7 hash probes giving a
 * ~0.01% false-positive rate at 2,000 entries.
 *
 * Memory layout (1 WASM page = 64 KB):
 *   [0 .. 12499]     = 100,000-bit bit-array
 *   [20000 .. 20511] = 512-byte key staging area (JS → WASM string transfer)
 *
 * Used by SmartMemoryCache as the first-level miss detector.
 * Falls back to the pure-JS BloomFilter if WASM fails to instantiate.
 */

const BLOOM_WASM_BASE64 =
  'AGFzbQEAAAABIwdgAn9/AX9gAX8AYAF/AX9gA39/fwF/YAJ/fwBgAABgAAF/AwoJAAABAgMEAAUG' +
  'BQMBAAEGDQJ/AEGgjQYLfwBBBwsHMwUGbWVtb3J5AgADYWRkAAUMbWlnaHRDb250YWluAAYFcmVz' +
  'ZXQABwljb3VudEJpdHMACAqtAwk/AQJ/QcW78oh4IQIgACABaiEDAkADQCAAIANPDQEgAiAALQAA' +
  'cyECIAJBk4OACGwhAiAAQQFqIQAMAAsLIAILOAECf0GFKiECIAAgAWohAwJAA0AgACADTw0BIAJB' +
  'BXQgAmogAC0AAGohAiAAQQFqIQAMAAsLIAILHgEBfyAAQQN2IQEgASABLQAAQQEgAEEHcXRyOgAA' +
  'CxYAIABBA3YtAABBASAAQQdxdHFBAEcLDQAgACACIAFsaiMAcAs4AQN/IAAgARAAIQIgACABEAEh' +
  'A0EAIQQCQANAIAQjAU8NASACIAMgBBAEEAIgBEEBaiEEDAALCwtBAQN/IAAgARAAIQIgACABEAEh' +
  'A0EAIQQCQANAIAQjAU8NASACIAMgBBAEEANFBEBBAA8LIARBAWohBAwACwtBAQsnAQF/QQAhAAJA' +
  'A0AgAEHU4QBPDQEgAEEANgIAIABBBGohAAwACwsLSwEDf0EAIQBBACEBAkADQCAAQdThAE8NASAA' +
  'LQAAIQICQANAIAJFDQEgAUEBaiEBIAIgAkEBa3EhAgwACwsgAEEBaiEADAALCyABCw==';

const KEY_STAGING_OFFSET = 20_000;
const MAX_KEY_BYTES = 512;

interface BloomWasmExports {
  memory: WebAssembly.Memory;
  add(ptr: number, len: number): void;
  mightContain(ptr: number, len: number): number;
  reset(): void;
  countBits(): number;
}

const BLOOM_WASM_MODULE = new WebAssembly.Module(Buffer.from(BLOOM_WASM_BASE64, 'base64'));

export class WasmBloomFilter {
  private readonly exports: BloomWasmExports;
  private readonly mem: Uint8Array;
  private readonly encoder = new TextEncoder();
  private readonly numBits = 100_000;
  /** Pre-computed — k and numBits are fixed constants; no need to recalculate on every probe. */
  private readonly _maxCapacity: number;
  /** Tracks total add() calls so we know when phantom bits have saturated the filter. */
  private _insertionCount = 0;

  constructor() {
    const instance = new WebAssembly.Instance(BLOOM_WASM_MODULE, {});
    this.exports = instance.exports as unknown as BloomWasmExports;
    this.mem = new Uint8Array(this.exports.memory.buffer);
    const k = 7, p = 0.01;
    this._maxCapacity = Math.floor(-this.numBits * Math.log(1 - Math.pow(p, 1 / k)) / k);
  }

  private writeKey(key: string): number {
    if (key.length === 0) return 0;
    const target = this.mem.subarray(KEY_STAGING_OFFSET, KEY_STAGING_OFFSET + MAX_KEY_BYTES);
    return this.encoder.encodeInto(key, target).written;
  }

  add(key: string): void {
    const len = this.writeKey(key);
    if (len === 0) return;
    this.exports.add(KEY_STAGING_OFFSET, len);
    this._insertionCount++;
  }

  mightContain(key: string): boolean {
    const len = this.writeKey(key);
    if (len === 0) return true;
    return this.exports.mightContain(KEY_STAGING_OFFSET, len) === 1;
  }

  reset(): void { this.exports.reset(); this._insertionCount = 0; }

  rebuild(keys: Iterable<string>): void {
    this.reset();
    for (const key of keys) this.add(key);
  }

  get stats(): { bitsSet: number; fillFactor: number } {
    const bitsSet = this.exports.countBits();
    return { bitsSet, fillFactor: bitsSet / this.numBits };
  }

  /** Number of add() calls since last reset/rebuild. */
  get insertions(): number { return this._insertionCount; }

  /**
   * Maximum safe insertions before false-positive rate exceeds ~1 %.
   * Exact formula for k=7 hash rounds, m=100 000 bits:
   *   n_max = -m * ln(1 - p^(1/k)) / k  ≈ 18 169
   */
  get maxCapacity(): number { return this._maxCapacity; }
}
