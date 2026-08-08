import { RedisClientWrapper } from './client.js';
import { Logger } from 'api-loggers';
import { RedisConfig, CacheOptions } from './types.js';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);


export class Cache {
  private client: RedisClientWrapper;
  private logger: Logger;
  // private config: RedisConfig;
  private defaultTTL: number;
  private compressionThreshold: number;

  constructor(client: RedisClientWrapper, config: RedisConfig, logger: Logger) {
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

  async mget<T = any>(keys: string[], namespace?: string): Promise<(T | null)[]> {
    const fullKeys = keys.map(k => this.getKey(k, namespace));
    const raw = await this.client.mget(...fullKeys);

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

  async mset<T>(
    entries: Record<string, T>,
    options: CacheOptions = {}
  ): Promise<boolean> {
    const ttl = options.ttl || this.defaultTTL;
    const namespace = options.namespace;

    try {
      const pipeline = this.client.pipeline();

      for (const [key, value] of Object.entries(entries)) {
        const fullKey = this.getKey(key, namespace);
        const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
        pipeline.set(fullKey, rawValue, 'EX', ttl);
      }

      const results = await pipeline.exec();
      return !!results?.every((result: any) => result[1] === 'OK');
    } catch (error) {
      this.logger.error('Cache mset failed:', error as Record<string, any>);
      return false;
    }
  }

  async delete(key: string, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.del(fullKey);
    return result > 0;
  }

  async exists(key: string, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.exists(fullKey);
    return result === 1;
  }

  async expire(key: string, ttl: number, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const result = await this.client.expire(fullKey, ttl);
    return result === 1;
  }

  async ttl(key: string, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.ttl(fullKey);
  }

  async increment(key: string, by: number = 1, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.incr(fullKey);
  }

  async decrement(key: string, by: number = 1, namespace?: string): Promise<number> {
    const fullKey = this.getKey(key, namespace);
    return this.client.decr(fullKey);
  }

  // Hash helpers
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

  async hset(key: string, field: string, value: any, namespace?: string): Promise<boolean> {
    const fullKey = this.getKey(key, namespace);
    const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.client.hset(fullKey, field, rawValue);
    return result === 1;
  }

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
  async keys(pattern: string, namespace?: string): Promise<string[]> {
    const fullPattern = namespace ? `${namespace}:${pattern}` : pattern;
    const keys: string[] = [];

    for await (const key of this.client.scanIterator(fullPattern)) {
      keys.push(key);
    }

    return keys;
  }

  // Clear entire namespace
  async clearNamespace(namespace: string): Promise<number> {
    return this.deletePattern('*', namespace);
  }
}
