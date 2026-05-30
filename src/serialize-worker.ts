/**
 * serialize-worker — worker-thread entry point for off-main-thread encryption/decryption.
 *
 * Receives messages from WorkerPool:
 *   { id: number; type: 'encrypt'; payload: string }
 *   { id: number; type: 'decrypt'; payload: string }
 *
 * Posts back:
 *   { id: number; result: string }   — on success
 *   { id: number; error: string }    — on failure
 *
 * The encryption key and mode are received once via workerData at thread creation,
 * so no key material travels with every per-message IPC call.
 */

import { parentPort, workerData } from 'worker_threads';
import { CacheEncryption } from './encryption.ts';
import type { EncryptionMode } from './encryption.ts';
import type { ILogger } from './types.ts';

interface WorkerInit {
  keyBase64:     string;
  mode:          EncryptionMode;
  prevKeyBase64: string | undefined;
  prevMode:      EncryptionMode | undefined;
}

// Minimal no-op logger — worker thread does not log to avoid interleaved I/O.
const silentLogger: ILogger = {
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

const { keyBase64, mode, prevKeyBase64, prevMode } = workerData as WorkerInit;

const enc = new CacheEncryption(
  keyBase64  || undefined,
  silentLogger,
  mode,
  prevKeyBase64 || undefined,
  prevMode,
);

parentPort!.on('message', ({ id, type, payload }: { id: number; type: 'encrypt' | 'decrypt'; payload: string }) => {
  try {
    if (type === 'encrypt') {
      parentPort!.postMessage({ id, result: enc.encrypt(payload) });
    } else {
      parentPort!.postMessage({ id, result: enc.decrypt(payload) });
    }
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});
