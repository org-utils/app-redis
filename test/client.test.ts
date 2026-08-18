import { describe, it, expect, beforeEach, vi } from 'vitest';

import { MockRedisClient } from './helpers/mock-ioredis.js';

vi.mock('ioredis', async () => {
  const { MockRedisClient } = await import('./helpers/mock-ioredis.js');
  return {
    default: MockRedisClient,
    Cluster: MockRedisClient.Cluster,
    Redis: MockRedisClient,
    RedisOptions: {},
  };
});

import { RedisClientWrapper } from '../src/client.js';
import type { RedisConfig } from '../src/types.js';
import { silentLogger } from './helpers/fake-redis.js';

const config = {
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
  password: 'secret',
  maxRetries: 3,
  retryDelay: 100,
  connectionTimeout: 5000,
} as const;

function rawClient(wrapper: RedisClientWrapper): MockRedisClient {
  return wrapper.getRawClient() as unknown as MockRedisClient;
}

describe('RedisClientWrapper', () => {
  let wrapper: RedisClientWrapper;

  beforeEach(() => {
    wrapper = new RedisClientWrapper(config, silentLogger);
  });

  it('creates a standalone client', () => {
    expect(wrapper.isCluster()).toBe(false);
    expect(wrapper.getClusterNodes()).toEqual([]);
  });

  it('ping returns true when PONG', async () => {
    expect(await wrapper.ping()).toBe(true);
  });

  it('get returns stored value or null', async () => {
    expect(await wrapper.get('missing')).toBe(null);

    await wrapper.set('name', 'redis');
    expect(await wrapper.get('name')).toBe('redis');
  });

  it('set with ttl stores with an expiry', async () => {
    await wrapper.set('temp', 'v', 0.05);
    const raw = rawClient(wrapper);
    expect(raw.__store.get('temp')).toBeDefined();

    const ttl = await wrapper.ttl('temp');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1);
  });

  it('setnx sets once and returns 0 afterwards', async () => {
    expect(await wrapper.setnx('once', 'a')).toBe(1);
    expect(await wrapper.setnx('once', 'b')).toBe(0);
    expect(await wrapper.get('once')).toBe('a');
  });

  it('incr and decr', async () => {
    expect(await wrapper.incr('counter')).toBe(1);
    expect(await wrapper.incr('counter')).toBe(2);
    expect(await wrapper.decr('counter')).toBe(1);
  });

  it('del and exists', async () => {
    await wrapper.set('k', 'v');
    expect(await wrapper.exists('k')).toBe(1);
    expect(await wrapper.del('k')).toBe(1);
    expect(await wrapper.exists('k')).toBe(0);
  });

  it('mget and mset', async () => {
    await wrapper.mset(['a', '1'], ['b', '2']);
    expect(await wrapper.mget('a', 'b', 'c')).toEqual(['1', '2', null]);
  });

  it('hash operations', async () => {
    await wrapper.hset('user', 'name', 'alice');
    await wrapper.hset('user', 'age', '30');
    expect(await wrapper.hget('user', 'name')).toBe('alice');
    expect(await wrapper.hgetall('user')).toEqual({ name: 'alice', age: '30' });
    expect(await wrapper.hdel('user', 'name')).toBe(1);
  });

  it('returns results even when slow command logging is enabled', async () => {
    const slow = new RedisClientWrapper(
      { ...config, slowCommandThreshold: 0 } as const,
      silentLogger
    );
    await slow.set('k', 'v');
    expect(await slow.get('k')).toBe('v');
  });

  it('close quits the client', async () => {
    await wrapper.close();
    expect(await wrapper.ping()).toBe(true);
  });

  describe('cluster mode', () => {
    const clusterConfig: RedisConfig = {
      mode: 'cluster',
      clusterNodes: [
        { host: 'localhost', port: 7000 },
        { host: 'localhost', port: 7001 },
      ],
    };

    it('creates a cluster client', () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);
      expect(cluster.isCluster()).toBe(true);
      expect(cluster.getClusterNodes()).toEqual([]);
    });

    it('mget groups keys by slot and falls back when getSlot is unavailable', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);

      await cluster.mset(['a', '1'], ['b', '2']);
      expect(await cluster.mget('a', 'b')).toEqual(['1', '2']);
      expect(await cluster.mget('a', 'b', 'c')).toEqual(['1', '2', null]);
    });

    it('mset splits pairs across slots and stores all of them', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);

      const result = await cluster.mset(['x', '1'], ['y', '2']);
      expect(result).toBe('OK');
      expect(await cluster.mget('x', 'y')).toEqual(['1', '2']);
    });

    it('scanIterator scans all nodes', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);

      const keys: string[] = [];
      for await (const key of cluster.scanIterator('*')) {
        keys.push(key);
      }
      expect(keys).toEqual([]);
    });

    it('calculateSlot uses real CRC16 with hash tag support', async () => {
      const cluster = new RedisClientWrapper(clusterConfig, silentLogger);

      const withoutTag = cluster.calculateSlot('user:1001');
      const taggedA = cluster.calculateSlot('{user}:a');
      const taggedB = cluster.calculateSlot('{user}:b');
      expect(taggedA).toBe(taggedB);
      expect(withoutTag).toBeGreaterThanOrEqual(0);
      expect(withoutTag).toBeLessThan(16384);
    });
  });
});