import { describe, it, expect, beforeEach } from 'vitest';

import { Cache } from '../src/cache.js';
import type { RedisConfig } from '../src/types.js';
import { asWrapper, fakeClient, silentLogger } from './helpers/fake-redis.js';

const config = {
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
  defaultTTL: 3600,
  compressionThreshold: 1024,
} as unknown as RedisConfig;

describe('Cache', () => {
  let cache: Cache;
  let fake: ReturnType<typeof fakeClient>;

  beforeEach(() => {
    fake = fakeClient();
    cache = new Cache(asWrapper(fake), config, silentLogger);
  });

  it('stores and retrieves strings', async () => {
    expect(await cache.set('greeting', 'hello')).toBe(true);
    expect(await cache.get('greeting')).toBe('hello');
  });

  it('stores and retrieves objects', async () => {
    const value = { user: 'alice', roles: ['admin', 'editor'] };
    expect(await cache.set('profile:1', value)).toBe(true);
    expect(await cache.get('profile:1')).toEqual(value);
  });

  it('returns null for missing keys', async () => {
    expect(await cache.get('nope')).toBe(null);
  });

  it('supports namespaces', async () => {
    await cache.set('token', 'abc', { namespace: 'auth' });
    expect(await cache.get('token', 'auth')).toBe('abc');
    expect(await cache.get('token')).toBe(null);
  });

  it('applies default ttl and per-call ttl overrides', async () => {
    await cache.set('a', '1');
    await cache.set('b', '2', { ttl: 5 });

    expect(await cache.ttl('a')).toBeGreaterThan(0);
    expect(await cache.ttl('a')).toBeLessThanOrEqual(3600);
    expect(await cache.ttl('b')).toBe(5);
  });

  it('compresses values above the threshold and restores them', async () => {
    const smallConfig = { ...config, compressionThreshold: 10 } as unknown as RedisConfig;
    const smallCache = new Cache(asWrapper(fake), smallConfig, silentLogger);

    const longValue = { payload: 'x'.repeat(5000) };
    expect(await smallCache.set('big', longValue)).toBe(true);
    expect(await smallCache.get('big')).toEqual(longValue);

    const raw = await fake.get('big');
    expect(raw).toContain('_compressed');
  });

  it('setNX only sets once', async () => {
    expect(await cache.setNX('lock:key', 'value')).toBe(true);
    expect(await cache.setNX('lock:key', 'other')).toBe(false);
    expect(await cache.get('lock:key')).toBe('value');
  });

  it('setEXNX only sets once', async () => {
    expect(await cache.setEXNX('flag', 'on', { ttl: 60 })).toBe(true);
    expect(await cache.setEXNX('flag', 'on', { ttl: 60 })).toBe(false);
  });

  it('delete, exists and expire', async () => {
    await cache.set('temp', 'x', { ttl: 100 });
    expect(await cache.exists('temp')).toBe(true);

    expect(await cache.expire('temp', 10)).toBe(true);
    expect(await cache.ttl('temp')).toBeLessThanOrEqual(10);

    expect(await cache.delete('temp')).toBe(true);
    expect(await cache.exists('temp')).toBe(false);
    expect(await cache.delete('temp')).toBe(false);
  });

  it('increments and decrements counters', async () => {
    expect(await cache.increment('visits')).toBe(1);
    expect(await cache.increment('visits')).toBe(2);
    expect(await cache.decrement('visits')).toBe(1);
    expect(await cache.get('visits')).toBe(1);
  });

  it('mget and mset', async () => {
    expect(await cache.mset({ x: '1', y: '2' }, { ttl: 60 })).toBe(true);
    const values = await cache.mget(['x', 'y', 'z']);
    expect(values).toEqual([1, 2, null]);
  });

  it('hash helpers', async () => {
    expect(await cache.hset('user:1', 'name', 'alice')).toBe(true);
    expect(await cache.hset('user:1', 'age', 30)).toBe(true);

    expect(await cache.hget('user:1', 'name')).toBe('alice');
    expect(await cache.hget('user:1', 'age')).toBe(30);
    expect(await cache.hget('user:1', 'missing')).toBe(null);

    const all = await cache.hgetall('user:1');
    expect(all).toEqual({ name: 'alice', age: 30 });
  });

  it('clears an entire namespace', async () => {
    await cache.set('k1', 'v', { namespace: 'sessions' });
    await cache.set('k2', 'v', { namespace: 'sessions' });
    await cache.set('k3', 'v', { namespace: 'other' });

    const cleared = await cache.clearNamespace('sessions');
    expect(cleared).toBe(2);

    expect(await cache.get('k1', 'sessions')).toBe(null);
    expect(await cache.get('k2', 'sessions')).toBe(null);
    expect(await cache.get('k3', 'other')).toBe('v');
  });
});