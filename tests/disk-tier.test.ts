import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiskTier } from '../src/disk-tier';
import { CachePriority } from '../src/types';
import type { SmartCacheEntry } from '../src/types';
import { tmpdir } from 'os';
import { join } from 'path';
import { rmSync } from 'fs';
import { consoleLogger } from '../src/types';
import { pack, unpack } from 'msgpackr';

function tempDir() {
  return join(tmpdir(), `tricache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeEntry(value: string, ttlMs = 60_000): SmartCacheEntry {
  const data = pack(value);
  const size = data.byteLength;
  return {
    data,
    isCompressed:  true,
    expiresAt:     Date.now() + ttlMs,
    size,
    hits:          1,
    lastAccess:    Date.now(),
    priority:      CachePriority.NORMAL,
  };
}

describe('DiskTier', () => {
  let dir: string;
  let disk: DiskTier;

  beforeEach(() => {
    dir  = tempDir();
    disk = new DiskTier({ dir, maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024, forbiddenPrefixes: [], logger: consoleLogger });
  });

  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

  it('returns null for a key not on disk', () => {
    expect(disk.load('ghost')).toBeNull();
  });

  it('persists and reloads a value', async () => {
    const entry = makeEntry('hello world');
    await disk.save('key1', entry);
    const loaded = disk.load('key1');
    expect(loaded).not.toBeNull();
    expect(unpack(loaded!.data as Buffer)).toBe('hello world');
  });

  it('returns null for an expired entry', async () => {
    const entry = makeEntry('expired', 1); // 1 ms TTL
    await disk.save('exp-key', entry);
    await new Promise(r => setTimeout(r, 20));
    expect(disk.load('exp-key')).toBeNull();
  });

  it('deletes a key from disk', async () => {
    await disk.save('to-del', makeEntry('bye'));
    disk.delete('to-del');
    expect(disk.load('to-del')).toBeNull();
  });

  it('purgeExpired removes only expired entries (verifies by file count)', async () => {
    await disk.save('live', makeEntry('ok', 60_000));
    await disk.save('will-expire', makeEntry('bye', 500)); // 500ms TTL
    // Use disk.stats.files — counts across 2-level sharded subdirs correctly
    const beforeFiles = disk.stats.files;
    expect(beforeFiles).toBe(2);
    // Wait for the short-lived entry to expire — do NOT call load() first since load() consumes the file
    await new Promise(r => setTimeout(r, 600));
    // purgeExpired should detect expiry from the on-disk payload and remove it
    const n = disk.purgeExpired();
    expect(n).toBeGreaterThanOrEqual(1);
    const afterFiles = disk.stats.files;
    expect(afterFiles).toBeLessThan(beforeFiles);
    // 'live' key can still be loaded (file still on disk)
    expect(disk.load('live')).not.toBeNull();
  });

  it('survives a second DiskTier instance pointing at the same directory', async () => {
    await disk.save('shared-key', makeEntry('shared-value'));
    // load() consumes the file (promotes to L1), so use a second instance to read it before consuming
    const disk2 = new DiskTier({ dir, maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024, forbiddenPrefixes: [], logger: consoleLogger });
    expect(unpack(disk2.load('shared-key')!.data as Buffer)).toBe('shared-value');
  });

  it('encrypts and decrypts when encryptionKey is supplied', async () => {
    const keyBuf = Buffer.from('00'.repeat(32), 'hex'); // 32 zero bytes
    const enc = new DiskTier({ dir: tempDir(), maxBytes: 10 * 1024 * 1024, entryMaxBytes: 1024 * 1024, forbiddenPrefixes: [], encryptionKey: keyBuf, logger: consoleLogger });
    await enc.save('secret', makeEntry('sensitive-data'));
    expect(unpack(enc.load('secret')!.data as Buffer)).toBe('sensitive-data');
  });

  it('stats reflects stored files', async () => {
    await disk.save('s1', makeEntry('a'));
    await disk.save('s2', makeEntry('b'));
    // stats.files = file count on disk; stats.sizeKB tracks usage bytes (rounds to KB)
    expect(disk.stats.files).toBe(2);
    expect(disk.stats.maxKB).toBeGreaterThan(0);
  });

  // ── purgeNextBucket (staggered disk janitor) ─────────────────────────────

  describe('purgeNextBucket', () => {
    it('advances bucket pointer and wraps at 256', () => {
      for (let i = 0; i < 257; i++) disk.purgeNextBucket();
      // After 257 calls the pointer wraps once and lands on 1
      expect((disk as any)._nextJanitorBucket).toBe(1);
    });

    it('removes expired entries across a full 256-bucket cycle', async () => {
      await disk.save('expire-me', makeEntry('gone',  1));        // 1 ms TTL
      await disk.save('keep-me',   makeEntry('here',  60_000));  // 60s TTL
      expect(disk.stats.files).toBe(2);

      await new Promise(r => setTimeout(r, 30)); // let TTL expire

      let purged = 0;
      for (let i = 0; i < 256; i++) purged += disk.purgeNextBucket();

      expect(purged).toBe(1);
      expect(disk.stats.files).toBe(1);
      // live entry is still accessible
      expect(disk.load('keep-me')).not.toBeNull();
    });

    it('does not remove live entries', async () => {
      await disk.save('live1', makeEntry('a', 60_000));
      await disk.save('live2', makeEntry('b', 60_000));

      let purged = 0;
      for (let i = 0; i < 256; i++) purged += disk.purgeNextBucket();

      expect(purged).toBe(0);
      expect(disk.stats.files).toBe(2);
    });

    it('keeps fileCount and diskUsageBytes consistent after purge', async () => {
      await disk.save('exp', makeEntry('x', 1));
      await new Promise(r => setTimeout(r, 30));
      for (let i = 0; i < 256; i++) disk.purgeNextBucket();
      expect(disk.stats.files).toBe(0);
      expect(disk.stats.sizeKB).toBe(0);
    });

    it('returns 0 on an empty or non-existent bucket', () => {
      // No files saved — every bucket directory is absent
      const result = disk.purgeNextBucket();
      expect(result).toBe(0);
    });
  });
});
