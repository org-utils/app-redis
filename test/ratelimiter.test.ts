import { describe, it, expect, beforeEach } from 'vitest';

import { RateLimiter } from '../src/ratelimiter.js';
import { asWrapper, fakeClient, silentLogger } from './helpers/fake-redis.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RateLimiter', () => {
  let fake: ReturnType<typeof fakeClient>;
  let limiter: RateLimiter;

  beforeEach(() => {
    fake = fakeClient();
    limiter = new RateLimiter(asWrapper(fake), {}, silentLogger);
  });

  describe('sliding window', () => {
    it('allows requests up to the limit', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 3, duration: 60 }, silentLogger);

      const first = await limiter.consume('/api/users', 'user-1');
      expect(first.allowed).toBe(true);
      expect(first.used).toBe(1);
      expect(first.remaining).toBe(2);

      const second = await limiter.consume('/api/users', 'user-1');
      expect(second.allowed).toBe(true);
      expect(second.used).toBe(2);
      expect(second.remaining).toBe(1);

      const third = await limiter.consume('/api/users', 'user-1');
      expect(third.allowed).toBe(true);
      expect(third.used).toBe(3);
      expect(third.remaining).toBe(0);
    });

    it('denies requests beyond the limit with a retryAfter', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 2, duration: 60 }, silentLogger);

      await limiter.consume('/api/users', 'user-1');
      await limiter.consume('/api/users', 'user-1');

      const denied = await limiter.consume('/api/users', 'user-1');
      expect(denied.allowed).toBe(false);
      expect(denied.used).toBe(2);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThan(0);
      expect(denied.resetAt).toBeGreaterThan(Date.now());

      const stillDenied = await limiter.consume('/api/users', 'user-1');
      expect(stillDenied.allowed).toBe(false);
    });

    it('resets after the window expires', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 0.05 }, silentLogger);

      const first = await limiter.consume('/api/login', 'ip-10.0.0.1');
      expect(first.allowed).toBe(true);

      const denied = await limiter.consume('/api/login', 'ip-10.0.0.1');
      expect(denied.allowed).toBe(false);

      await sleep(70);

      const after = await limiter.consume('/api/login', 'ip-10.0.0.1');
      expect(after.allowed).toBe(true);
      expect(after.used).toBe(1);
    });
  });

  describe('fixed window', () => {
    it('allows up to the limit then denies', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 2, duration: 60, algorithm: 'fixed' }, silentLogger);

      const first = await limiter.consume('/api/orders', 'user-7');
      expect(first.allowed).toBe(true);
      expect(first.used).toBe(1);
      expect(first.remaining).toBe(1);
      expect(first.retryAfter).toBe(0);

      const second = await limiter.consume('/api/orders', 'user-7');
      expect(second.allowed).toBe(true);
      expect(second.used).toBe(2);

      const denied = await limiter.consume('/api/orders', 'user-7');
      expect(denied.allowed).toBe(false);
      expect(denied.used).toBe(3);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThan(0);
    });

    it('sets an expiry on the counter and resets after it lapses', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 0.05, algorithm: 'fixed' }, silentLogger);

      const first = await limiter.consume('/api/payments', 'user-9');
      expect(first.allowed).toBe(true);
      expect(await fake.ttl('ratelimit:/api/payments:user-9')).toBeGreaterThan(0);

      await sleep(70);

      const after = await limiter.consume('/api/payments', 'user-9');
      expect(after.allowed).toBe(true);
      expect(after.used).toBe(1);
    });
  });

  describe('check (peek)', () => {
    it('does not consume capacity', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 60 }, silentLogger);

      await limiter.consume('/api/items', 'user-1');
      const peek = await limiter.check('/api/items', 'user-1');

      expect(peek.allowed).toBe(false);
      expect(peek.used).toBe(1);

      const second = await limiter.consume('/api/items', 'user-1');
      expect(second.allowed).toBe(false);
      expect(second.used).toBe(1);
    });

    it('peeks fixed windows without incrementing', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 2, duration: 60, algorithm: 'fixed' }, silentLogger);

      await limiter.consume('/api/items', 'user-2');
      const peek = await limiter.check('/api/items', 'user-2');
      expect(peek.allowed).toBe(true);
      expect(peek.used).toBe(1);

      await limiter.consume('/api/items', 'user-2');
      const atLimit = await limiter.check('/api/items', 'user-2');
      expect(atLimit.allowed).toBe(false);
      expect(atLimit.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('reset', () => {
    it('clears the counter for a key', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 60 }, silentLogger);

      await limiter.consume('/api/checkout', 'user-3');
      expect(await limiter.check('/api/checkout', 'user-3')).toMatchObject({ allowed: false });

      const reset = await limiter.reset('/api/checkout', 'user-3');
      expect(reset).toBe(true);

      const after = await limiter.consume('/api/checkout', 'user-3');
      expect(after.allowed).toBe(true);
    });

    it('returns false when nothing to reset', async () => {
      expect(await limiter.reset('/api/unknown', 'ghost')).toBe(false);
    });
  });

  describe('isolation', () => {
    it('tracks routes independently', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 60 }, silentLogger);

      const a = await limiter.consume('/api/a', 'user-1');
      expect(a.allowed).toBe(true);

      const b = await limiter.consume('/api/b', 'user-1');
      expect(b.allowed).toBe(true);

      const a2 = await limiter.consume('/api/a', 'user-1');
      expect(a2.allowed).toBe(false);
    });

    it('tracks identifiers independently', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 60 }, silentLogger);

      const ip1 = await limiter.consume('/api/search', 'ip-1');
      expect(ip1.allowed).toBe(true);

      const ip2 = await limiter.consume('/api/search', 'ip-2');
      expect(ip2.allowed).toBe(true);

      const ip3 = await limiter.consume('/api/search', 'ip-3');
      expect(ip3.allowed).toBe(true);

      const ip1Again = await limiter.consume('/api/search', 'ip-1');
      expect(ip1Again.allowed).toBe(false);
    });

    it('supports arbitrary resources (db, email, api key)', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 1, duration: 60 }, silentLogger);

      await limiter.consume('db:write', 'service-a');
      await limiter.consume('email:send', 'service-a');
      await limiter.consume('api-key', 'service-a');

      const dbAgain = await limiter.consume('db:write', 'service-a');
      expect(dbAgain.allowed).toBe(false);

      const emailAgain = await limiter.consume('email:send', 'service-a');
      expect(emailAgain.allowed).toBe(false);

      const keyAgain = await limiter.consume('api-key', 'service-a');
      expect(keyAgain.allowed).toBe(false);
    });
  });

  describe('options', () => {
    it('applies defaults when no options given', async () => {
      const limiter = new RateLimiter(asWrapper(fake), {}, silentLogger);
      const result = await limiter.consume('/api', 'user-1');

      expect(result.limit).toBe(100);
      expect(result.allowed).toBe(true);
      expect(limiter.makeKey('/api', 'user-1')).toBe('ratelimit:/api:user-1');
    });

    it('overrides defaults per call', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { limit: 5, duration: 10 }, silentLogger);

      const burst = await limiter.consume('/api/burst', 'user-1', { limit: 1, duration: 60 });
      expect(burst.limit).toBe(1);
      expect(burst.allowed).toBe(true);

      const burstAgain = await limiter.consume('/api/burst', 'user-1', { limit: 1, duration: 60 });
      expect(burstAgain.allowed).toBe(false);
    });

    it('uses a custom namespace', async () => {
      const limiter = new RateLimiter(asWrapper(fake), { namespace: 'rl', algorithm: 'fixed' }, silentLogger);

      await limiter.consume('/api/x', 'user-1');
      const key = limiter.makeKey('/api/x', 'user-1', 'rl');
      expect(key).toBe('rl:/api/x:user-1');
      expect(await fake.get(key)).toBe('1');

      const other = limiter.makeKey('/api/x', 'user-1', 'default');
      expect(await fake.get(other)).toBe(null);
    });
  });

  describe('failure handling', () => {
    it('fails open when redis is unavailable', async () => {
      fake.fail('eval');
      const limiter = new RateLimiter(asWrapper(fake), { limit: 5, duration: 60 }, silentLogger);

      const result = await limiter.consume('/api', 'user-1');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
    });

    it('fails open for fixed windows too', async () => {
      fake.fail('incr');
      const limiter = new RateLimiter(asWrapper(fake), { limit: 5, duration: 60, algorithm: 'fixed' }, silentLogger);

      const result = await limiter.consume('/api', 'user-1');
      expect(result.allowed).toBe(true);
    });

    it('fails open on check', async () => {
      fake.fail('eval');
      const limiter = new RateLimiter(asWrapper(fake), { limit: 5, duration: 60 }, silentLogger);

      const result = await limiter.check('/api', 'user-1');
      expect(result.allowed).toBe(true);
    });
  });
});