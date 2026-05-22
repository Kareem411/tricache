/**
 * DiskTier — L1.5 NVMe-fast overflow cache between L1 RAM and L2 Redis/DB.
 *
 * When L1 evicts an entry it is spilled here instead of being discarded.
 * On a subsequent L1 miss the entry is promoted back (2–100 µs disk read
 * vs 10–100 ms DB round-trip).
 *
 * Storage:
 *   - Directory: configurable (default os.tmpdir()/tricache-disk)
 *   - Filename:  SHA-256(key) hex — bounded, URL-safe, no key injection
 *   - Format:    msgpack({ version, key, entry, writtenAt })
 *   - Mode:      0o600 — owner read/write only
 *
 * Encryption: same AES-256-GCM as L2 when CacheEncryption is configured.
 */

import fs                from 'fs';
import path              from 'path';
import crypto            from 'crypto';
import { pack, unpack }  from 'msgpackr';
import type { DiskCacheEntry, ILogger } from './types';

// ── Encryption (self-contained to avoid circular import) ─────────────────────

const AES_ALGO  = 'aes-256-gcm' as const;
const IV_BYTES  = 12;
const TAG_BYTES = 16;
const DISK_MAGIC = Buffer.from([0x44, 0x54, 0x49, 0x45, 0x52, 0x56, 0x31, 0x00]); // "DTIERV1\0"

interface DiskPayload {
  version:   number;
  key:       string;
  entry:     DiskCacheEntry;
  writtenAt: number;
}

const DISK_TIER_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────────────

export interface DiskTierOptions {
  dir:              string;
  maxBytes:         number;
  entryMaxBytes:    number;
  forbiddenPrefixes: readonly string[];
  encryptionKey?:   Buffer | null;
  logger:           ILogger;
}

export class DiskTier {
  private readonly opts:    DiskTierOptions;
  private dirReady          = false;
  private diskUsageBytes    = 0;
  private usageCounted      = false;
  private fileCount         = 0;   // maintained in-memory; avoids walkCacheFiles() in stats

  constructor(opts: DiskTierOptions) {
    this.opts = opts;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private ensureDir(): void {
    if (this.dirReady) return;
    try {
      fs.mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      this.dirReady = true;
    } catch (err) {
      this.opts.logger.warn('DiskTier: cannot create cache dir', { dir: this.opts.dir, error: (err as Error).message });
    }
  }

  private ensureUsageCounted(): void {
    if (this.usageCounted) return;
    this.usageCounted = true;
    try {
      this.ensureDir();
      let total = 0;
      const files = this.walkCacheFiles();
      this.fileCount = files.length;
      for (const filePath of files) {
        try { total += fs.statSync(filePath).size; } catch { /* ok */ }
      }
      this.diskUsageBytes = total;
    } catch { this.diskUsageBytes = 0; this.fileCount = 0; }
  }

  /**
   * Map a cache key to its on-disk path.
   *
   * Files are sharded into two-character hex prefix subdirectories to avoid
   * putting thousands of flat files into a single directory node — which
   * degrades EXT4/NTFS performance at scale.
   *
   *   key  → SHA-256 hex  e3b0c442...
   *   path → {dir}/e3/e3b0c442...
   */
  private keyToPath(key: string): string {
    const hash = crypto.createHash('sha256').update(key, 'utf8').digest('hex');
    return path.join(this.opts.dir, hash.slice(0, 2), hash);
  }

  /**
   * Recursively list all cache file paths across the 2-level sharded subdirs.
   * Top-level entries that are not directories are skipped (e.g. stale flat
   * files written by older versions).
   */
  private walkCacheFiles(): string[] {
    const results: string[] = [];
    let topEntries: string[];
    try { topEntries = fs.readdirSync(this.opts.dir); } catch { return results; }
    for (const top of topEntries) {
      const topPath = path.join(this.opts.dir, top);
      try {
        if (!fs.statSync(topPath).isDirectory()) continue;
        for (const file of fs.readdirSync(topPath)) {
          results.push(path.join(topPath, file));
        }
      } catch { /* skip locked/gone */ }
    }
    return results;
  }

  private isForbidden(key: string): boolean {
    return this.opts.forbiddenPrefixes.some(p => key.startsWith(p));
  }

  private encrypt(data: Buffer): Buffer {
    const key = this.opts.encryptionKey;
    if (!key) return data;
    const iv  = crypto.randomBytes(IV_BYTES);
    const c   = crypto.createCipheriv(AES_ALGO, key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    const tag = c.getAuthTag();
    return Buffer.concat([DISK_MAGIC, iv, tag, enc]);
  }

  private decrypt(data: Buffer): Buffer {
    const mLen = DISK_MAGIC.length;
    if (data.length < mLen || !data.subarray(0, mLen).equals(DISK_MAGIC)) return data;
    const key = this.opts.encryptionKey;
    if (!key) throw new Error('DiskTier: entry is encrypted but no key is set');
    const iv  = data.subarray(mLen, mLen + IV_BYTES);
    const tag = data.subarray(mLen + IV_BYTES, mLen + IV_BYTES + TAG_BYTES);
    const ct  = data.subarray(mLen + IV_BYTES + TAG_BYTES);
    const d   = crypto.createDecipheriv(AES_ALGO, key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Spill an evicted L1 entry to disk.
   *
   * Returns a Promise that resolves when the file is durably written. Callers
   * that treat the spill as fire-and-forget should do:
   *   `void disk.save(key, entry)`
   *
   * Implementation notes:
   *  - pack() + AES-256-GCM encrypt run synchronously — both are pure CPU,
   *    sub-millisecond for entries up to diskEntryMaxBytes, and do not block
   *    on any external resource.
   *  - The actual write syscall (mkdir + writeFile) is async via fs.promises,
   *    so the Node.js event loop is never stalled waiting for disk I/O.
   */
  async save(key: string, entry: DiskCacheEntry): Promise<void> {
    if (this.isForbidden(key)) return;
    if (entry.expiresAt <= Date.now()) return;

    this.ensureDir();
    if (!this.dirReady) return;
    this.ensureUsageCounted();
    if (this.diskUsageBytes >= this.opts.maxBytes) return; // disk cap hit

    // ── Synchronous phase: pack + encrypt (CPU-only, no I/O) ─────────────
    let final: Buffer;
    try {
      const payload: DiskPayload = {
        version: DISK_TIER_VERSION,
        key,
        entry: {
          ...entry,
          data: entry.data instanceof Uint8Array
            ? Buffer.from(entry.data)
            : entry.data,
        },
        writtenAt: Date.now(),
      };
      const packed = pack(payload);
      if (packed.length > this.opts.entryMaxBytes) return;
      final = this.encrypt(packed);
    } catch (err) {
      this.opts.logger.debug('DiskTier: pack/encrypt failed', { key: key.slice(0, 50), error: (err as Error).message });
      return;
    }

    // ── Async phase: mkdir + write (does not block the event loop) ────────
    const filePath = this.keyToPath(key);
    this.diskUsageBytes += final.length; // optimistic — rolled back on error
    this.fileCount++;

    try {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(filePath, final, { mode: 0o600 });
      this.opts.logger.debug('DiskTier: entry saved', { key: key.slice(0, 50), bytes: final.length });
    } catch (err) {
      this.diskUsageBytes -= Math.min(this.diskUsageBytes, final.length); // rollback
      this.fileCount = Math.max(0, this.fileCount - 1);
      this.opts.logger.debug('DiskTier: save failed', { key: key.slice(0, 50), error: (err as Error).message });
    }
  }

  /** Load a key from disk, or return null on miss/expiry/corruption. */
  load(key: string): DiskCacheEntry | null {
    if (this.isForbidden(key)) return null;
    this.ensureDir();
    if (!this.dirReady) return null;

    const filePath = this.keyToPath(key);
    try {
      if (!fs.existsSync(filePath)) return null;

      const stat = fs.statSync(filePath);
      if (stat.size > this.opts.entryMaxBytes) {
        fs.unlinkSync(filePath);
        this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
        return null;
      }

      const raw = fs.readFileSync(filePath);
      // Delete immediately — entry will be promoted back to L1
      try { fs.unlinkSync(filePath); this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size); this.fileCount = Math.max(0, this.fileCount - 1); } catch { /* ok */ }

      let decrypted: Buffer;
      try { decrypted = this.decrypt(raw); } catch { return null; }

      const payload = unpack(decrypted) as DiskPayload;
      if (!payload || payload.version !== DISK_TIER_VERSION || payload.key !== key) return null;
      if (payload.entry.expiresAt <= Date.now()) return null;

      const entry = payload.entry;
      if (entry.data instanceof Uint8Array) entry.data = Buffer.from(entry.data);

      this.opts.logger.debug('DiskTier: hit (→L1)', { key: key.slice(0, 50), ageMs: Date.now() - payload.writtenAt });
      return entry;
    } catch (err) {
      this.opts.logger.debug('DiskTier: load failed', { key: key.slice(0, 50), error: (err as Error).message });
      return null;
    }
  }

  /** Explicitly delete a key from disk (cache invalidation). */
  delete(key: string): void {
    const filePath = this.keyToPath(key);
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        fs.unlinkSync(filePath);
        this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
        this.fileCount = Math.max(0, this.fileCount - 1);
      }
    } catch { /* ok */ }
  }

  /** Purge all expired entries. Returns number deleted. */
  purgeExpired(): number {
    this.ensureDir();
    if (!this.dirReady) return 0;
    let purged = 0;
    for (const filePath of this.walkCacheFiles()) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > this.opts.entryMaxBytes) {
          fs.unlinkSync(filePath);
          this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
          this.fileCount = Math.max(0, this.fileCount - 1);
          purged++;
          continue;
        }
        const raw = fs.readFileSync(filePath);
        let dec: Buffer;
        try { dec = this.decrypt(raw); } catch { fs.unlinkSync(filePath); this.fileCount = Math.max(0, this.fileCount - 1); purged++; continue; }
        const payload = unpack(dec) as DiskPayload;
        if (!payload || payload.version !== DISK_TIER_VERSION || payload.entry.expiresAt <= Date.now()) {
          fs.unlinkSync(filePath);
          this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
          this.fileCount = Math.max(0, this.fileCount - 1);
          purged++;
        }
      } catch { /* skip locked/gone */ }
    }
    return purged;
  }

  get stats(): { files: number; sizeKB: number; maxKB: number } {
    // fileCount is maintained in-memory — O(1), no filesystem scan.
    return { files: this.fileCount, sizeKB: Math.round(this.diskUsageBytes / 1024), maxKB: Math.round(this.opts.maxBytes / 1024) };
  }
}
