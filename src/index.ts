/**
 * tricache — three-tier cache for Node.js
 *
 * L1 (RAM) → L1.5 (disk) → L2 (Redis/Valkey) → your fetch function
 *
 * Quick start:
 *   import { CacheService, CachePriority } from 'tricache';
 *
 *   const cache = CacheService.create({ redisHost: 'localhost' });
 *
 *   const user = await cache.get(
 *     `user:${userId}`,
 *     () => db.users.findById(userId),
 *     300,                          // 5-minute TTL
 *   );
 *
 *   await cache.delete(`user:${userId}`);
 */

export { CacheService }        from './cache-service';
export { CacheEncryption, type EncryptionMode } from './encryption';
export { SmartMemoryCache }    from './smart-memory-cache';
export { DiskTier }            from './disk-tier';
export { WasmBloomFilter }     from './wasm/bloom-filter-wasm';

export {
  CachePriority,
  consoleLogger,
  type ILogger,
  type CacheOptions,
  type CacheMetrics,
  type CategoryLimit,
  type SmartCacheEntry,
  type DiskCacheEntry,
  type CacheHit,
  type EvictionReason,
  type CachePingResult,
} from './types';
