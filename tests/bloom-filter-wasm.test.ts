import { describe, it, expect, beforeEach } from 'vitest';
import { WasmBloomFilter } from '../src/wasm/bloom-filter-wasm';

describe('WasmBloomFilter — correctness', () => {
  let filter: WasmBloomFilter;

  beforeEach(() => {
    filter = new WasmBloomFilter();
  });

  // ── Basic invariants ────────────────────────────────────────────────────

  it('mightContain returns true for an empty key (guard path)', () => {
    expect(filter.mightContain('')).toBe(true);
  });

  it('returns false for a key that was never added', () => {
    // A single novel key should not be a false positive with high probability
    // (false-positive rate is ~0.01% at capacity; a fresh filter has 0 bits set)
    expect(filter.mightContain('never-added-key')).toBe(false);
  });

  it('always returns true for a key after it has been added', () => {
    filter.add('hello');
    expect(filter.mightContain('hello')).toBe(true);
  });

  it('tracks multiple keys independently', () => {
    const keys = ['alpha', 'beta', 'gamma', 'δέλτα', '日本語キー', '🔑secret'];
    for (const k of keys) filter.add(k);
    for (const k of keys) expect(filter.mightContain(k)).toBe(true);
    // A key not in the set should return false (no hash collision for these few keys)
    expect(filter.mightContain('not-in-set')).toBe(false);
  });

  it('reset clears all bits so previously-added keys are no longer found', () => {
    filter.add('will-be-cleared');
    filter.reset();
    expect(filter.mightContain('will-be-cleared')).toBe(false);
    expect(filter.insertions).toBe(0);
  });

  it('rebuild re-populates the filter from scratch', () => {
    filter.add('old-key');
    filter.rebuild(['new-key-a', 'new-key-b']);
    expect(filter.mightContain('old-key')).toBe(false);
    expect(filter.mightContain('new-key-a')).toBe(true);
    expect(filter.mightContain('new-key-b')).toBe(true);
  });

  it('insertions counter increments with add and resets with reset', () => {
    expect(filter.insertions).toBe(0);
    filter.add('a');
    filter.add('b');
    expect(filter.insertions).toBe(2);
    filter.reset();
    expect(filter.insertions).toBe(0);
  });

  // ── Multi-byte / Unicode key handling ────────────────────────────────────

  it('correctly handles pure multi-byte UTF-8 keys (Kanji)', () => {
    const key = '日本語のキャッシュキー';
    filter.add(key);
    expect(filter.mightContain(key)).toBe(true);
  });

  it('correctly handles mixed ASCII + emoji keys', () => {
    const key = 'user:🎴:session';
    filter.add(key);
    expect(filter.mightContain(key)).toBe(true);
  });

  it('correctly handles Cyrillic keys', () => {
    const key = 'ключ_кэша_пользователь';
    filter.add(key);
    expect(filter.mightContain(key)).toBe(true);
  });

  // ── Boundary: 512-byte staging area limit ───────────────────────────────

  it('does not throw when a key encodes to exactly 512 bytes', () => {
    // 512 ASCII characters encode to exactly 512 bytes
    const key = 'A'.repeat(512);
    expect(() => filter.add(key)).not.toThrow();
    expect(filter.mightContain(key)).toBe(true);
  });

  it('does not throw when a key encodes to more than 512 bytes', () => {
    // 600 ASCII characters — encodeInto will truncate at 512 bytes
    const key = 'B'.repeat(600);
    expect(() => filter.add(key)).not.toThrow();
    // The filter may or may not contain this key depending on the truncated hash,
    // but it must not throw or corrupt memory
  });

  it('safely truncates at 512 bytes without splitting a surrogate pair (4-byte emoji on boundary)', () => {
    // 510 ASCII bytes + 1 emoji (4 UTF-8 bytes) = 514 bytes total
    // encodeInto must not write a partial surrogate: it should write 510 bytes
    // (stopping before the emoji that would overflow), not 512 bytes of garbage.
    const boundaryKey = 'A'.repeat(510) + '🌟';
    expect(() => filter.add(boundaryKey)).not.toThrow();
    // A 3-byte CJK at position 510 similarly crosses the boundary
    const cjkBoundaryKey = 'A'.repeat(510) + '漢';
    expect(() => filter.add(cjkBoundaryKey)).not.toThrow();
  });

  it('treats keys truncated at 512 bytes as equal regardless of tail content', () => {
    // Two keys that are identical for their first 513+ bytes will hash the same
    // because both get truncated to the same 512-byte prefix.
    const prefix = 'X'.repeat(512);
    const key1 = prefix + 'suffix-one';
    const key2 = prefix + 'suffix-two';
    filter.add(key1);
    // key2 maps to the same truncated bytes → mightContain must also return true
    expect(filter.mightContain(key2)).toBe(true);
  });

  // ── Module-level compilation: multiple instances share the same module ──

  it('multiple instances are independent (separate WASM memory)', () => {
    const f1 = new WasmBloomFilter();
    const f2 = new WasmBloomFilter();
    f1.add('only-in-f1');
    expect(f1.mightContain('only-in-f1')).toBe(true);
    expect(f2.mightContain('only-in-f1')).toBe(false);
  });

  it('creating many instances does not throw (module compiled once, instantiated cheaply)', () => {
    expect(() => {
      for (let i = 0; i < 50; i++) new WasmBloomFilter();
    }).not.toThrow();
  });

  // ── Stats ────────────────────────────────────────────────────────────────

  it('fillFactor increases as keys are added', () => {
    const before = filter.stats.fillFactor;
    for (let i = 0; i < 100; i++) filter.add(`key:${i}`);
    expect(filter.stats.fillFactor).toBeGreaterThan(before);
  });

  it('maxCapacity is a positive number', () => {
    expect(filter.maxCapacity).toBeGreaterThan(0);
  });
});
