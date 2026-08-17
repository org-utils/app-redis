import { randomUUID } from 'node:crypto';

import { RedisClientWrapper } from './client.js';
import { defaultLogger, LoggerLike } from './logger.js';

/**
 * Window algorithm used by the rate limiter.
 * - `fixed` - fixed window via `INCR`/`EXPIRE` (simple, cheapest)
 * - `sliding` - sliding window via an atomic Lua script over a sorted set (smoothest)
 */
export type RateLimitAlgorithm = 'fixed' | 'sliding';

/**
 * Options for a rate limiter instance or an individual call.
 */
export interface RateLimitOptions {
  /** Maximum allowed requests within `duration`. Default: `100`. */
  limit?: number;
  /** Window length in seconds. Default: `60`. */
  duration?: number;
  /** Window algorithm. Default: `'sliding'`. */
  algorithm?: RateLimitAlgorithm;
  /** Redis key prefix. Default: `'ratelimit'`. */
  namespace?: string;
}

/**
 * Result of a rate limit `consume`/`check` call.
 */
export interface RateLimitResult {
  /** `true` when the request is within the limit. */
  allowed: boolean;
  /** The configured maximum within the window. */
  limit: number;
  /** Requests already counted in the current window. */
  used: number;
  /** Requests still available (`limit - used`, floored at `0`). */
  remaining: number;
  /** Epoch milliseconds when the window resets (0 retry hint when allowed). */
  resetAt: number;
  /** Seconds to wait before retrying; `0` when allowed. */
  retryAfter: number;
}

const CONSUME_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retryAfter = 0
  if oldest[2] then
    retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000))
  end
  return { 0, count, -1, retryAfter }
end

redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window)
return { 1, count + 1, limit - count - 1, 0 }
`;

const PEEK_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])

redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local count = redis.call('ZCARD', key)
local retryAfter = 0
if count >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest[2] then
    retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + window - now) / 1000))
  end
end
return { count, retryAfter }
`;

function failOpenResult(limit: number, duration: number): RateLimitResult {
  return {
    allowed: true,
    limit,
    used: 0,
    remaining: limit,
    resetAt: Date.now() + duration * 1000,
    retryAfter: 0,
  };
}

/**
 * Generic Redis-backed rate limiter that works for any resource: routes, API
 * endpoints, users, IPs, databases, email sending, etc.
 *
 * Keys are namespaced as `ratelimit:{namespace}:{resource}:{identifier}` so each
 * resource + identifier combination is tracked independently. Supports fixed-window
 * (`INCR`/`EXPIRE`) and sliding-window (atomic Lua over a sorted set) algorithms.
 * Fails open when Redis is unavailable.
 *
 * @example
 * ```ts
 * const limiter = new RateLimiter(client, { limit: 100, duration: 60 });
 *
 * const result = await limiter.consume('/api/login', 'ip-10.0.0.1');
 * if (!result.allowed) {
 *   throw new Error(`Slow down, retry in ${result.retryAfter}s`);
 * }
 * ```
 */
export class RateLimiter {
  private client: RedisClientWrapper;
  private logger: LoggerLike;
  private defaultLimit: number;
  private defaultDuration: number;
  private defaultAlgorithm: RateLimitAlgorithm;
  private defaultNamespace: string;

  /**
   * Creates a rate limiter bound to a Redis client.
   *
   * @param client - The underlying {@link RedisClientWrapper}.
   * @param options - Defaults applied when a call does not override them:
   *   `limit` (default `100`), `duration` in seconds (default `60`),
   *   `algorithm` (default `'sliding'`), `namespace` (default `'ratelimit'`).
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * const limiter = new RateLimiter(client, { limit: 10, duration: 1, algorithm: 'fixed' });
   * ```
   */
  constructor(
    client: RedisClientWrapper,
    options: RateLimitOptions = {},
    logger: LoggerLike = defaultLogger
  ) {
    this.client = client;
    this.logger = logger.child({ component: 'RateLimiter' });
    this.defaultLimit = options.limit ?? 100;
    this.defaultDuration = options.duration ?? 60;
    this.defaultAlgorithm = options.algorithm ?? 'sliding';
    this.defaultNamespace = options.namespace ?? 'ratelimit';
  }

  /**
   * Builds the Redis key for a resource + identifier combination.
   *
   * @param resource - The rate-limited resource, e.g. a route `'/api/login'` or
   *   a resource name `'email:send'`.
   * @param identifier - The caller identity, e.g. an IP, user id or API key.
   * @param namespace - Key prefix (defaults to the limiter's namespace).
   * @returns The full key, e.g. `'ratelimit:/api/login:ip-10.0.0.1'`.
   *
   * @example
   * ```ts
   * limiter.makeKey('/api/login', 'ip-10.0.0.1');
   * // 'ratelimit:/api/login:ip-10.0.0.1'
   * ```
   */
  makeKey(resource: string, identifier: string, namespace: string = this.defaultNamespace): string {
    return `${namespace}:${resource}:${identifier}`;
  }

  /**
   * Consumes one unit of capacity for a resource + identifier and returns the
   * resulting limit state.
   *
   * When the limit is reached the request is not recorded and `allowed` is
   * `false` with `retryAfter` (seconds) and `resetAt` (epoch ms) hints.
   * Fails open (allows the request) if Redis errors.
   *
   * @param resource - The rate-limited resource, e.g. a route `'/api/login'` or
   *   a resource name `'db:write'`.
   * @param identifier - The caller identity, e.g. an IP, user id or API key.
   * @param options - Per-call overrides for `limit`, `duration`, `algorithm`,
   *   and `namespace`.
   * @returns The limit state: `allowed`, `limit`, `used`, `remaining`,
   *   `resetAt` (epoch ms), `retryAfter` (seconds).
   *
   * @example
   * ```ts
   * const result = await limiter.consume('/api/orders', 'user-7', { limit: 5, duration: 60 });
   * if (!result.allowed) {
   *   res.setHeader('Retry-After', String(result.retryAfter));
   *   return res.status(429).json({ error: 'Too many requests' });
   * }
   * ```
   */
  async consume(
    resource: string,
    identifier: string,
    options: RateLimitOptions = {}
  ): Promise<RateLimitResult> {
    const limit = options.limit ?? this.defaultLimit;
    const duration = options.duration ?? this.defaultDuration;
    const algorithm = options.algorithm ?? this.defaultAlgorithm;
    const namespace = options.namespace ?? this.defaultNamespace;
    const key = this.makeKey(resource, identifier, namespace);

    try {
      if (algorithm === 'fixed') {
        return await this.consumeFixed(key, limit, duration);
      }
      return await this.consumeSliding(key, limit, duration);
    } catch (error) {
      this.logger.error('Rate limit consume failed, failing open', { key, error });
      return failOpenResult(limit, duration);
    }
  }

  /**
   * Peeks at the current limit state without consuming capacity.
   *
   * Useful for pre-flight checks (e.g. showing "limit reached" in a UI before
   * the actual request). Also fails open on Redis errors.
   *
   * @param resource - The rate-limited resource.
   * @param identifier - The caller identity.
   * @param options - Per-call overrides for `limit`, `duration`, `algorithm`,
   *   and `namespace`.
   * @returns The current limit state; `used` is not incremented.
   *
   * @example
   * ```ts
   * const state = await limiter.check('/api/search', 'user-1');
   * if (state.remaining === 0) {
   *   // disable the search button
   * }
   * ```
   */
  async check(
    resource: string,
    identifier: string,
    options: RateLimitOptions = {}
  ): Promise<RateLimitResult> {
    const limit = options.limit ?? this.defaultLimit;
    const duration = options.duration ?? this.defaultDuration;
    const algorithm = options.algorithm ?? this.defaultAlgorithm;
    const namespace = options.namespace ?? this.defaultNamespace;
    const key = this.makeKey(resource, identifier, namespace);

    try {
      if (algorithm === 'fixed') {
        return await this.checkFixed(key, limit, duration);
      }
      return await this.checkSliding(key, limit, duration);
    } catch (error) {
      this.logger.error('Rate limit check failed, failing open', { key, error });
      return failOpenResult(limit, duration);
    }
  }

  /**
   * Resets the counter for a resource + identifier, granting full capacity again.
   *
   * @param resource - The rate-limited resource.
   * @param identifier - The caller identity.
   * @param namespace - Key prefix (defaults to the limiter's namespace).
   * @returns `true` if a counter existed and was removed.
   *
   * @example
   * ```ts
   * // user upgraded to a premium plan, lift their limits
   * await limiter.reset('/api/export', 'user-7');
   * ```
   */
  async reset(resource: string, identifier: string, namespace: string = this.defaultNamespace): Promise<boolean> {
    const key = this.makeKey(resource, identifier, namespace);
    try {
      const deleted = await this.client.del(key);
      return deleted > 0;
    } catch (error) {
      this.logger.error('Rate limit reset failed', { key, error });
      return false;
    }
  }

  private async consumeFixed(key: string, limit: number, duration: number): Promise<RateLimitResult> {
    const now = Date.now();
    const count = await this.client.incr(key);
    if (count === 1) {
      await this.client.expire(key, duration);
    }
    const ttl = await this.client.ttl(key);
    const ttlSeconds = ttl > 0 ? ttl : duration;
    const allowed = count <= limit;

    return {
      allowed,
      limit,
      used: count,
      remaining: Math.max(0, limit - count),
      resetAt: now + ttlSeconds * 1000,
      retryAfter: allowed ? 0 : ttlSeconds,
    };
  }

  private async consumeSliding(key: string, limit: number, duration: number): Promise<RateLimitResult> {
    const now = Date.now();
    const member = `${now}:${randomUUID()}`;
    const result = (await this.client.raw.eval(
      CONSUME_SCRIPT,
      1,
      key,
      now,
      duration * 1000,
      limit,
      member
    )) as number[];
    const allowed = result[0] === 1;
    const used = result[1] ?? 0;
    const remaining = result[2] ?? 0;
    const retryAfter = result[3] ?? 0;

    return {
      allowed,
      limit,
      used,
      remaining: allowed ? remaining : 0,
      resetAt: now + retryAfter * 1000,
      retryAfter,
    };
  }

  private async checkFixed(key: string, limit: number, duration: number): Promise<RateLimitResult> {
    const now = Date.now();
    const raw = await this.client.get(key);
    const used = raw === null || raw === undefined ? 0 : Number(raw) || 0;
    const ttl = await this.client.ttl(key);
    const ttlSeconds = ttl > 0 ? ttl : duration;
    const allowed = used < limit;

    return {
      allowed,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: now + ttlSeconds * 1000,
      retryAfter: allowed ? 0 : ttlSeconds,
    };
  }

  private async checkSliding(key: string, limit: number, duration: number): Promise<RateLimitResult> {
    const now = Date.now();
    const result = (await this.client.raw.eval(
      PEEK_SCRIPT,
      1,
      key,
      now,
      duration * 1000,
      limit
    )) as number[];
    const used = result[0] ?? 0;
    const retryAfter = result[1] ?? 0;

    return {
      allowed: used < limit,
      limit,
      used,
      remaining: Math.max(0, limit - used),
      resetAt: now + retryAfter * 1000,
      retryAfter,
    };
  }
}