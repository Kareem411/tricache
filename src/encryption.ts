/**
 * Encryption / obfuscation for L2 (Redis) values and disk snapshots at rest.
 *
 * Four modes are supported via the `encryptionMode` CacheOption:
 *
 * ┌──────────────┬────────────┬──────────────────────────────────────────────────────────────┐
 * │ Mode         │ Key bytes  │ Notes                                                        │
 * ├──────────────┼────────────┼──────────────────────────────────────────────────────────────┤
 * │ aes-256-gcm  │ 32         │ Default. Authenticated encryption (AEAD).                    │
 * │ aes-128-gcm  │ 16         │ ~15% faster than AES-256. AEAD.                              │
 * │ aes-128-ctr  │ 16         │ Fastest cipher. AES-NI keystream, no auth tag.               │
 * │              │            │ Use when integrity is guaranteed elsewhere (TLS, HMAC, etc.). │
 * │ xor          │ any (≥ 1)  │ XOR obfuscation ONLY — NOT cryptographic.                    │
 * │              │            │ Use only for dev or non-sensitive data.                       │
 * └──────────────┴────────────┴──────────────────────────────────────────────────────────────┘
 *
 * Key generation:
 *   AES-256 (32 B): node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   AES-128 (16 B): node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
 *   CTR    (16 B):  node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
 *   XOR (any len):  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Redis envelope formats:
 *   enc:v1:<base64(IV[12]|Tag[16]|CT)>   ← AES-256-GCM
 *   a128:v1:<base64(IV[12]|Tag[16]|CT)>  ← AES-128-GCM
 *   ctr:v1:<base64(IV[16]|CT)>           ← AES-128-CTR (no auth tag)
 *   xor:v1:<base64(key⊕data)>            ← XOR (self-inverse)
 *
 * Disk envelope formats:
 *   TRIC1ENC | IV[12] | Tag[16] | CT[N]  ← AES-256-GCM
 *   TRIC1128 | IV[12] | Tag[16] | CT[N]  ← AES-128-GCM
 *   TRIC1CTR | IV[16] | CT[N]            ← AES-128-CTR (no auth tag)
 *   TRIC1XOR | key⊕data[N]               ← XOR
 */

import { createCipheriv, createDecipheriv, randomFillSync } from 'crypto';
import type { ILogger } from './types';

// ── Public type ───────────────────────────────────────────────────────────────
/** Encryption algorithm used for L2 (Redis) values and disk-tier files. */
export type EncryptionMode = 'aes-256-gcm' | 'aes-128-gcm' | 'aes-128-ctr' | 'xor';

// ── GCM constants ─────────────────────────────────────────────────────────────
const IV_BYTES  = 12; // 96-bit IV (NIST recommended for GCM)
const TAG_BYTES = 16; // 128-bit auth tag

// ── Redis prefixes ────────────────────────────────────────────────────────────
const PREFIX_256 = 'enc:v1:';   // AES-256-GCM (legacy-compatible)
const PREFIX_128 = 'a128:v1:';  // AES-128-GCM
const PREFIX_XOR = 'xor:v1:';   // XOR obfuscation

// ── Binary magic headers (8 bytes each) ──────────────────────────────────────
/** "TRIC1ENC" — AES-256-GCM disk blob */
const MAGIC_256 = Buffer.from([0x54, 0x52, 0x49, 0x43, 0x31, 0x45, 0x4e, 0x43]);
/** "TRIC1128" — AES-128-GCM disk blob */
const MAGIC_128 = Buffer.from([0x54, 0x52, 0x49, 0x43, 0x31, 0x31, 0x32, 0x38]);
/** "TRIC1XOR" — XOR-obfuscated disk blob */
const MAGIC_XOR = Buffer.from([0x54, 0x52, 0x49, 0x43, 0x31, 0x58, 0x4f, 0x52]);
/** "TRIC1CTR" — AES-128-CTR disk blob */
const MAGIC_CTR = Buffer.from([0x54, 0x52, 0x49, 0x43, 0x31, 0x43, 0x54, 0x52]);

const MAGIC_LEN = 8;

// ── CTR constants ─────────────────────────────────────────────────────────────
/** AES-128-CTR IV is the full 128-bit AES block used as the initial counter block. */
const CTR_IV_BYTES = 16;
const PREFIX_CTR   = 'ctr:v1:'; // AES-128-CTR (no auth tag)

// ── IV pool ───────────────────────────────────────────────────────────────────
// randomFillSync() fills the existing Buffer in-place — no allocation on refill.
const IV_POOL_COUNT = 64;

export class CacheEncryption {
  private _key: Buffer | null = null;
  private readonly _mode: EncryptionMode;
  private _prevKey:  Buffer | null = null;
  private _prevMode: EncryptionMode = 'aes-256-gcm';

  // Pre-allocated GCM IV pool — 12-byte IVs (96-bit, NIST recommended).
  private readonly _ivPool = Buffer.allocUnsafe(IV_BYTES * IV_POOL_COUNT);
  private _ivOffset        = IV_BYTES * IV_POOL_COUNT; // start exhausted → fill on first use

  /** Return the next unique 12-byte IV slice from the pre-allocated GCM pool. */
  private _nextIV(): Buffer {
    if (this._ivOffset >= this._ivPool.length) {
      randomFillSync(this._ivPool); // fills existing Buffer in-place — zero allocation
      this._ivOffset = 0;
    }
    const iv = this._ivPool.subarray(this._ivOffset, this._ivOffset + IV_BYTES); // Buffer (not Uint8Array)
    this._ivOffset += IV_BYTES;
    return iv;
  }

  // Pre-allocated CTR IV pool — 16-byte IVs (full AES block = initial counter block).
  private readonly _ctrIvPool = Buffer.allocUnsafe(CTR_IV_BYTES * IV_POOL_COUNT);
  private _ctrIvOffset        = CTR_IV_BYTES * IV_POOL_COUNT;

  /** Return the next unique 16-byte IV slice from the pre-allocated CTR pool. */
  private _nextCtrIV(): Buffer {
    if (this._ctrIvOffset >= this._ctrIvPool.length) {
      randomFillSync(this._ctrIvPool);
      this._ctrIvOffset = 0;
    }
    const iv = this._ctrIvPool.subarray(this._ctrIvOffset, this._ctrIvOffset + CTR_IV_BYTES);
    this._ctrIvOffset += CTR_IV_BYTES;
    return iv;
  }

  /**
   * XOR `data` with the key, cycling through key bytes.
   * Self-inverse: _xorBuffer(_xorBuffer(x)) === x.
   *
   * Fast path: Uint32Array views over the existing Buffer memory — zero copy,
   * no method-call overhead. V8 JITs `out32[i] = data32[i] ^ key32[...]`
   * to a single `XOR r32, r32` instruction. Requires 4-byte-aligned byteOffsets,
   * which Node.js guarantees (pool rounds up to 8 bytes; direct allocs to page).
   *
   * WARNING: XOR is NOT cryptographic. It provides obfuscation only.
   */
  private _xorBuffer(data: Buffer): Buffer {
    const key  = this._key!;
    const klen = key.length;
    const len  = data.length;
    const out  = Buffer.allocUnsafe(len);

    if (
      klen % 4 === 0 &&
      len  >= 4 &&
      data.byteOffset % 4 === 0 &&
      out.byteOffset  % 4 === 0 &&
      key.byteOffset  % 4 === 0
    ) {
      const wordCount = len >>> 2;
      const data32    = new Uint32Array(data.buffer, data.byteOffset, wordCount);
      const out32     = new Uint32Array(out.buffer,  out.byteOffset,  wordCount);
      const key32     = new Uint32Array(key.buffer,  key.byteOffset,  klen >>> 2);
      const kLen32    = key32.length;
      for (let i = 0; i < wordCount; i++) {
        out32[i] = data32[i] ^ key32[i % kLen32];
      }
      // 0–3 trailing bytes
      for (let i = wordCount << 2; i < len; i++) {
        out[i] = data[i] ^ key[i % klen];
      }
      return out;
    }

    // Fallback: buffer not 4-byte-aligned or key length not a multiple of 4
    for (let i = 0; i < len; i++) {
      out[i] = data[i] ^ key[i % klen];
    }
    return out;
  }

  constructor(
    keyBase64: string | undefined,
    logger: ILogger,
    mode: EncryptionMode = 'aes-256-gcm',
    previousKeyBase64?: string,
    previousMode?: EncryptionMode,
  ) {
    this._mode = mode;
    if (!keyBase64) {
      if (process.env.NODE_ENV === 'production') {
        logger.warn(
          'SECURITY: encryption key not set — cache data stored unencrypted at rest',
          { hint: 'Set encryptionKey option or CACHE_ENCRYPTION_KEY env var' },
        );
      }
      return;
    }
    try {
      const buf = Buffer.from(keyBase64, 'base64');
      const requiredLen = mode === 'aes-256-gcm' ? 32 : (mode === 'aes-128-gcm' || mode === 'aes-128-ctr') ? 16 : 0;
      if (requiredLen > 0 && buf.length !== requiredLen) {
        throw new Error(`${mode} requires exactly ${requiredLen} bytes (got ${buf.length})`);
      }
      if (buf.length < 1) {
        throw new Error('XOR key must be at least 1 byte');
      }
      this._key = buf;
      if (mode === 'xor') {
        logger.warn(
          'Cache obfuscation enabled (XOR). WARNING: XOR is NOT cryptographic — use only for dev or non-sensitive data.',
        );
      } else {
        logger.debug(`Cache encryption enabled (${mode.toUpperCase()})`);
      }
    } catch (err) {
      logger.error('Invalid encryption key — falling back to plaintext', {}, err as Error);
    }

    if (previousKeyBase64) {
      try {
        this._prevMode = previousMode ?? mode;
        this._prevKey  = Buffer.from(previousKeyBase64, 'base64');
        logger.debug('Previous encryption key loaded for key rotation fallback');
      } catch (err) {
        logger.warn('Invalid previousEncryptionKey — rotation fallback disabled', { error: (err as Error).message });
      }
    }
  }

  get isEnabled(): boolean { return this._key !== null; }

  // ── String (Redis) ────────────────────────────────────────────────────────

  /**
   * Encrypt a string for Redis storage.
   * Returns a mode-prefixed base64 string when a key is configured;
   * otherwise returns the original string unchanged (backward-compatible).
   */
  encrypt(plaintext: string): string {
    if (!this._key) return plaintext;
    if (this._mode === 'xor') {
      // WARNING: XOR is NOT cryptographic — obfuscation only.
      const masked = this._xorBuffer(Buffer.from(plaintext, 'utf8'));
      return PREFIX_XOR + masked.toString('base64');
    }
    if (this._mode === 'aes-128-ctr') {
      const iv  = this._nextCtrIV();
      const c   = createCipheriv('aes-128-ctr', this._key, iv);
      const enc = c.update(plaintext, 'utf8');
      const fin = c.final(); // CTR: almost always empty — captured defensively
      const out = Buffer.allocUnsafe(CTR_IV_BYTES + enc.length + fin.length);
      iv.copy(out, 0);
      enc.copy(out, CTR_IV_BYTES);
      if (fin.length > 0) fin.copy(out, CTR_IV_BYTES + enc.length);
      return PREFIX_CTR + out.toString('base64');
    }
    const algo   = this._mode === 'aes-128-gcm' ? 'aes-128-gcm' : 'aes-256-gcm';
    const prefix = this._mode === 'aes-128-gcm' ? PREFIX_128 : PREFIX_256;
    const iv  = this._nextIV();
    const c   = createCipheriv(algo, this._key, iv);
    const enc = c.update(plaintext, 'utf8'); // GCM: final() emits no bytes
    c.final();                               // finalise — makes auth tag available
    const out = Buffer.allocUnsafe(IV_BYTES + TAG_BYTES + enc.length);
    iv.copy(out, 0);
    c.getAuthTag().copy(out, IV_BYTES);
    enc.copy(out, IV_BYTES + TAG_BYTES);
    return prefix + out.toString('base64');
  }

  /**
   * Decrypt a Redis value.
   * Auto-detects the envelope prefix; returns plaintext unchanged if no prefix matches.
   * Falls back to `previousEncryptionKey` when the primary key fails (key rotation).
   */
  decrypt(value: string): string {
    try {
      return this._decryptWithKey(value, this._key, this._mode);
    } catch (primaryErr) {
      if (this._prevKey) {
        try {
          return this._decryptWithKey(value, this._prevKey, this._prevMode);
        } catch { /* ignore — fall through to re-throw primary */ }
      }
      throw primaryErr;
    }
  }

  private _decryptWithKey(value: string, key: Buffer | null, mode: EncryptionMode): string {
    if (value.startsWith(PREFIX_XOR)) {
      if (!key) throw new Error('Cannot decrypt: encryption key is not set');
      // WARNING: XOR is NOT cryptographic — obfuscation only.
      const masked = Buffer.from(value.slice(PREFIX_XOR.length), 'base64');
      // XOR is self-inverse; use the provided key regardless of mode
      const klen = key.length;
      const len  = masked.length;
      const out  = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = masked[i] ^ key[i % klen];
      return out.toString('utf8');
    }
    if (value.startsWith(PREFIX_CTR)) {
      if (!key) throw new Error('Cannot decrypt: encryption key is not set');
      const combined = Buffer.from(value.slice(PREFIX_CTR.length), 'base64');
      const iv = combined.subarray(0, CTR_IV_BYTES);
      const ct = combined.subarray(CTR_IV_BYTES);
      const d  = createDecipheriv('aes-128-ctr', key, iv);
      const plain = d.update(ct);
      const fin   = d.final(); // CTR: almost always empty — concat before UTF-8 decode to avoid split-sequence corruption
      return (fin.length > 0 ? Buffer.concat([plain, fin]) : plain).toString('utf8');
    }
    const is256 = value.startsWith(PREFIX_256);
    const is128 = value.startsWith(PREFIX_128);
    if (!is256 && !is128) return value;
    if (!key) throw new Error('Cannot decrypt: encryption key is not set');
    const prefix = is128 ? PREFIX_128 : PREFIX_256;
    const algo   = is128 ? 'aes-128-gcm' : 'aes-256-gcm';
    const combined = Buffer.from(value.slice(prefix.length), 'base64');
    const iv  = combined.subarray(0, IV_BYTES);
    const tag = combined.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ct  = combined.subarray(IV_BYTES + TAG_BYTES);
    const d   = createDecipheriv(algo, key, iv);
    d.setAuthTag(tag);
    const plain = d.update(ct);  // GCM: final() emits no bytes
    d.final();                   // verifies auth tag — throws on tamper
    return plain.toString('utf8');
    void mode; // mode is used implicitly via prefix detection
  }

  // ── Buffer (disk / snapshot) ──────────────────────────────────────────────

  /** Encrypt a raw Buffer for disk/snapshot. Returns MAGIC | payload when a key is set. */
  encryptBuffer(data: Buffer): Buffer {
    if (!this._key) return data;
    if (this._mode === 'xor') {
      // WARNING: XOR is NOT cryptographic — obfuscation only.
      const masked = this._xorBuffer(data);
      const out = Buffer.allocUnsafe(MAGIC_LEN + masked.length);
      MAGIC_XOR.copy(out, 0);
      masked.copy(out, MAGIC_LEN);
      return out;
    }
    if (this._mode === 'aes-128-ctr') {
      const iv  = this._nextCtrIV();
      const c   = createCipheriv('aes-128-ctr', this._key, iv);
      const enc = c.update(data);
      const fin = c.final(); // CTR: almost always empty — captured defensively
      // Single pre-allocated output buffer: magic(8) | iv(16) | ciphertext(N)
      const out = Buffer.allocUnsafe(MAGIC_LEN + CTR_IV_BYTES + enc.length + fin.length);
      MAGIC_CTR.copy(out, 0);
      iv.copy(out, MAGIC_LEN);
      enc.copy(out, MAGIC_LEN + CTR_IV_BYTES);
      if (fin.length > 0) fin.copy(out, MAGIC_LEN + CTR_IV_BYTES + enc.length);
      return out;
    }
    const magic = this._mode === 'aes-128-gcm' ? MAGIC_128 : MAGIC_256;
    const algo  = this._mode === 'aes-128-gcm' ? 'aes-128-gcm' : 'aes-256-gcm';
    const iv    = this._nextIV();
    const c     = createCipheriv(algo, this._key, iv);
    const enc   = c.update(data); // GCM: final() emits no bytes
    c.final();                    // finalise — makes auth tag available
    // Single pre-allocated output buffer: magic(8) | iv(12) | tag(16) | ciphertext(N)
    const out   = Buffer.allocUnsafe(MAGIC_LEN + IV_BYTES + TAG_BYTES + enc.length);
    magic.copy(out, 0);
    iv.copy(out, MAGIC_LEN);
    c.getAuthTag().copy(out, MAGIC_LEN + IV_BYTES);
    enc.copy(out, MAGIC_LEN + IV_BYTES + TAG_BYTES);
    return out;
  }

  /**
   * Decrypt a raw Buffer from disk/snapshot.
   * Auto-detects the magic header; returns the original buffer if no magic matches (legacy/unencrypted).
   * Falls back to `previousEncryptionKey` when the primary key fails (key rotation).
   */
  decryptBuffer(data: Buffer): Buffer {
    try {
      return this._decryptBufferWithKey(data, this._key);
    } catch (primaryErr) {
      if (this._prevKey) {
        try {
          return this._decryptBufferWithKey(data, this._prevKey);
        } catch { /* ignore — re-throw primary */ }
      }
      throw primaryErr;
    }
  }

  private _decryptBufferWithKey(data: Buffer, key: Buffer | null): Buffer {
    if (data.length < MAGIC_LEN) return data;
    const magic = data.subarray(0, MAGIC_LEN);

    if (magic.equals(MAGIC_XOR)) {
      if (!key) throw new Error('Cannot decrypt buffer: encryption key is not set');
      // WARNING: XOR is NOT cryptographic — obfuscation only.
      const raw  = data.subarray(MAGIC_LEN);
      const klen = key.length;
      const out  = Buffer.allocUnsafe(raw.length);
      for (let i = 0; i < raw.length; i++) out[i] = raw[i] ^ key[i % klen];
      return out;
    }

    if (magic.equals(MAGIC_CTR)) {
      if (!key) throw new Error('Cannot decrypt buffer: encryption key is not set');
      const iv = data.subarray(MAGIC_LEN, MAGIC_LEN + CTR_IV_BYTES);
      const ct = data.subarray(MAGIC_LEN + CTR_IV_BYTES);
      const d  = createDecipheriv('aes-128-ctr', key, iv);
      const plain = d.update(ct);
      const fin   = d.final(); // CTR: almost always empty — captured defensively
      return fin.length > 0 ? Buffer.concat([plain, fin]) : plain;
    }
    const is256 = magic.equals(MAGIC_256);
    const is128 = magic.equals(MAGIC_128);
    if (!is256 && !is128) return data;
    if (!key) throw new Error('Cannot decrypt buffer: encryption key is not set');
    const algo = is128 ? 'aes-128-gcm' : 'aes-256-gcm';
    const iv  = data.subarray(MAGIC_LEN, MAGIC_LEN + IV_BYTES);
    const tag = data.subarray(MAGIC_LEN + IV_BYTES, MAGIC_LEN + IV_BYTES + TAG_BYTES);
    const ct  = data.subarray(MAGIC_LEN + IV_BYTES + TAG_BYTES);
    const d   = createDecipheriv(algo, key, iv);
    d.setAuthTag(tag);
    const plain = d.update(ct);  // GCM: final() emits no bytes
    d.final();                   // verifies auth tag — throws on tamper
    return plain;
  }
}
