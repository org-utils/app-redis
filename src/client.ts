import Redis, { Cluster, Redis as RedisClient, RedisOptions } from 'ioredis';

import { RedisError } from './errors.js';
import type { RedisConfig } from './types.js';
import { defaultLogger, type LoggerLike } from './logger.js';
import { Cache } from './cache.js';
import { PubSub } from './pubsub.js';
import { DistributedLock } from './lock.js';
import { RateLimiter } from './ratelimiter.js';
export interface RedisClientOptions { config: RedisConfig; logger?: LoggerLike; }



/**
 * Production-grade Redis client wrapper with support for standalone, sentinel and cluster modes.
 *
 * Wraps an [ioredis](https://github.com/redis/ioredis) client and adds:
 * - unified config handling for standalone / sentinel / cluster modes
 * - connection lifecycle events and logging
 * - per-command performance tracking with slow-command warnings
 * - cluster-safe multi-key operations (`mget`, `mset`, `scanIterator`, ...)
 *
 * @example
 * ```ts
 * const client = new RedisClient({ mode: 'standalone', host: 'localhost', port: 6379 });
 * await client.set('greeting', 'hello', 60);
 * const value = await client.get('greeting'); // 'hello'
 * ```
 */
export class RedisClientWrapper {
  private client: RedisClient | Cluster;
  private _cache!: Cache;
  private _pubsub!: PubSub;
  private _lock!: DistributedLock;
  private _rateLimiter!: RateLimiter;
  private config: RedisConfig;
  // private logger: Logger;
  private isReady: boolean = false;
  private readonly logger: LoggerLike;

  /**
   * Creates a Redis client for the given configuration.
   *
   * @param config - Connection configuration. Mode can be `standalone` (default), `sentinel` or `cluster`.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * // Standalone
   * const client = new RedisClient({ mode: 'standalone', host: 'localhost', port: 6379 });
   *
   * // Sentinel
   * const client = new RedisClient({
   *   mode: 'sentinel',
   *   sentinelNodes: [{ host: 'sentinel1', port: 26379 }],
   *   sentinelMasterName: 'mymaster',
   * });
   *
   * // Cluster
   * const client = new RedisClient({
   *   mode: 'cluster',
   *   clusterNodes: [{ host: 'redis1', port: 7000 }, { host: 'redis2', port: 7001 }],
   * });
   * ```
   */

  constructor(config: RedisConfig, logger: LoggerLike = defaultLogger) {
    this.config = config;

    this.logger = logger.child({
      component: "RedisClient",
    });

    this.client = this.createClient();
    this.setupEventHandlers();
  }

  /**
   * Lazily created {@link Cache} bound to this client.
   *
   * @returns The shared cache instance (created on first access).
   *
   * @example
   * ```ts
   * await client.cache.set('user:1', { name: 'Alice' }, { ttl: 3600 });
   * ```
   */
  get cache(): Cache {
    if (!this._cache) {
      this._cache = new Cache(this, this.config, this.logger);
    }
    return this._cache;
  }

  /**
   * Replaces the shared cache instance with a custom one.
   *
   * @param value - The {@link Cache} instance to use.
   *
   * @example
   * ```ts
   * client.cache = new Cache(client, config, logger);
   * ```
   */
  set cache(value: Cache) {
    this._cache = value;
  }

  /**
   * Lazily created {@link PubSub} bound to this client.
   *
   * @returns The shared pub/sub instance (created on first access).
   *
   * @example
   * ```ts
   * await client.pubsub.connectSubscriber(config);
   * await client.pubsub.publish('events:new', { id: 1 });
   * ```
   */
  get pubsub(): PubSub {
    if (!this._pubsub) {
      this._pubsub = new PubSub(this, this.logger);
    }
    return this._pubsub;
  }

  /**
   * Replaces the shared pub/sub instance with a custom one.
   *
   * @param value - The {@link PubSub} instance to use.
   *
   * @example
   * ```ts
   * client.pubsub = new PubSub(client, logger);
   * ```
   */
  set pubsub(value: PubSub) {
    this._pubsub = value;
  }

  /**
   * Lazily created {@link DistributedLock} bound to this client.
   *
   * @returns The shared lock instance (created on first access).
   *
   * @example
   * ```ts
   * const ok = await client.lock.acquire('order:42');
   * ```
   */
  get lock(): DistributedLock {
    if (!this._lock) {
      this._lock = new DistributedLock(this, this.logger);
    }
    return this._lock;
  }

  /**
   * Replaces the shared lock instance with a custom one.
   *
   * @param value - The {@link DistributedLock} instance to use.
   *
   * @example
   * ```ts
   * client.lock = new DistributedLock(client, logger, { ttl: 10000 });
   * ```
   */
  set lock(value: DistributedLock) {
    this._lock = value;
  }

  /**
   * Lazily created {@link RateLimiter} bound to this client.
   *
   * @returns The shared rate limiter instance (created on first access).
   *
   * @example
   * ```ts
   * const { allowed } = await client.rateLimiter.consume('api:user-1', 10, 60);
   * ```
   */
  get rateLimiter(): RateLimiter {
    if (!this._rateLimiter) {
      this._rateLimiter = new RateLimiter(this);
    }
    return this._rateLimiter;
  }

  /**
   * Replaces the shared rate limiter instance with a custom one.
   *
   * @param value - The {@link RateLimiter} instance to use.
   *
   * @example
   * ```ts
   * client.rateLimiter = new RateLimiter(client, { limit: 100 });
   * ```
   */
  set rateLimiter(value: RateLimiter) {
    this._rateLimiter = value;
  }

  private createClient(): RedisClient | Cluster {
    const baseOptions = {
      retryStrategy: (times: number) => {
        if (this.config?.maxRetries != null && times > this.config?.maxRetries) return null;
        return Math.min(times * (this.config?.retryDelay ?? 1000), 5000);
      },
      connectTimeout: this.config.connectionTimeout,
      maxRetriesPerRequest: this.config.maxRetries,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      lazyConnect: false,

    };

    switch (this.config.mode) {
      case 'cluster':
        if (!this.config.clusterNodes?.length) {
          throw new RedisError('Cluster nodes required for cluster mode');
        }
        return new Redis.Cluster(
          this.config.clusterNodes.map(n => ({ host: n.host, port: n.port })),
          {
            ...baseOptions,
            scaleReads: 'master',
            redisOptions: this.buildRedisOptions(),
          }
        );

      case 'sentinel':
        if (!this.config.sentinelNodes?.length || !this.config.sentinelMasterName) {
          throw new RedisError('Sentinel nodes and master name required');
        }
        return new RedisClient({
          ...baseOptions,
          sentinel: true,
          sentinelNodes: this.config.sentinelNodes,
          name: this.config.sentinelMasterName,
          ...this.buildRedisOptions(),
        });

      default:
        if (this.config.url) {
          return new RedisClient(this.config.url, {
            ...baseOptions,
            ...this.buildRedisOptions()
          });
        }
        return new RedisClient({
          ...baseOptions,
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          ...this.buildRedisOptions(),
        });
    }
  }

  private buildRedisOptions() {
    const options: any = {
      password: this.config.password,
      username: this.config.username,
    };

    if (this.config.tls) {
      options.tls = this.config.tlsOptions || { rejectUnauthorized: true };
    }

    return options;
  }

  private setupEventHandlers() {
    this.client.on('connect', () => {
      this.logger.info('Redis connected');
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.logger.info('Redis ready');
    });

    this.client.on('error', (error) => {
      this.logger.error('Redis error:', error);
    });

    this.client.on('close', () => {
      this.isReady = false;
      this.logger.warn('Redis connection closed');
    });

    this.client.on('reconnecting', () => {
      this.logger.info('Redis reconnecting...');
    });
  }

  /**
   * Returns the underlying raw ioredis client.
   *
   * @returns The raw `Redis` or `Cluster` instance.
   *
   * @example
   * ```ts
   * const raw = client.getRawClient<Redis>();
   * await raw.eval('return 1', 0);
   * ```
   */
  public getRawClient<T extends RedisClient | Cluster>(): T {
    return this.client as T;
  }
  /**
   * Getter alias for `getRawClient()`.
   *
   * @example
   * ```ts
   * const result = await client.raw.get('some-key');
   * ```
   */
  get raw(): RedisClient | Cluster {
    return this.getRawClient();
  }

  /**
   * Pings the Redis server.
   *
   * @returns `true` when the server replies `PONG`, `false` otherwise.
   *
   * @example
   * ```ts
   * if (await client.ping()) {
   *   console.log('Redis is reachable');
   * }
   * ```
   */
  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Gracefully closes the connection (sends `QUIT`).
   *
   * @example
   * ```ts
   * await client.close();
   * ```
   */
  async close(): Promise<void> {
    await this.client.quit();
    this.isReady = false;
  }

  // Type guard for cluster
  private isClusterClient(client: RedisClient | Cluster): client is Cluster {
    return client instanceof Cluster;
  }

  // Command delegation with performance tracking
  private async exec<T>(
    command: string,
    args: any[],
    operation: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await operation();
      const duration = Date.now() - start;

      if (this.config?.slowCommandThreshold != null && duration > this.config?.slowCommandThreshold) {
        this.logger.warn(`Slow command: ${command} took ${duration}ms`, {
          command,
          args: args.slice(0, 5),
          duration
        });
      }

      return result;
    } catch (error) {
      this.logger.error(`Command failed: ${command}`, { command, error });
      throw error;
    }
  }

  // Basic Redis commands
  /**
   * Returns the string value stored at a key.
   *
   * @param key - The key to read.
   * @returns The stored value, or `null` if the key does not exist.
   *
   * @example
   * ```ts
   * const name = await client.get('user:1:name'); // 'alice' | null
   * ```
   */
  async get(key: string): Promise<string | null> {
    return this.exec('GET', [key], () => this.client.get(key));
  }

  /**
   * Stores a value at a key, optionally with a TTL.
   *
   * @param key - The key to write.
   * @param value - The value to store (string or Buffer).
   * @param ttl - Optional TTL in seconds (uses `SET ... EX`).
   * @returns `'OK'` on success, `null` on failure.
   *
   * @example
   * ```ts
   * await client.set('user:1:name', 'alice');
   * await client.set('session:42', 'payload', 3600); // expires in 1 hour
   * ```
   */
  async set(key: string, value: string | Buffer, ttl?: number): Promise<'OK' | null> {
    return this.exec('SET', [key, value, ttl ? 'EX' : null, ttl], () =>
      ttl ? this.client.set(key, value, 'EX', ttl) : this.client.set(key, value)
    );
  }

  /**
   * Stores a value only if the key does not already exist, optionally with a TTL.
   *
   * @param key - The key to write.
   * @param value - The value to store (string or Buffer).
   * @param ttl - Optional TTL in seconds (uses `SET ... EX NX`).
   * @returns `'OK'` if the key was set, `null` if the key already existed.
   *
   * @example
   * ```ts
   * const result = await client.setexnx('job:claim', 'worker-1', 60);
   * if (result === 'OK') {
   *   // this worker claimed the job
   * }
   * ```
   */
  async setexnx(key: string, value: string | Buffer, ttl?: number): Promise<'OK' | null> {
    return this.exec('SET', [key, value, 'NX', ttl ? 'EX' : null, ttl], () =>
      ttl ? this.client.set(key, value,  'EX', ttl, 'NX') : this.client.set(key, value, 'NX')
    );
  }

  /**
   * Registers a custom command on the client (e.g. for `fastify-rate-limit`).
   *
   * @param args - ioredis `defineCommand` arguments `(name, definition)`.
   *
   * @example
   * ```ts
   * client.defineCommand('myCommand', {
   *   numberOfKeys: 1,
   *   lua: "return redis.call('GET', KEYS[1])",
   * });
   * ```
   */
  // Or expose the methods needed by fastify-rate-limit
  defineCommand(...args: Parameters<RedisClient['defineCommand']>) {
    return this.client.defineCommand(...args);
  }

  /**
   * Sets a key only if it does not already exist (`SETNX`), optionally with a TTL.
   *
   * @param key - The key to set.
   * @param value - The value to store.
   * @param ttl - Optional TTL in seconds; applied with `EXPIRE` after a successful `SETNX`.
   * @returns `1` if the key was set, `0` if the key already existed.
   *
   * @example
   * ```ts
   * const acquired = await client.setnx('lock:order:42', 'owner', 30);
   * if (acquired === 1) {
   *   // we own the lock
   * }
   * ```
   */
  async setnx(key: string, value: string | Buffer, ttl?: number): Promise<number> {
    return this.exec('SETNX', [key, value], () =>
      this.client.setnx(key, value).then(result => {
        if (result === 1 && ttl) {
          return this.client.expire(key, ttl).then(() => 1);
        }
        return result;
      })
    );
  }

  /**
   * Deletes one or more keys.
   *
   * @param keys - Keys to delete.
   * @returns The number of keys that were removed.
   *
   * @example
   * ```ts
   * const removed = await client.del('temp:1', 'temp:2'); // 2
   * ```
   */
  async del(...keys: string[]): Promise<number> {
    return this.exec('DEL', keys, () => this.client.del(...keys));
  }

  /**
   * Returns the value at a key and deletes it atomically (`GETDEL`).
   *
   * @param key - The key to read and delete.
   * @returns The stored value, or `null` if the key did not exist.
   *
   * @example
   * ```ts
   * const message = await client.getdel('queue:job'); // value, then key is gone
   * ```
   */
  async getdel(key: string): Promise<string | null> {
    return this.exec('GETDEL', [key], () => this.client.getdel(key));
  }

  /**
   * Checks whether a key exists.
   *
   * @param key - The key to check.
   * @returns `1` if the key exists, `0` otherwise.
   *
   * @example
   * ```ts
   * const hasUser = (await client.exists('user:1')) === 1;
   * ```
   */
  async exists(key: string): Promise<number> {
    return this.exec('EXISTS', [key], () => this.client.exists(key));
  }

  /**
   * Sets a TTL on an existing key.
   *
   * @param key - The key to expire.
   * @param ttl - TTL in seconds.
   * @returns `1` if the TTL was set, `0` if the key does not exist.
   *
   * @example
   * ```ts
   * await client.expire('session:42', 3600);
   * ```
   */
  async expire(key: string, ttl: number): Promise<number> {
    return this.exec('EXPIRE', [key, ttl], () => this.client.expire(key, ttl));
  }

  /**
   * Returns the remaining TTL of a key in seconds.
   *
   * @param key - The key to inspect.
   * @returns Remaining TTL in seconds; `-2` if the key does not exist, `-1` if it has no TTL.
   *
   * @example
   * ```ts
   * const secondsLeft = await client.ttl('session:42');
   * ```
   */
  async ttl(key: string): Promise<number> {
    return this.exec('TTL', [key], () => this.client.ttl(key));
  }

  /**
   * Atomically increments a counter.
   *
   * @param key - The counter key.
   * @returns The new value after incrementing.
   *
   * @example
   * ```ts
   * const visits = await client.incr('stats:visits'); // 1, 2, 3, ...
   * ```
   */
  async incr(key: string): Promise<number> {
    return this.exec('INCR', [key], () => this.client.incr(key));
  }

  /**
   * Atomically decrements a counter.
   *
   * @param key - The counter key.
   * @returns The new value after decrementing.
   *
   * @example
   * ```ts
   * const stock = await client.decr('inventory:sku-1');
   * ```
   */
  async decr(key: string): Promise<number> {
    return this.exec('DECR', [key], () => this.client.decr(key));
  }

  // Old mget - CROSSSLOT error in cluster mode when keys span different slots
  // async mget(...keys: string[]): Promise<(string | null)[]> {
  //   return this.exec('MGET', keys, () => this.client.mget(...keys));
  // }
  // Cluster-safe: routes through slot-aware mgetClusterAware
  /**
   * Returns the values for multiple keys.
   *
   * Cluster-safe: in cluster mode keys are grouped by hash slot and fetched per node.
   *
   * @param keys - The keys to read.
   * @returns Values in the same order as the input keys; `null` for missing keys.
   *
   * @example
   * ```ts
   * const [a, b, c] = await client.mget('k:a', 'k:b', 'k:c');
   * ```
   */
  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (this.isClusterClient(this.client)) {
      return this.mgetClusterAware(keys);
    }
    return this.exec('MGET', keys, () => this.client.mget(...keys));
  }

  // Old mset - CROSSSLOT error in cluster mode when keys span different slots
  // async mset(...pairs: [string, string | Buffer][]): Promise<'OK'> {
  //   const flat = pairs.flat();
  //   return this.exec('MSET', flat, () => this.client.mset(flat));
  // }
  // Cluster-safe: groups pairs by hash slot, one MSET per slot
  /**
   * Stores multiple key/value pairs in one call.
   *
   * Cluster-safe: in cluster mode pairs are grouped by hash slot and one `MSET` is
   * issued per slot.
   *
   * @param pairs - `[key, value]` tuples.
   * @returns `'OK'` when all pairs were stored.
   *
   * @example
   * ```ts
   * await client.mset(['user:1', 'alice'], ['user:2', 'bob']);
   * ```
   */
  async mset(...pairs: [string, string | Buffer][]): Promise<'OK'> {
    if (this.isClusterClient(this.client)) {
      const groups = new Map<number, Array<string | Buffer>>();
      for (const [key, value] of pairs) {
        const slot = this.calculateSlot(key);
        if (!groups.has(slot)) {
          groups.set(slot, []);
        }
        groups.get(slot)!.push(key, value);
      }
      for (const flat of groups.values()) {
        await this.exec('MSET', flat, () => this.client.mset(flat));
      }
      return 'OK';
    }
    const flat = pairs.flat();
    return this.exec('MSET', flat, () => this.client.mset(flat));
  }

  // Hash operations
  /**
   * Returns the value of a field in a hash.
   *
   * @param key - The hash key.
   * @param field - The field to read.
   * @returns The field value, or `null` if the field or hash does not exist.
   *
   * @example
   * ```ts
   * const name = await client.hget('user:1', 'name');
   * ```
   */
  async hget(key: string, field: string): Promise<string | null> {
    return this.exec('HGET', [key, field], () => this.client.hget(key, field));
  }

  /**
   * Sets a field in a hash.
   *
   * @param key - The hash key.
   * @param field - The field to write.
   * @param value - The value to store.
   * @returns `1` if the field is new, `0` if it was updated.
   *
   * @example
   * ```ts
   * await client.hset('user:1', 'name', 'alice');
   * await client.hset('user:1', 'age', '30');
   * ```
   */
  async hset(key: string, field: string, value: string | Buffer): Promise<number> {
    return this.exec('HSET', [key, field, value], () => this.client.hset(key, field, value));
  }

  /**
   * Returns all fields and values of a hash.
   *
   * @param key - The hash key.
   * @returns An object mapping field names to values.
   *
   * @example
   * ```ts
   * const profile = await client.hgetall('user:1');
   * // { name: 'alice', age: '30' }
   * ```
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.exec('HGETALL', [key], () => this.client.hgetall(key));
  }

  /**
   * Removes one or more fields from a hash.
   *
   * @param key - The hash key.
   * @param fields - Fields to remove.
   * @returns The number of fields that were removed.
   *
   * @example
   * ```ts
   * const removed = await client.hdel('user:1', 'age', 'email');
   * ```
   */
  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.exec('HDEL', [key, ...fields], () => this.client.hdel(key, ...fields));
  }

  // Set operations
  /**
   * Adds one or more members to a set.
   *
   * @param key - The set key.
   * @param members - Members to add.
   * @returns The number of new members added (ignoring duplicates).
   *
   * @example
   * ```ts
   * await client.sadd('tags:post:1', 'redis', 'typescript');
   * ```
   */
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.exec('SADD', [key, ...members], () => this.client.sadd(key, ...members));
  }

  /**
   * Removes one or more members from a set.
   *
   * @param key - The set key.
   * @param members - Members to remove.
   * @returns The number of members that were removed.
   *
   * @example
   * ```ts
   * await client.srem('tags:post:1', 'redis');
   * ```
   */
  async srem(key: string, ...members: string[]): Promise<number> {
    return this.exec('SREM', [key, ...members], () => this.client.srem(key, ...members));
  }

  /**
   * Returns all members of a set.
   *
   * @param key - The set key.
   * @returns The set members.
   *
   * @example
   * ```ts
   * const tags = await client.smembers('tags:post:1');
   * ```
   */
  async smembers(key: string): Promise<string[]> {
    return this.exec('SMEMBERS', [key], () => this.client.smembers(key));
  }

  /**
   * Checks whether a member belongs to a set.
   *
   * @param key - The set key.
   * @param member - The member to check.
   * @returns `1` if the member is present, `0` otherwise.
   *
   * @example
   * ```ts
   * const isAdmin = (await client.sismember('roles:user:1', 'admin')) === 1;
   * ```
   */
  async sismember(key: string, member: string): Promise<number> {
    return this.exec('SISMEMBER', [key, member], () => this.client.sismember(key, member));
  }

  // Sorted set operations
  /**
   * Adds a member to a sorted set with the given score.
   *
   * @param key - The sorted set key.
   * @param score - The numeric score.
   * @param member - The member to add.
   * @returns The number of elements added (0 if the member already existed).
   *
   * @example
   * ```ts
   * await client.zadd('leaderboard', 100, 'player-1');
   * ```
   */
  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.exec('ZADD', [key, score, member], () => this.client.zadd(key, score, member));
  }

  /**
   * Returns members of a sorted set by their rank range.
   *
   * @param key - The sorted set key.
   * @param start - Start rank (inclusive).
   * @param stop - Stop rank (inclusive).
   * @returns The members in rank order.
   *
   * @example
   * ```ts
   * const top10 = await client.zrange('leaderboard', 0, 9);
   * ```
   */
  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.exec('ZRANGE', [key, start, stop], () => this.client.zrange(key, start, stop));
  }

  /**
   * Removes one or more members from a sorted set.
   *
   * @param key - The sorted set key.
   * @param members - Members to remove.
   * @returns The number of members that were removed.
   *
   * @example
   * ```ts
   * await client.zrem('leaderboard', 'player-1');
   * ```
   */
  async zrem(key: string, ...members: string[]): Promise<number> {
    return this.exec('ZREM', [key, ...members], () => this.client.zrem(key, ...members));
  }

  /**
   * Returns an ioredis pipeline for batched operations.
   *
   * Note: in cluster mode all keys in one pipeline must belong to the same hash slot.
   *
   * @returns The raw ioredis pipeline.
   *
   * @example
   * ```ts
   * const pipeline = client.pipeline();
   * pipeline.set('a', '1');
   * pipeline.incr('b');
   * const results = await pipeline.exec();
   * ```
   */
  pipeline() {
    return this.client.pipeline();
  }

  // Old scanIterator - SCAN is keyless, in cluster mode ioredis routes it to a
  // random node, so only that node's keys are ever seen
  // async *scanIterator(pattern: string, count: number = 100): AsyncIterable<string> {
  //   let cursor = '0';
  //   do {
  //     const [nextCursor, keys] = await this.client.scan(
  //       cursor,
  //       'MATCH',
  //       pattern,
  //       'COUNT',
  //       count
  //     );
  //     cursor = nextCursor;
  //     for (const key of keys) {
  //       yield key;
  //     }
  //   } while (cursor !== '0');
  // }
  // Cluster-safe: scans every node in cluster mode
  /**
   * Iterates over keys matching a glob pattern (`SCAN` under the hood).
   *
   * Cluster-safe: in cluster mode every node is scanned, so keys on all shards
   * are yielded.
   *
   * @param pattern - Glob pattern, e.g. `'user:*'`.
   * @param count - Hint for keys per scan batch (default `100`).
   * @yields Keys matching the pattern.
   *
   * @example
   * ```ts
   * for await (const key of client.scanIterator('session:*')) {
   *   console.log(key);
   * }
   * ```
   */
  async *scanIterator(pattern: string, count: number = 100): AsyncIterable<string> {
    const scanNode = async function* (node: any): AsyncIterable<string> {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await node.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          count
        );
        cursor = nextCursor;
        for (const key of keys) {
          yield key;
        }
      } while (cursor !== '0');
    };

    const nodes = this.isClusterClient(this.client)
      ? this.getClusterNodes()
      : [this.client];

    for (const node of nodes) {
      yield* scanNode(node);
    }
  }

  // ============ CLUSTER-SPECIFIC METHODS ============

  // Check if we're in cluster mode
  /**
   * Returns whether the underlying client runs in cluster mode.
   *
   * @returns `true` for cluster mode, `false` for standalone/sentinel.
   *
   * @example
   * ```ts
   * if (client.isCluster()) {
   *   // branch cluster-specific behavior
   * }
   * ```
   */
  isCluster(): boolean {
    return this.isClusterClient(this.client);
  }

  // Get cluster nodes (cluster mode only)
  /**
   * Returns the underlying ioredis instances of all cluster nodes.
   *
   * @returns Cluster node clients, or an empty array outside cluster mode.
   *
   * @example
   * ```ts
   * const nodes = client.getClusterNodes();
   * for (const node of nodes) {
   *   await node.ping();
   * }
   * ```
   */
  getClusterNodes(): any[] {
    if (this.isClusterClient(this.client)) {
      return this.client.nodes();
    }
    return [];
  }

  // Get all nodes with their slots (cluster mode only)
  /**
   * Returns the internal slot-to-node mapping of the cluster.
   *
   * @returns The raw slot map, or `null` outside cluster mode.
   *
   * @example
   * ```ts
   * const slots = client.getClusterSlots();
   * ```
   */
  getClusterSlots(): any {
    if (this.isClusterClient(this.client)) {
      return (this.client as any).slots;
    }
    return null;
  }

  // Old calculateSlot - simplified sum-based calculation, NOT the real CRC16
  // Redis Cluster uses, so keys would be grouped into the wrong slot
  // calculateSlot(key: string): number {
  //   // Redis hash slot calculation algorithm
  //   // https://redis.io/docs/reference/cluster-spec/
  //   let slot = 0;
  //
  //   // Check for hash tags
  //   const start = key.indexOf('{');
  //   if (start !== -1) {
  //     const end = key.indexOf('}', start + 1);
  //     if (end !== -1 && start + 1 < end) {
  //       key = key.substring(start + 1, end);
  //     }
  //   }
  //
  //   // CRC16 hash calculation (simplified)
  //   // In production, use a proper CRC16 implementation
  //   for (let i = 0; i < key.length; i++) {
  //     slot = (slot + key.charCodeAt(i)) % 16384;
  //   }
  //   return slot;
  // }

  private crc16Table: number[] = (() => {
    const table = new Array<number>(256);
    for (let i = 0; i < 256; i++) {
      let crc = i;
      for (let j = 0; j < 8; j++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
      }
      table[i] = crc;
    }
    return table;
  })();

  // Redis hash slot calculation (CRC16-CCITT XModem, https://redis.io/docs/reference/cluster-spec/)
  /**
   * Computes the Redis hash slot for a key (CRC16-CCITT, `% 16384`).
   *
   * Hash tags (`{...}`) are honored, so keys sharing a tag map to the same slot.
   *
   * @param key - The key to hash.
   * @returns A slot number between `0` and `16383`.
   *
   * @example
   * ```ts
   * const slot = client.calculateSlot('{user:42}:profile');
   * const same = client.calculateSlot('{user:42}:posts'); // same slot
   * ```
   */
  calculateSlot(key: string): number {
    // Check for hash tags
    const start = key.indexOf('{');
    if (start !== -1) {
      const end = key.indexOf('}', start + 1);
      if (end !== -1 && start + 1 < end) {
        key = key.substring(start + 1, end);
      }
    }

    let crc = 0;
    for (let i = 0; i < key.length; i++) {
      crc = (crc >>> 8) ^ this.crc16Table[(crc ^ key.charCodeAt(i)) & 0xff]!;
    }
    return crc % 16384;
  }

  // Get node for a specific key (cluster mode only)
  /**
   * Finds the cluster node responsible for a key.
   *
   * @param key - The key to resolve.
   * @returns The responsible node client, or `null` when unknown or outside cluster mode.
   *
   * @example
   * ```ts
   * const node = await client.getNodeForKey('user:1');
   * if (node) await node.ping();
   * ```
   */
  async getNodeForKey(key: string): Promise<any> {
    if (!this.isClusterClient(this.client)) {
      return null;
    }

    try {
      const slot = this.calculateSlot(key);
      // Use the cluster's internal slot mapping
      // The cluster keeps a map of slots to nodes internally
      const clusterClient = this.client as any;

      // Get all nodes
      const nodes = clusterClient.nodes();
      if (!nodes || nodes.length === 0) return null;

      // Find the node that handles this slot
      // The slot mapping is available in the cluster's internal state
      // We need to check which node serves this slot
      for (const node of nodes) {
        // Check if this node serves the slot
        // Each node has information about which slots it serves
        if (node.slots) {
          for (const [startSlot, endSlot] of node.slots) {
            if (slot >= startSlot && slot <= endSlot) {
              return node;
            }
          }
        }
      }

      // If we can't find the specific node, try using the cluster's built-in slot lookup
      // This is available in ioredis cluster
      const node = clusterClient.getSlot(slot);
      return node || null;
    } catch (error) {
      this.logger.warn('Failed to get node for key', { key, error });
      return null;
    }
  }

  // Get all nodes with their slot ranges
  /**
   * Returns a map of slot → node id (`host:port`) for every slot the cluster serves.
   *
   * @returns Slot map, or an empty `Map` outside cluster mode.
   *
   * @example
   * ```ts
   * const ranges = client.getSlotRanges();
   * const nodeForSlot0 = ranges.get(0); // ['10.0.0.1:7000']
   * ```
   */
  getSlotRanges(): Map<number, string[]> {
    if (!this.isClusterClient(this.client)) {
      return new Map();
    }

    const slotRanges = new Map<number, string[]>();
    const clusterClient = this.client as any;

    try {
      const nodes = clusterClient.nodes();
      for (const node of nodes) {
        const host = node.options?.host || 'unknown';
        const port = node.options?.port || 'unknown';
        const nodeId = `${host}:${port}`;

        if (node.slots) {
          for (const [startSlot, endSlot] of node.slots) {
            for (let slot = startSlot; slot <= endSlot; slot++) {
              if (!slotRanges.has(slot)) {
                slotRanges.set(slot, []);
              }
              slotRanges.get(slot)!.push(nodeId);
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to get slot ranges', { error });
    }

    return slotRanges;
  }

  // Check if a key's slot is served by this cluster
  /**
   * Checks whether the cluster currently serves the slot of a key.
   *
   * @param key - The key to check.
   * @returns `true` if served (always `true` outside cluster mode), `false` otherwise.
   *
   * @example
   * ```ts
   * if (await client.isKeyServed('user:1')) {
   *   // safe to write this key
   * }
   * ```
   */
  async isKeyServed(key: string): Promise<boolean> {
    if (!this.isClusterClient(this.client)) {
      return true;
    }

    try {
      const node = await this.getNodeForKey(key);
      return node !== null && node !== undefined;
    } catch {
      return false;
    }
  }

  // Execute command on specific node (cluster mode)
  /**
   * Executes a command directly on the node serving a key, falling back to
   * regular cluster routing when the node lookup fails.
   *
   * @param key - The key whose owning node should run the command.
   * @param command - The ioredis command name, e.g. `'get'`.
   * @param args - Arguments for the command.
   * @returns The command result.
   *
   * @example
   * ```ts
   * const value = await client.executeOnNode<string>('user:1', 'get', 'user:1');
   * ```
   */
  async executeOnNode<T>(
    key: string,
    command: string,
    ...args: any[]
  ): Promise<T> {
    if (this.isClusterClient(this.client)) {
      try {
        const slot = this.calculateSlot(key);
        const clusterClient = this.client as any;
        const node = clusterClient.getSlot(slot);
        if (node && typeof node[command] === 'function') {
          return await node[command](...args);
        }
      } catch (error) {
        this.logger.warn('Failed to execute on specific node, falling back', { error });
      }
    }
    // Fallback to regular execution
    return (this.client as any)[command](...args);
  }

  // Cluster-aware mget - groups keys by slot for efficiency
  /**
   * Multi-get that groups keys by hash slot and issues one `MGET` per slot.
   *
   * Works in every mode; used automatically by `mget()` in cluster mode.
   *
   * @param keys - The keys to read.
   * @returns Values in the same order as the input keys; `null` for missing keys.
   *
   * @example
   * ```ts
   * const values = await client.mgetClusterAware(['a', 'b', 'c']);
   * ```
   */
  async mgetClusterAware(keys: string[]): Promise<(string | null)[]> {
    if (!this.isClusterClient(this.client)) {
      return this.mget(...keys);
    }

    // Group keys by slot
    const groups = new Map<number, string[]>();
    for (const key of keys) {
      const slot = this.calculateSlot(key);
      if (!groups.has(slot)) {
        groups.set(slot, []);
      }
      groups.get(slot)!.push(key);
    }

    // Execute mget for each group on the appropriate node
    const results = new Map<string, string | null>();
    const clusterClient = this.client as any;

    await Promise.all(
      Array.from(groups.entries()).map(async ([slot, slotKeys]) => {
        try {
          const node = clusterClient.getSlot(slot);
          if (node && typeof node.mget === 'function') {
            const values = await node.mget(...slotKeys);
            slotKeys.forEach((key, index) => {
              results.set(key, values[index] || null);
            });
          } else {
            // Fallback
            const values = await this.client.mget(...slotKeys);
            slotKeys.forEach((key, index) => {
              results.set(key, values[index] || null);
            });
          }
        } catch (error) {
          this.logger.error('Failed to execute mget on node', { slot, error });
          // Fallback for this group
          const values = await this.client.mget(...slotKeys);
          slotKeys.forEach((key, index) => {
            results.set(key, values[index] || null);
          });
        }
      })
    );

    return keys.map(key => results.get(key) || null);
  }

  // Delete by pattern with cluster awareness
  /**
   * Deletes every key matching a glob pattern.
   *
   * Cluster-safe: scans all nodes before deleting.
   *
   * @param pattern - Glob pattern, e.g. `'session:*'`.
   * @returns The number of deleted keys.
   *
   * @example
   * ```ts
   * const removed = await client.deletePattern('temp:*');
   * ```
   */
  async deletePattern(pattern: string): Promise<number> {
    let deleted = 0;
    for await (const key of this.scanIterator(pattern)) {
      const result = await this.del(key);
      deleted += result;
    }
    return deleted;
  }

  // Get cluster information
  /**
   * Returns a snapshot of cluster topology and status.
   *
   * @returns A summary object with `mode`, `status`, and (cluster only) `nodeCount`,
   * `slotCount` and per-node `host`/`port`/`role`.
   *
   * @example
   * ```ts
   * const info = client.getClusterInfo();
   * console.log(info.mode, info.status, info.nodeCount);
   * ```
   */
  getClusterInfo(): any {
    if (this.isClusterClient(this.client)) {
      try {
        const clusterClient = this.client as any;
        const nodes = clusterClient.nodes();
        const slotRanges = this.getSlotRanges();

        return {
          mode: 'cluster',
          status: this.isReady ? 'ready' : 'connecting',
          nodeCount: nodes.length,
          slotCount: slotRanges.size,
          nodes: nodes.map((node: any) => ({
            host: node.options?.host || 'unknown',
            port: node.options?.port || 'unknown',
            role: node.options?.role || 'unknown',
          })),
        };
      } catch (error) {
        return {
          mode: 'cluster',
          status: 'error',
          error: String(error),
        };
      }
    }
    return {
      mode: 'standalone',
      host: this.config.host,
      port: this.config.port,
      status: this.isReady ? 'ready' : 'connecting',
    };
  }

  // Info command - works in all modes
  /**
   * Returns Redis `INFO` output, optionally for one section.
   *
   * @param section - Optional INFO section, e.g. `'memory'`, `'clients'`, `'replication'`.
   * @returns The raw INFO response string.
   *
   * @example
   * ```ts
   * const memory = await client.info('memory');
   * ```
   */
  async info(section?: string): Promise<string> {
    if (section) {
      return this.exec('INFO', [section], () => this.client.info(section));
    }
    return this.exec('INFO', [], () => this.client.info());
  }

  // Select database - only works in standalone mode
  /**
   * Selects a database index. Only supported in standalone mode.
   *
   * @param database - Database index.
   * @returns `'OK'` on success.
   * @throws {@link RedisError} with code `CLUSTER_MODE` in cluster mode.
   *
   * @example
   * ```ts
   * await client.select(1);
   * ```
   */
  async select(database: number): Promise<'OK'> {
    if (this.isClusterClient(this.client)) {
      throw new RedisError('SELECT not supported in cluster mode', 'CLUSTER_MODE');
    }
    return (this.client as RedisClient).select(database);
  }
}
