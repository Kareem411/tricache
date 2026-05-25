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
import { DiskCacheEntry, ILogger } from './types.js';
// ── Encryption (self-contained to avoid circular import) ─────────────────────

const AES_ALGO  = 'aes-256-gcm' as const;
const IV_BYTES  = 12;
const TAG_BYTES = 16;
const DISK_MAGIC    = Buffer.from([0x44, 0x54, 0x49, 0x45, 0x52, 0x56, 0x31, 0x00]); // "DTIERV1\0"
/**
 * V2 file format — expiresAt stored in plaintext outside the ciphertext so the
 * janitor can check expiry with a 16-byte header read rather than a full
 * decrypt + unpack.  Layout (bytes):
 *   0–7   DISK_MAGIC_V2 ("DTIERV2\0")
 *   8–15  expiresAt, uint64 LE (ms since epoch, outside encryption)
 *  16+    encryptV2(msgpack(DiskPayload)) — IV+TAG+ct if key set, else raw msgpack
 */
const DISK_MAGIC_V2 = Buffer.from([0x44, 0x54, 0x49, 0x45, 0x52, 0x56, 0x32, 0x00]); // "DTIERV2\0"
const V2_HEADER_LEN = 16; // magic(8) + expiresAt(8)

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
  /** Next bucket index (0–255) for the staggered janitor wheel. */
  private _nextJanitorBucket = 0;

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
   * SHA-256 hex digest of a key (pure CPU, no I/O).
   * Kept separate from path construction so callers can find files by prefix
   * without knowing which filename generation was used when the file was written.
   */
  private keyToHash(key: string): string {
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  }

  /**
   * Build the write path for a NEW file (V3 generation).
   * Encoding expiresAt in the filename lets purgeNextBucket() skip live entries
   * with zero file I/O — after readdirSync() it only needs a string parse.
   *
   *   {dir}/{hash[0..1]}/{hash}_{expiresAt-hex-12}
   *   e.g.  {dir}/e3/e3b0c442…abcd_018f7c3b5a00
   *
   * 12 hex digits ≈ 6 bytes ≈ year 10889 max.  Padded so length is always 77 chars.
   */
  private hashToWritePath(hash: string, expiresAt: number): string {
    return path.join(this.opts.dir, hash.slice(0, 2), `${hash}_${expiresAt.toString(16).padStart(12, '0')}`);
  }

  /**
   * Find the on-disk file for a key hash, handling all filename generations:
   *   V3 (current): "{hash}_{expiresHex12}" — 77 chars
   *   V1/V2 (older): "{hash}"              — 64 chars, no suffix
   * Returns null when the bucket dir does not exist or the key is absent.
   */
  private findFilePath(hash: string): string | null {
    const bucketPath = path.join(this.opts.dir, hash.slice(0, 2));
    let files: string[];
    try { files = fs.readdirSync(bucketPath); } catch { return null; }
    // Return the lexicographically largest match: V3 filenames are
    // "{hash}_{expiresHex12}", so lex-max = largest timestamp = newest entry.
    // If the same key was evicted to disk twice (different TTLs → different names),
    // this ensures we always serve and delete the freshest copy; the janitor cleans
    // up the stale one when its encoded timestamp expires.
    let match: string | undefined;
    for (const f of files) {
      if ((f === hash || f.startsWith(hash + '_')) && (!match || f > match)) match = f;
    }
    if (!match) return null;
    return path.join(bucketPath, match);
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

  /**
   * V2 encryption — returns IV+TAG+ciphertext (no magic prefix; magic lives in
   * the outer 16-byte header alongside the plaintext expiresAt).
   * Returns the buffer unchanged when no encryption key is configured.
   */
  private encryptV2(data: Buffer): Buffer {
    const key = this.opts.encryptionKey;
    if (!key) return data;
    const iv  = crypto.randomBytes(IV_BYTES);
    const c   = crypto.createCipheriv(AES_ALGO, key, iv);
    const enc = Buffer.concat([c.update(data), c.final()]);
    const tag = c.getAuthTag();
    return Buffer.concat([iv, tag, enc]);
  }

  /**
   * V2 decryption — inner payload after stripping the 16-byte header.
   * When a key is configured the format is IV(12)+TAG(16)+ciphertext;
   * without a key the payload is raw msgpack.
   */
  private decryptV2(inner: Buffer): Buffer {
    const key = this.opts.encryptionKey;
    if (!key) return inner;
    const iv  = inner.subarray(0, IV_BYTES);
    const tag = inner.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct  = inner.subarray(IV_BYTES + TAG_BYTES);
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
      // V2 format: 16-byte plaintext header (magic + expiresAt) followed by the
      // encrypted-or-raw payload.  The plaintext expiresAt allows purgeNextBucket()
      // to check expiry with a 16-byte partial read — no decrypt or unpack needed.
      const header = Buffer.allocUnsafe(V2_HEADER_LEN);
      DISK_MAGIC_V2.copy(header, 0);
      header.writeBigUInt64LE(BigInt(entry.expiresAt), 8);
      final = Buffer.concat([header, this.encryptV2(packed)]);
    } catch (err) {
      this.opts.logger.debug('DiskTier: pack/encrypt failed', { key: key.slice(0, 50), error: (err as Error).message });
      return;
    }

    // ── Async phase: mkdir + write (does not block the event loop) ────
    const hash     = this.keyToHash(key);
    const filePath = this.hashToWritePath(hash, entry.expiresAt);
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

    const hash     = this.keyToHash(key);
    const filePath = this.findFilePath(hash);
    if (!filePath) return null;

    try {
      // V3 fast path: expiresAt is in the filename — avoid even opening the file
      // when the entry is already known to be stale.
      const filename = path.basename(filePath);
      if (filename.length === 77 && filename[64] === '_') {
        const expiresAt = parseInt(filename.slice(65), 16);
        if (expiresAt <= Date.now()) {
          try {
            const sz = fs.statSync(filePath).size;
            fs.unlinkSync(filePath);
            this.diskUsageBytes -= Math.min(this.diskUsageBytes, sz);
            this.fileCount = Math.max(0, this.fileCount - 1);
          } catch { /* ok */ }
          return null;
        }
      }

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
      if (raw.length >= V2_HEADER_LEN && raw.subarray(0, 8).equals(DISK_MAGIC_V2)) {
        // V2/V3: quick expiry guard from plaintext header before paying decrypt cost
        const expiresAt = Number(raw.readBigUInt64LE(8));
        if (expiresAt <= Date.now()) return null;
        try { decrypted = this.decryptV2(raw.subarray(V2_HEADER_LEN)); } catch { return null; }
      } else {
        // V1 / legacy unencrypted — backward compat
        try { decrypted = this.decrypt(raw); } catch { return null; }
      }

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
    const hash     = this.keyToHash(key);
    const filePath = this.findFilePath(hash);
    if (!filePath) return;
    try {
      const stat = fs.statSync(filePath);
      fs.unlinkSync(filePath);
      this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
      this.fileCount = Math.max(0, this.fileCount - 1);
    } catch { /* ok */ }
  }

  /** Purge all expired entries. Returns number deleted. */
  purgeExpired(): number {
    this.ensureDir();
    if (!this.dirReady) return 0;
    const now = Date.now();
    let purged = 0;
    // One reusable header buffer — avoids per-file allocation inside the V2 fallback loop.
    const headerBuf = Buffer.allocUnsafe(V2_HEADER_LEN);
    for (const filePath of this.walkCacheFiles()) {
      const filename = path.basename(filePath);

      // ── V3 fast path: expiresAt encoded in filename, zero file I/O for live entries
      if (filename.length === 77 && filename[64] === '_') {
        const expiresAt = parseInt(filename.slice(65), 16);
        if (expiresAt <= now) {
          try {
            const sz = fs.statSync(filePath).size;
            fs.unlinkSync(filePath);
            this.diskUsageBytes -= Math.min(this.diskUsageBytes, sz);
            this.fileCount = Math.max(0, this.fileCount - 1);
            purged++;
          } catch { /* already gone */ }
        }
        continue;
      }

      // ── V2 header fast path: read only the 16-byte plaintext header ────────
      let fd = -1;
      try {
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, headerBuf, 0, V2_HEADER_LEN, 0);
        fs.closeSync(fd); fd = -1;

        if (bytesRead === V2_HEADER_LEN && headerBuf.subarray(0, 8).equals(DISK_MAGIC_V2)) {
          const expiresAt = Number(headerBuf.readBigUInt64LE(8));
          if (expiresAt <= now) {
            try {
              const sz = fs.statSync(filePath).size;
              fs.unlinkSync(filePath);
              this.diskUsageBytes -= Math.min(this.diskUsageBytes, sz);
              this.fileCount = Math.max(0, this.fileCount - 1);
              purged++;
            } catch { /* already gone */ }
          }
          continue;
        }

        // ── Legacy path: V1 encrypted or pre-magic unencrypted ────────────
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
        if (!payload || payload.version !== DISK_TIER_VERSION || payload.entry.expiresAt <= now) {
          fs.unlinkSync(filePath);
          this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
          this.fileCount = Math.max(0, this.fileCount - 1);
          purged++;
        }
      } catch { /* skip locked/gone */ } finally {
        if (fd >= 0) try { fs.closeSync(fd); } catch { /* ok */ }
      }
    }
    return purged;
  }

  /**
   * Purge expired entries from exactly one of the 256 subdirectory buckets, then
   * advance the wheel pointer.  Call on a short recurring interval (e.g. 30 s) so
   * the O(fileCount) work of a full purgeExpired() is spread over 256 ticks instead
   * of landing as one large synchronous burst every 5 minutes.
   *
   * V3 files: expiresAt is encoded in the filename — live entries skip with zero
   * file I/O (just readdirSync + string parse).  Expired entries: statSync + unlinkSync.
   *
   * Returns the number of entries deleted in this tick.
   */
  purgeNextBucket(): number {
    this.ensureDir();
    if (!this.dirReady) return 0;
    const bucket = this._nextJanitorBucket.toString(16).padStart(2, '0');
    this._nextJanitorBucket = (this._nextJanitorBucket + 1) % 256;
    const bucketPath = path.join(this.opts.dir, bucket);
    let files: string[];
    try { files = fs.readdirSync(bucketPath); } catch { return 0; }
    const now = Date.now();
    let purged = 0;
    // One reusable header buffer — avoids per-file allocation inside the V2 fallback loop.
    const headerBuf = Buffer.allocUnsafe(V2_HEADER_LEN);
    for (const file of files) {
      // ── V3 fast path: expiresAt encoded in filename, zero file I/O for live entries
      // Filename format: {sha256-64-hex}_{expiresAt-12-hex} = 77 chars total.
      if (file.length === 77 && file[64] === '_') {
        const expiresAt = parseInt(file.slice(65), 16);
        if (expiresAt <= now) {
          const filePath = path.join(bucketPath, file);
          try {
            const sz = fs.statSync(filePath).size;
            fs.unlinkSync(filePath);
            this.diskUsageBytes -= Math.min(this.diskUsageBytes, sz);
            this.fileCount = Math.max(0, this.fileCount - 1);
            purged++;
          } catch { /* already gone */ }
        }
        continue; // live or just deleted — no further work
      }

      // ── V2 header path: open+read(16)+close ───────────────────────────────
      const filePath = path.join(bucketPath, file);
      let fd = -1;
      try {
        fd = fs.openSync(filePath, 'r');
        const bytesRead = fs.readSync(fd, headerBuf, 0, V2_HEADER_LEN, 0);
        fs.closeSync(fd); fd = -1;

        if (bytesRead === V2_HEADER_LEN && headerBuf.subarray(0, 8).equals(DISK_MAGIC_V2)) {
          const expiresAt = Number(headerBuf.readBigUInt64LE(8));
          if (expiresAt <= now) {
            try {
              const sz = fs.statSync(filePath).size;
              fs.unlinkSync(filePath);
              this.diskUsageBytes -= Math.min(this.diskUsageBytes, sz);
              this.fileCount = Math.max(0, this.fileCount - 1);
              purged++;
            } catch { /* already gone */ }
          }
          continue;
        }

        // ── Legacy path: V1 encrypted or pre-magic unencrypted ────────────
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
        if (!payload || payload.version !== DISK_TIER_VERSION || payload.entry.expiresAt <= now) {
          fs.unlinkSync(filePath);
          this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
          this.fileCount = Math.max(0, this.fileCount - 1);
          purged++;
        }
      } catch { /* skip locked/gone */ } finally {
        if (fd >= 0) try { fs.closeSync(fd); } catch { /* ok */ }
      }
    }
    return purged;
  }

  /** Delete every file in the disk cache. Returns the count deleted. */
  clear(): number {
    this.ensureDir();
    if (!this.dirReady) return 0;
    let cleared = 0;
    for (const filePath of this.walkCacheFiles()) {
      try {
        const stat = fs.statSync(filePath);
        fs.unlinkSync(filePath);
        this.diskUsageBytes -= Math.min(this.diskUsageBytes, stat.size);
        this.fileCount = Math.max(0, this.fileCount - 1);
        cleared++;
      } catch { /* skip locked/gone */ }
    }
    return cleared;
  }

  get stats(): { files: number; sizeKB: number; maxKB: number } {
    // fileCount is maintained in-memory — O(1), no filesystem scan.
    return { files: this.fileCount, sizeKB: Math.round(this.diskUsageBytes / 1024), maxKB: Math.round(this.opts.maxBytes / 1024) };
  }
}
