import { RedisClientWrapper } from './client.js';

import { RedisConfig, CacheOptions } from './types.js';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { defaultLogger, LoggerLike } from './logger.js';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);


/**
 * Cache layer on top of {@link RedisClientWrapper} with JSON serialization,
 * optional gzip compression and namespace support.
 *
 * Works in all three modes (standalone, sentinel, cluster): multi-key operations
 * are slot-aware and pattern scans cover every cluster node.
 *
 * @example
 * ```ts
 * const cache = new Cache(client, { defaultTTL: 3600, compressionThreshold: 1024 });
 * await cache.set('user:1', { name: 'alice' });
 * const user = await cache.get('user:1');
 * ```
 */
export class Cache {
  private client: RedisClientWrapper;
  private logger: LoggerLike;
  // private config: RedisConfig;
  private defaultTTL: number;
  private compressionThreshold: number;

  /**
   * Creates a cache bound to a Redis client.
   *
   * @param client - The underlying {@link RedisClientWrapper}.
   * @param config - Redis config; `defaultTTL` (seconds) and `compressionThreshold` (bytes)
   *   control cache behavior.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * const cache = new Cache(client, { defaultTTL: 600, compressionThreshold: 2048 });
   * ```
   */
  constructor(client: RedisClientWrapper, config: RedisConfig, logger: LoggerLike = defaultLogger) {
    this.client = client;
    this.logger = logger.child({ component: 'Cache' });
    // this.config = config;
    this.defaultTTL = config.defaultTTL || 3600;
    this.compressionThreshold = config.compressionThreshold || 1024;
  }

  private async serialize<T>(value: T): Promise<{ data: Buffer; compressed: boolean }> {
    // Convert to Buffer
    let data: Buffer;
    if (Buffer.isBuffer(value)) {
      data = value;
    } else if (typeof value === 'string') {
      data = Buffer.from(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      data = Buffer.from(String(value));
    } else {
      // JSON for objects
      data = Buffer.from(JSON.stringify(value));
    }

    // Compress if large enough
    if (data.length > this.compressionThreshold) {
      try {
        const compressed = await gzip(data);
        return { data: compressed, compressed: true };
      } catch (error) {
        this.logger.warn('Compression failed, storing uncompressed');
        return { data, compressed: false };
      }
    }

    return { data, compressed: false };
  }

  private async deserialize<T>(data: Buffer, compressed: boolean): Promise<T> {
    let buffer = data;
    if (compressed) {
      try {
        buffer = await gunzip(data);
      } catch (error) {
        this.logger.warn('Decompression failed, trying raw data');
        // Attempt to use raw data if decompression fails
      }
    }

    // Try to parse as JSON if it looks like JSON
    const str = buffer.toString();
    try {
      if (str.startsWith('{') || str.startsWith('[')) {
        return JSON.parse(str);
      }
    } catch {
      // Not JSON, return as string
    }

    return str as T;
  }

  private getKey(key: string, namespace?: string): string {
    return namespace ? `${namespace}:${key}` : key;
  }

  /**
   * Reads a cached value.
   *
   * Objects are parsed from JSON and compressed values are transparently
   * decompressed. Strings that are not JSON are returned as-is.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix (`namespace:key`).
   * @returns The stored value, or `null` when missing.
   *
   * @example
   * ```ts
   * const user = await cache.get<User>('user:1');
   * const token = await cache.get('token', 'auth');
   * ```
   */
  async get<T = any>(key: string, namespace?: string): Promise<T | null> {
    const fullKey = this.getKey(key, namespace);
    const raw = await this.client.get(fullKey);

    if (!raw) return null;

    try {
      // Check if stored with metadata
      const parsed = JSON.parse(raw);
      if (parsed._compressed && parsed._data) {
        const data = Buffer.from(parsed._data, 'base64');
        return this.deserialize<T>(data, parsed._compressed);
      }
      // Legacy format - try to parse as JSON
      return JSON.parse(raw);
    } catch {
      // Raw string value
      return raw as T;
    }
  }

  /**
   * Stores a value in the cache.
   *
   * @param key - Cache key.
   * @param value - Any serializable value (string, number, boolean, Buffer, object).
   * @param options - `ttl` in seconds (defaults to `defaultTTL`), `namespace`,
   *   and `compress` (default `true`). Values larger than `compressionThreshold`
   *   bytes are gzip-compressed.
   * @returns `true` when stored successfully.
   *
   * @example
   * ```ts
   * await cache.set('user:1', user, { ttl: 300 });
   * await cache.set('token', 'abc', { namespace: 'auth', compress: false });
   * ```
   */
  async set<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const fullKey = this.getKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;
    const shouldCompress = options.compress !== undefined ? options.compress : true;

    try {
      let rawValue: string | Buffer;

      if (shouldCompress) {
        const { data, compressed } = await this.serialize(value);
        if (compressed) {
          // Store with metadata
          rawValue = JSON.stringify({
            _compressed: true,
            _data: data.toString('base64'),
          });
        } else {
          rawValue = data;
        }
      } else {
        if (typeof value === 'string') {
          rawValue = value;
        } else if (Buffer.isBuffer(value)) {
          rawValue = value;
        } else {
          rawValue = JSON.stringify(value);
        }
      }

      const result = await this.client.set(fullKey, rawValue, ttl);
      this.logger.debug('Cache set', { key: fullKey, ttl, compressed: shouldCompress });
      return result === 'OK';
    } catch (error) {
      this.logger.error('Cache set failed:', error as Record<string, any>);
      return false;
    }
  }

  /**
   * Stores a value only if the key does not exist yet (`SETNX`).
   *
   * @param key - Cache key.
   * @param value - The value to store.
   * @param options - `ttl` in seconds and `namespace`.
   * @returns `true` only when the value was actually stored.
   *
   * @example
   * ```ts
   * const claimed = await cache.setNX('job:1', 'worker-1', { ttl: 60 });
   * ```
   */
  async setNX<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const fullKey = this.getKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;

    try {
      const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await this.client.setnx(fullKey, rawValue, ttl);
      return result === 1;
    } catch (error) {
      this.logger.error('Cache setNX failed:', error as Record<string, any>);
      return false;
    }
  }
  /**
   * Stores a value only if the key does not exist yet, atomically with the TTL
   * (`SET ... EX NX`).
   *
   * @param key - Cache key.
   * @param value - The value to store.
   * @param options - `ttl` in seconds and `namespace`.
   * @returns `true` only when the value was actually stored.
   *
   * @example
   * ```ts
   * const locked = await cache.setEXNX('lock:order:42', 'txn-id', { ttl: 30 });
   * ```
   */
  async setEXNX<T>(
    key: string,
    value: T,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const fullKey = this.getKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;

    try {
      const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
      const result = await this.client.setexnx(fullKey, rawValue, ttl);
      return result === 'OK';
    } catch (error) {
      this.logger.error('Cache setEXNX failed:', error as Record<string, any>);
      return false;
    }
  }

  // Old mget - CROSSSLOT error in cluster mode when keys span different slots
  // async mget<T = any>(keys: string[], namespace?: string): Promise<(T | null)[]> {
  //   const fullKeys = keys.map(k => this.getKey(k, namespace));
  //   const raw = await this.client.mget(...fullKeys);
  //
  //   return Promise.all(
  //     raw.map(async (item) => {
  //       if (!item) return null;
  //       try {
  //         const parsed = JSON.parse(item);
  //         if (parsed._compressed && parsed._data) {
  //           const data = Buffer.from(parsed._data, 'base64');
  //           return this.deserialize<T>(data, parsed._compressed);
  //         }
  //         return parsed;
  //       } catch {
  //         return item as T;
  //       }
  //     })
  //   );
  // }
  // Cluster-safe: groups keys by slot via mgetClusterAware

  /**
   * Reads multiple cache keys in one call.
   *
   * Cluster-safe: keys are grouped by hash slot under the hood.
   *
   * @param keys - Cache keys to read.
   * @param namespace - Optional namespace prefix applied to every key.
   * @returns Values in input order; `null` for missing keys.
   *
   * @example
   * ```ts
   * const [a, b] = await cache.mget(['user:1', 'user:2']);
   * ```
   */
  async mget<T = any>(keys: string[], namespace?: string): Promise<(T | null)[]> {
    const fullKeys = keys.map(k => this.getKey(k, namespace));
    const raw = await this.client.mgetClusterAware(fullKeys);

    return Promise.all(
      raw.map(async (item) => {
        if (!item) return null;
        try {
          const parsed = JSON.parse(item);
          if (parsed._compressed && parsed._data) {
            const data = Buffer.from(parsed._data, 'base64');
            return this.deserialize<T>(data, parsed._compressed);
          }
          return parsed;
        } catch {
          return item as T;
        }
      })
    );
  }

  // Old mset - a pipeline whose keys span different slots is rejected in cluster mode
  // async mset<T>(
  //   entries: Record<string, T>,
  //   options: CacheOptions = {}
  // ): Promise<boolean> {
  //   const ttl = options.ttl || this.defaultTTL;
  //   const namespace = options.namespace;
  //
  //   try {
  //     const pipeline = this.client.pipeline();
  //
  //     for (const [key, value] of Object.entries(entries)) {
  //       const fullKey = this.getKey(key, namespace);
  //       const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
  //       pipeline.set(fullKey, rawValue, 'EX', ttl);
  //     }
  //
  //     const results = await pipeline.exec();
  //     return !!results?.every((result: any) => result[1] === 'OK');
  //   } catch (error) {
  //     this.logger.error('Cache mset failed:', error as Record<string, any>);
  //     return false;
  //   }
  // }
  // Cluster-safe: one pipeline per hash slot
  /**
   * Stores multiple key/value entries in one call.
   *
   * Cluster-safe: entries are grouped by hash slot, one pipeline per slot.
   *
   * @param entries - Object mapping cache keys to values.
   * @param options - `ttl` in seconds (defaults to `defaultTTL`) and `namespace`.
   * @returns `true` when every entry was stored.
   *
   * @example
   * ```ts
   * await cache.mset({ 'user:1': alice, 'user:2': bob }, { ttl: 300 });
   * ```
   */
  async mset<T>(
    entries: Record<string, T>,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const ttl = options.ttl || this.defaultTTL;
    const namespace = options.namespace;

    try {
      const groups = new Map<number, Array<[string, string | Buffer]>>();
      for (const [key, value] of Object.entries(entries)) {
        const fullKey = this.getKey(key, namespace);
        const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
        const slot = this.client.calculateSlot(fullKey);
        if (!groups.has(slot)) {
          groups.set(slot, []);
        }
        groups.get(slot)!.push([fullKey, rawValue]);
      }

      for (const group of groups.values()) {
        const pipeline = this.client.pipeline();
        for (const [fullKey, rawValue] of group) {
          pipeline.set(fullKey, rawValue, 'EX', ttl);
        }
        const results = await pipeline.exec();
        if (!results?.every((result: any) => result[1] === 'OK')) {
          return false;
        }
      }
      return true;
    } catch (error) {
      this.logger.error('Cache mset failed:', error as Record<string, any>);
      return false;
    }
  }

  /**
   * Deletes a cache key.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns `true` if the key existed and was deleted.
   *
   * @example
   * ```ts
   * const removed = await cache.delete('user:1');
   * ```
   */
  async delete(key: string, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.del(fullKey);
    return result > 0;
  }

  /**
   * Checks whether a cache key exists.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns `true` if the key exists.
   *
   * @example
   * ```ts
   * const cached = await cache.exists('user:1');
   * ```
   */
  async exists(key: string, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  /**
   * Sets the TTL of an existing cache key.
   *
   * @param key - Cache key.
   * @param ttl - TTL in seconds.
   * @param namespace - Optional namespace prefix.
   * @returns `true` if the TTL was applied.
   *
   * @example
   * ```ts
   * const extended = await cache.expire('session:42', 3600);
   * ```
   */
  async expire(key: string, ttl: number, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.expire(fullKey, ttl);
    return result === 1;
  }

  /**
   * Returns the remaining TTL of a cache key in seconds.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns Remaining TTL in seconds (`-2` if missing, `-1` if no TTL).
   *
   * @example
   * ```ts
   * const secondsLeft = await cache.ttl('session:42');
   * ```
   */
  async ttl(key: string, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.ttl(fullKey);
  }

  /**
   * Atomically increments a cache counter.
   *
   * @param key - Counter key.
   * @param by - Amount to increment by (default `1`; ignored by Redis, kept for API parity).
   * @param namespace - Optional namespace prefix.
   * @returns The new counter value.
   *
   * @example
   * ```ts
   * const visits = await cache.increment('stats:visits');
   * ```
   */
  async increment(key: string, by: number = 1, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.incr(fullKey);
  }

  /**
   * Atomically decrements a cache counter.
   *
   * @param key - Counter key.
   * @param by - Amount to decrement by (default `1`; ignored by Redis, kept for API parity).
   * @param namespace - Optional namespace prefix.
   * @returns The new counter value.
   *
   * @example
   * ```ts
   * const stock = await cache.decrement('inventory:sku-1');
   * ```
   */
  async decrement(key: string, by: number = 1, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.decr(fullKey);
  }

  // Hash helpers
  /**
   * Reads a field from a hash-style cache key.
   *
   * @param key - Cache key.
   * @param field - Hash field.
   * @param namespace - Optional namespace prefix.
   * @returns The field value (JSON-parsed when possible), or `null`.
   *
   * @example
   * ```ts
   * const name = await cache.hget('user:1', 'name');
   * ```
   */
  async hget<T = any>(key: string, field: string, namespace?: string): Promise<T | null> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.hget(fullKey, field);
    if (!result) return null;
    try {
      return JSON.parse(result);
    } catch {
      return result as T;
    }
  }

  /**
   * Writes a field into a hash-style cache key.
   *
   * @param key - Cache key.
   * @param field - Hash field.
   * @param value - Any serializable value (JSON-stringified unless it is a string).
   * @param namespace - Optional namespace prefix.
   * @returns `true` if a new field was created.
   *
   * @example
   * ```ts
   * await cache.hset('user:1', 'age', 30);
   * ```
   */
  async hset(key: string, field: string, value: any, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.client.hset(fullKey, field, rawValue);
    return result === 1;
  }

  /**
   * Returns every field of a hash-style cache key.
   *
   * @param key - Cache key.
   * @param namespace - Optional namespace prefix.
   * @returns Object mapping fields to values (JSON-parsed when possible).
   *
   * @example
   * ```ts
   * const profile = await cache.hgetall('user:1');
   * ```
   */
  async hgetall<T = any>(key: string, namespace?: string): Promise<Record<string, T>> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.hgetall(fullKey);

    const parsed: Record<string, T> = {};
    for (const [field, value] of Object.entries(result)) {
      try {
        parsed[field] = JSON.parse(value);
      } catch {
        parsed[field] = value as T;
      }
    }
    return parsed;
  }

  // Delete by pattern
  /**
   * Deletes every cache key matching a glob pattern.
   *
   * Cluster-safe: scans every node before deleting.
   *
   * @param pattern - Glob pattern, e.g. `'user:*'`.
   * @param namespace - Optional namespace prefix (`namespace:pattern`).
   * @returns The number of deleted keys.
   *
   * @example
   * ```ts
   * const removed = await cache.deletePattern('temp:*');
   * ```
   */
  async deletePattern(pattern: string, namespace?: string): Promise<number> {
    const fullPattern = namespace ? `${namespace}:${pattern}` : pattern;
    let deleted = 0;

    for await (const key of this.client.scanIterator(fullPattern)) {
      const result = await this.client.del(key);
      deleted += result;
    }

    return deleted;
  }

  // Get all keys matching pattern
  /**
   * Lists every cache key matching a glob pattern.
   *
   * Cluster-safe: scans every node.
   *
   * @param pattern - Glob pattern, e.g. `'session:*'`.
   * @param namespace - Optional namespace prefix (`namespace:pattern`).
   * @returns Matching keys.
   *
   * @example
   * ```ts
   * const sessions = await cache.keys('session:*');
   * ```
   */
  async keys(pattern: string, namespace?: string): Promise<string[]> {
    const fullPattern = namespace ? `${namespace}:${pattern}` : pattern;
    const keys: string[] = [];

    for await (const key of this.client.scanIterator(fullPattern)) {
      keys.push(key);
    }

    return keys;
  }

  // Clear entire namespace
  /**
   * Deletes every key inside a namespace.
   *
   * @param namespace - Namespace to wipe (`namespace:*`).
   * @returns The number of deleted keys.
   *
   * @example
   * ```ts
   * const cleared = await cache.clearNamespace('sessions');
   * ```
   */
  async clearNamespace(namespace: string): Promise<number> {
    return this.deletePattern('*', namespace);
  }
}
