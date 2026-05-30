/**
 * WorkerPool — a fixed-size pool of worker threads for off-main-thread
 * encryption and decryption of large cache payloads.
 *
 * Design goals:
 *  - Zero-allocation hot path: pending Promises are stored in a pre-keyed Map.
 *  - Round-robin dispatch: tasks fan out evenly across all workers.
 *  - Auto-fallback: if the pool fails to initialize, `isAvailable` is false and
 *    the caller falls through to the synchronous path without any error.
 *  - Graceful drain: `destroy()` terminates all workers after in-flight
 *    Promises have settled.
 *
 * Memory model:
 *  - The encryption key is passed once via `workerData` at thread creation.
 *    Per-message IPC carries only the plaintext/ciphertext string — no key material.
 *  - All message payloads are structured-cloned (strings are fast to clone).
 *
 * Usage:
 *   const pool = new WorkerPool({ keyBase64, mode, size: 2 });
 *   if (pool.isAvailable) {
 *     const cipher = await pool.encrypt(jsonString);
 *     const plain  = await pool.decrypt(cipher);
 *   }
 */

import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { EncryptionMode } from './encryption.js';

// Locate the serialize-worker entry point.
// Production: tsup emits compile .js files as flat siblings → use .js path.
// Development / test (tsx, Vitest): the .ts source is used directly with the
// tsx ESM loader registered via execArgv so TypeScript is transpiled on-demand.
import { existsSync } from 'fs';

let _workerFile: string;
let _workerExecArgv: string[] = [];

try {
  const dir = dirname(fileURLToPath(import.meta.url));
  const jsPath = join(dir, 'serialize-worker.js');
  const tsPath = join(dir, 'serialize-worker.ts');

  if (existsSync(jsPath)) {
    // Compiled output present (dist/ after tsup, or src/ after manual compile)
    _workerFile = jsPath;
  } else if (existsSync(tsPath)) {
    // Source-only environment (Vitest, tsx dev runner) — run via tsx loader
    _workerFile    = tsPath;
    _workerExecArgv = ['--import', 'tsx/esm'];
  } else {
    _workerFile = jsPath; // will fail at runtime → pool marks itself unavailable
  }
} catch {
  // CJS fallback — __dirname is available natively in CJS (and shimmed by tsup for ESM).
  _workerFile = join(__dirname, 'serialize-worker.js');
}

export interface WorkerPoolOptions {
  /** Base64-encoded raw key bytes. Empty string = no encryption (pool becomes a no-op pass-through). */
  keyBase64:      string;
  mode:           EncryptionMode;
  prevKeyBase64?: string;
  prevMode?:      EncryptionMode;
  /** Number of worker threads. Default: min(4, availableCPUs). */
  size?:          number;
}

type PendingEntry = { resolve: (v: string) => void; reject: (e: Error) => void };

export class WorkerPool {
  private readonly workers:  Worker[] = [];
  private readonly pending:  Map<number, PendingEntry>[] = [];
  private _nextId            = 0;
  private _robin             = 0;
  private _available         = false;

  constructor(opts: WorkerPoolOptions) {
    const size = Math.max(1, opts.size ?? Math.min(4, availableCpus()));
    const workerData = {
      keyBase64:     opts.keyBase64,
      mode:          opts.mode,
      prevKeyBase64: opts.prevKeyBase64 ?? '',
      prevMode:      opts.prevMode,
    };

    try {
      for (let i = 0; i < size; i++) {
        const worker  = new Worker(_workerFile, {
          workerData,
          execArgv: _workerExecArgv.length > 0 ? _workerExecArgv : undefined,
        });
        const pending = new Map<number, PendingEntry>();

        worker.on('message', (msg: { id: number; result?: string; error?: string }) => {
          const entry = pending.get(msg.id);
          if (!entry) return;
          pending.delete(msg.id);
          // Unref the worker once its queue is empty so idle workers don't
          // prevent the process from exiting (e.g. CLI scripts, benchmarks).
          if (pending.size === 0) worker.unref();
          if (msg.error !== undefined) {
            entry.reject(new Error(msg.error));
          } else {
            entry.resolve(msg.result!);
          }
        });

        worker.on('error', (err: Error) => {
          // On unhandled worker error, reject all in-flight requests for this worker.
          for (const [, entry] of pending) entry.reject(err);
          pending.clear();
          worker.unref();
        });

        // Workers start unreffed; they are re-reffed in _dispatch while a task
        // is in flight, then unreffed again once the pending queue drains.
        worker.unref();

        this.workers.push(worker);
        this.pending.push(pending);
      }
      this._available = true;
    } catch {
      // Worker creation failed (e.g., missing file, restricted runtime).
      // Callers check isAvailable before using the pool.
      this._destroy();
    }
  }

  get isAvailable(): boolean { return this._available; }

  /** Encrypt a JSON string in a worker thread. Returns the same encrypted envelope string as CacheEncryption.encrypt(). */
  encrypt(payload: string): Promise<string> {
    return this._dispatch('encrypt', payload);
  }

  /** Decrypt an encrypted envelope string in a worker thread. Returns the original JSON string. */
  decrypt(payload: string): Promise<string> {
    return this._dispatch('decrypt', payload);
  }

  private _dispatch(type: 'encrypt' | 'decrypt', payload: string): Promise<string> {
    const id      = this._nextId++;
    const idx     = this._robin;
    const worker  = this.workers[idx];
    const pending = this.pending[idx];
    this._robin   = (this._robin + 1) % this.workers.length;

    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // Re-ref the worker while this request is in flight so the event loop
      // stays alive even in short-lived scripts (benchmarks, CLI tools).
      worker.ref();
      worker.postMessage({ id, type, payload });
    });
  }

  /** Terminate all worker threads. In-flight promises are rejected. */
  async destroy(): Promise<void> {
    this._available = false;
    this._destroy();
  }

  private _destroy(): void {
    for (let i = 0; i < this.workers.length; i++) {
      for (const [, entry] of this.pending[i] ?? []) {
        entry.reject(new Error('WorkerPool destroyed'));
      }
      this.pending[i]?.clear();
      this.workers[i]?.terminate().catch(() => {});
    }
  }
}

function availableCpus(): number {
  try {
    // Node.js 18.14+ provides `availableParallelism`; fall back to os.cpus().
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os') as typeof import('os');
    return (os as unknown as { availableParallelism?: () => number }).availableParallelism?.() ?? os.cpus().length;
  } catch {
    return 2;
  }
}
