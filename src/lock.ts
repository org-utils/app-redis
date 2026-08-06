import { RedisClientWrapper } from './client.js';
import { RedisError } from './errors.js';
import { randomBytes } from 'node:crypto';
import { Logger } from '@dev_config/logger';

export interface LockInfo {
  locked: boolean;
  ttl?: number;
  lockId?: string;
}

export interface DistributedLockOptions {
  ttl?: number;
  retryCount?: number;
  retryDelay?: number;
}

export class DistributedLock {
  private client: RedisClientWrapper;
  private logger: Logger;
  private defaultTTL: number;
  private defaultRetryCount: number;
  private defaultRetryDelay: number;

  constructor(
    client: RedisClientWrapper,
    logger: Logger,
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

  async releaseForce(key: string): Promise<boolean> {
    const lockKey = this.getLockKey(key);
    const result = await this.client.raw.del(lockKey);
    return result === 1;
  }

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

  async isLocked(key: string): Promise<boolean> {
    const lockKey = this.getLockKey(key);
    const exists = await this.client.raw.exists(lockKey);
    return exists === 1;
  }

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

  async getLockOwner(key: string): Promise<string | null> {
    const lockKey = this.getLockKey(key);
    return this.client.raw.get(lockKey);
  }

  async getLockTTL(key: string): Promise<number> {
    const lockKey = this.getLockKey(key);
    const ttl = await this.client.raw.ttl(lockKey);
    return ttl > 0 ? ttl : 0;
  }

  // Clean up all locks (for testing or emergency)
  async cleanupAll(): Promise<number> {
    let deleted = 0;
    for await (const key of this.client.scanIterator('lock:*')) {
      const result = await this.client.raw.del(key);
      deleted += result;
    }
    return deleted;
  }
}
