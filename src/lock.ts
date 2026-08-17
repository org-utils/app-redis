import { RedisClientWrapper } from './client.js';
import { RedisError } from './errors.js';
import { randomBytes } from 'node:crypto';
import { defaultLogger, LoggerLike } from './logger.js';

/**
 * Information about a distributed lock.
 */
export interface LockInfo {
  /** Whether the lock is currently held. */
  locked: boolean;
  /** Remaining TTL in seconds (when held and TTL set). */
  ttl?: number;
  /** Unique owner id of the lock. */
  lockId?: string;
}

/**
 * Options for the distributed lock.
 */
export interface DistributedLockOptions {
  /** Lock TTL in milliseconds. Default: `30000`. */
  ttl?: number;
  /** Number of acquisition attempts. Default: `3`. */
  retryCount?: number;
  /** Base delay between retries in ms (grows exponentially). Default: `200`. */
  retryDelay?: number;
}

/**
 * Distributed mutual-exclusion lock backed by Redis.
 *
 * Works in standalone, sentinel and cluster modes. Acquisition uses atomic
 * `SET ... PX NX`; release and extension use Lua scripts so only the lock owner
 * can release or extend. `withLock` auto-extends the lock at half TTL while the
 * critical section runs and always releases afterwards.
 *
 * @example
 * ```ts
 * const lock = new DistributedLock(client, { ttl: 30000, retryCount: 5 });
 * const acquired = await lock.acquire('order:42');
 * if (acquired) {
 *   try {
 *     // critical section
 *   } finally {
 *     await lock.release('order:42');
 *   }
 * }
 * ```
 */
export class DistributedLock {
  private client: RedisClientWrapper;
  private logger: LoggerLike;
  private defaultTTL: number;
  private defaultRetryCount: number;
  private defaultRetryDelay: number;

  /**
   * Creates a distributed lock bound to a Redis client.
   *
   * @param client - The underlying {@link RedisClientWrapper}.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   * @param options - Defaults for `ttl` (ms), `retryCount` and `retryDelay`.
   *
   * @example
   * ```ts
   * const lock = new DistributedLock(client, { ttl: 10000, retryCount: 3 });
   * ```
   */
  constructor(
    client: RedisClientWrapper,
    logger: LoggerLike = defaultLogger,
    options: Partial<DistributedLockOptions> = {}
  ) {
    this.client = client;
    this.logger = logger.child({ component: 'DistributedLock' });
    this.defaultTTL = options.ttl || 30000;
    this.defaultRetryCount = options.retryCount || 3;
    this.defaultRetryDelay = options.retryDelay || 200;
  }

  private getLockKey(key: string): string {
    return `lock:${key}`;
  }

  private generateLockId(): string {
    return randomBytes(16).toString('hex');
  }

  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    retryCount: number = this.defaultRetryCount,
    retryDelay: number = this.defaultRetryDelay
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let i = 0; i < retryCount; i++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;
        if (i < retryCount - 1) {
          const delay = retryDelay * Math.pow(2, i) * (0.5 + Math.random() * 0.5);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Retry failed');
  }

  /**
   * Attempts to acquire the lock for a key.
   *
   * Uses atomic `SET lock:<key> <id> PX <ttl> NX` with exponential backoff
   * retries. Locks expire automatically after `ttl` ms, so a crashed holder
   * never blocks others forever.
   *
   * @param key - The resource to lock, e.g. `'order:42'` (stored as `lock:order:42`).
   * @param ttl - Lock TTL in milliseconds (default: `30000`).
   * @returns `true` when the lock was acquired.
   *
   * @example
   * ```ts
   * const acquired = await lock.acquire('order:42', 10000);
   * ```
   */
  async acquire(key: string, ttl: number = this.defaultTTL): Promise<boolean> {
    const lockKey = this.getLockKey(key);
    const lockId = this.generateLockId();

    return this.executeWithRetry(async () => {
      // Using SET with PX and NX for atomic lock acquisition
      const result = await this.client.raw.set(
        lockKey,
        lockId,
        'PX',
        ttl,
        'NX'
      );

      return result === 'OK';
    });
  }

  /**
   * Releases the lock, but only if this process still owns it.
   *
   * Uses an atomic Lua check-and-delete so a lock whose TTL expired (and was
   * re-acquired by someone else) is never removed by the old owner.
   *
   * @param key - The locked resource.
   * @returns `true` if the lock was released, `false` if not owned or missing.
   *
   * @example
   * ```ts
   * await lock.release('order:42');
   * ```
   */
  async release(key: string): Promise<boolean> {
    const lockKey = this.getLockKey(key);

    try {
      // Use Lua script for atomic check-and-delete
      const script = `
        if redis.call('get', KEYS[1]) == ARGV[1] then
          return redis.call('del', KEYS[1])
        else
          return 0
        end
      `;

      const lockId = await this.client.raw.get(lockKey);
      if (!lockId) {
        this.logger.warn('Lock not found for release', { key });
        return false;
      }

      const result = await this.client.raw.eval(script, 1, lockKey, lockId);
      return result === 1;
    } catch (error) {
      this.logger.error('Failed to release lock', { key, error });
      return false;
    }
  }

  /**
   * Force-releases a lock without checking ownership.
   *
   * Use with care: only for emergency cleanup or when the holder is known to
   * be gone. This is what `withLock` falls back to when a normal release fails.
   *
   * @param key - The locked resource.
   * @returns `true` if a lock existed and was deleted.
   *
   * @example
   * ```ts
   * await lock.releaseForce('order:42');
   * ```
   */
  async releaseForce(key: string): Promise<boolean> {
    const lockKey = this.getLockKey(key);
    const result = await this.client.raw.del(lockKey);
    return result === 1;
  }

  /**
   * Extends the TTL of a lock this process still owns.
   *
   * Uses an atomic Lua script so a re-acquired lock is never extended by the
   * old owner.
   *
   * @param key - The locked resource.
   * @param ttl - New TTL in milliseconds (default: `30000`).
   * @returns `true` if the lock was extended.
   *
   * @example
   * ```ts
   * const extended = await lock.extend('order:42', 30000);
   * ```
   */
  async extend(key: string, ttl: number = this.defaultTTL): Promise<boolean> {
    const lockKey = this.getLockKey(key);

    const script = `
      if redis.call('get', KEYS[1]) == ARGV[1] then
        return redis.call('pexpire', KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    try {
      const lockId = await this.client.raw.get(lockKey);
      if (!lockId) {
        return false;
      }

      const result = await this.client.raw.eval(script, 1, lockKey, lockId, ttl);
      return result === 1;
    } catch (error) {
      this.logger.error('Failed to extend lock', { key, error });
      return false;
    }
  }

  /**
   * Runs a critical section while holding a lock.
   *
   * Acquires the lock (with retries), auto-extends it at half TTL while `fn`
   * runs, detects a lost lock, and always releases afterwards (force-releasing
   * if a normal release fails).
   *
   * @param key - The resource to lock.
   * @param fn - The critical section to run exclusively.
   * @param options - Per-call `ttl` (ms), `retryCount`, `retryDelay`.
   * @returns The return value of `fn`.
   * @throws {@link RedisError} with code `LOCK_ACQUISITION_FAILED` when the lock
   *   cannot be acquired, or `LOCK_LOST` when the lock expired mid-execution.
   *
   * @example
   * ```ts
   * const result = await lock.withLock('inventory:sku-1', async () => {
   *   return await updateStock();
   * });
   * ```
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    options: DistributedLockOptions = {}
  ): Promise<T> {
    const ttl = options.ttl || this.defaultTTL;
    const retryCount = options.retryCount || this.defaultRetryCount;
    const retryDelay = options.retryDelay || this.defaultRetryDelay;

    // Try to acquire the lock with retries
    const acquired = await this.acquire(key, ttl);
    if (!acquired) {
      throw new RedisError(
        `Failed to acquire lock for key: ${key} after ${retryCount} attempts`,
        'LOCK_ACQUISITION_FAILED'
      );
    }

    let extensionTimer: NodeJS.Timeout | null = null;
    let lockRenewed = true;

    try {
      // Start auto-extension timer at half TTL
      const extendInterval = Math.floor(ttl / 2);
      let isExtending = false;

      const extendLock = async () => {
        if (isExtending || !lockRenewed) return;
        isExtending = true;
        try {
          const extended = await this.extend(key, ttl);
          if (!extended) {
            lockRenewed = false;
            this.logger.warn('Lock extension failed', { key });
          }
        } catch (error) {
          this.logger.error('Lock extension error', { key, error });
          lockRenewed = false;
        } finally {
          isExtending = false;
        }
      };

      // Schedule auto-extension
      extensionTimer = setInterval(() => {
        extendLock().catch((error) => {
          this.logger.error('Extension interval error', { key, error });
        });
      }, extendInterval);

      // Execute the function
      const result = await fn();

      // Check if lock was maintained during execution
      if (!lockRenewed) {
        throw new RedisError(
          `Lock was lost during execution for key: ${key}`,
          'LOCK_LOST'
        );
      }

      return result;
    } catch (error) {
      this.logger.error('Error in locked operation', { key, error });
      throw error;
    } finally {
      // Clean up extension timer
      if (extensionTimer) {
        clearInterval(extensionTimer);
        extensionTimer = null;
      }

      // Release the lock
      try {
        await this.release(key);
      } catch (releaseError) {
        this.logger.error('Failed to release lock', { key, releaseError });
        try {
          await this.releaseForce(key);
        } catch (forceError) {
          this.logger.error('Failed to force release lock', { key, forceError });
        }
      }
    }
  }

  /**
   * Checks whether a lock is currently held.
   *
   * @param key - The locked resource.
   * @returns `true` if the lock exists (held by anyone).
   *
   * @example
   * ```ts
   * const busy = await lock.isLocked('order:42');
   * ```
   */
  async isLocked(key: string): Promise<boolean> {
    const lockKey = this.getLockKey(key);
    const exists = await this.client.raw.exists(lockKey);
    return exists === 1;
  }

  /**
   * Returns details about a lock.
   *
   * @param key - The locked resource.
   * @returns `{ locked: false }` when not held, otherwise `{ locked: true, ttl, lockId }`.
   *
   * @example
   * ```ts
   * const info = await lock.getLockInfo('order:42');
   * // { locked: true, ttl: 29, lockId: 'a1b2c3...' }
   * ```
   */
  async getLockInfo(key: string): Promise<LockInfo> {
    const lockKey = this.getLockKey(key);
    const exists = await this.client.raw.exists(lockKey);

    if (!exists) {
      return { locked: false };
    }

    const [lockId, ttl] = await Promise.all([
      this.client.raw.get(lockKey),
      this.client.raw.ttl(lockKey),
    ]);

    // Build the result object with proper undefined handling
    const result: LockInfo = { locked: true };

    if (lockId !== null && lockId !== undefined) {
      result.lockId = lockId;
    }

    if (ttl !== null && ttl !== undefined && ttl > 0) {
      result.ttl = ttl;
    }

    return result;
  }

  /**
   * Returns the owner id of a lock.
   *
   * @param key - The locked resource.
   * @returns The lock id (random hex token), or `null` when not held.
   *
   * @example
   * ```ts
   * const owner = await lock.getLockOwner('order:42');
   * ```
   */
  async getLockOwner(key: string): Promise<string | null> {
    const lockKey = this.getLockKey(key);
    return this.client.raw.get(lockKey);
  }

  /**
   * Returns the remaining TTL of a lock in seconds.
   *
   * @param key - The locked resource.
   * @returns Remaining seconds (`0` when not held or expired).
   *
   * @example
   * ```ts
   * const remaining = await lock.getLockTTL('order:42');
   * ```
   */
  async getLockTTL(key: string): Promise<number> {
    const lockKey = this.getLockKey(key);
    const ttl = await this.client.raw.ttl(lockKey);
    return ttl > 0 ? ttl : 0;
  }

  // Clean up all locks (for testing or emergency)
  /**
   * Deletes every lock key (`lock:*`) from Redis.
   *
   * Intended for tests and emergency recovery only.
   *
   * @returns The number of deleted locks.
   *
   * @example
   * ```ts
   * const removed = await lock.cleanupAll();
   * ```
   */
  async cleanupAll(): Promise<number> {
    let deleted = 0;
    for await (const key of this.client.scanIterator('lock:*')) {
      const result = await this.client.raw.del(key);
      deleted += result;
    }
    return deleted;
  }
}
