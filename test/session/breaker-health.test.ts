import { describe, expect, it, vi } from 'vitest';

import { SessionCircuitBreaker } from '../../src/session/session-circuit-breaker.js';
import { SessionHealthChecker } from '../../src/session/session-health.js';
import { SessionConfigurationError } from '../../src/session/session-errors.js';
import { parseSessionConfig, TTL } from '../../src/session/session-config.js';

const config = {
  enabled: true,
  failureThreshold: 3,
  resetTimeoutMs: 1000,
  halfOpenMaxRequests: 2,
};

describe('session circuit breaker', () => {
  it('starts closed and allows calls', () => {
    const breaker = new SessionCircuitBreaker(config);
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens after failureThreshold consecutive failures (fail closed)', () => {
    const breaker = new SessionCircuitBreaker(config);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('a success resets the failure streak', () => {
    const breaker = new SessionCircuitBreaker(config);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed'); // 2, not 4
  });

  it('transitions to half-open after the reset window', () => {
    let now = 0;
    const breaker = new SessionCircuitBreaker(config, { now: () => now });

    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);

    now = 1001;
    expect(breaker.tryAcquire()).toBe(true); // probe allowed
    expect(breaker.state).toBe('half_open');
  });

  it('a half-open probe success closes the circuit', async () => {
    let now = 0;
    const breaker = new SessionCircuitBreaker(config, { now: () => now });

    for (let i = 0; i < 3; i++) breaker.recordFailure();
    now = 1001;

    const result = await breaker.run(async () => 'ok');
    expect(result).toBe('ok');
    expect(breaker.state).toBe('closed');
  });

  it('a half-open probe failure reopens the circuit', async () => {
    let now = 0;
    const breaker = new SessionCircuitBreaker(config, { now: () => now });

    for (let i = 0; i < 3; i++) breaker.recordFailure();
    now = 1001;

    await expect(
      breaker.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');
  });

  it('limits concurrent half-open probes', () => {
    let now = 0;
    const breaker = new SessionCircuitBreaker(config, { now: () => now });

    for (let i = 0; i < 3; i++) breaker.recordFailure();
    now = 1001;

    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // probe limit reached
  });

  it('run() throws CircuitBreakerOpenError when open', async () => {
    let now = 0;
    const breaker = new SessionCircuitBreaker(config, { now: () => now });
    for (let i = 0; i < 3; i++) breaker.recordFailure();

    await expect(breaker.run(async () => 'x')).rejects.toMatchObject({
      name: 'CircuitBreakerOpenError',
    });
  });

  it('run() records failures automatically', async () => {
    const breaker = new SessionCircuitBreaker(config);
    await expect(
      breaker.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(
      breaker.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(breaker.state).toBe('closed'); // threshold is 3
    await expect(breaker.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');
  });

  it('reset() closes an open circuit', () => {
    const breaker = new SessionCircuitBreaker(config);
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state).toBe('open');
    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('notifies state transitions', () => {
    const transitions: string[] = [];
    const breaker = new SessionCircuitBreaker(config, {
      onTransition: (state) => transitions.push(state),
    });
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(transitions).toEqual(['open']);
  });
});

describe('session health checker', () => {
  const fakeClient = {
    raw: { ping: vi.fn(async () => 'PONG') },
  } as never;

  const healthConfig = {
    latencyThresholdMs: 100,
    errorRateThreshold: 0.5,
    errorWindowSize: 10,
  };

  it('is healthy when PING is fast and error rate is low', async () => {
    const checker = new SessionHealthChecker(fakeClient, healthConfig);
    checker.recordOp(true);
    checker.recordOp(true);
    checker.recordOp(false);
    const status = await checker.check();
    expect(status.reachable).toBe(true);
    expect(status.healthy).toBe(true);
  });

  it('is degraded when the error rate exceeds the threshold', async () => {
    const checker = new SessionHealthChecker(fakeClient, healthConfig);
    checker.recordOp(true);
    checker.recordOp(false);
    checker.recordOp(false);
    const status = await checker.check();
    expect(status.healthy).toBe(false);
    expect(status.errorRate).toBe(2 / 3);
  });

  it('is unreachable when PING fails', async () => {
    const failing = {
      raw: { ping: vi.fn(async () => Promise.reject(new Error('down'))) },
    } as never;
    const checker = new SessionHealthChecker(failing, healthConfig);
    const status = await checker.check();
    expect(status.reachable).toBe(false);
    expect(status.healthy).toBe(false);
    expect(status.latencyMs).toBeNull();
  });
});

describe('session config', () => {
  it('rejects idleTimeout > ttl', () => {
    expect(() => parseSessionConfig({ ttl: 100, idleTimeout: 200 })).toThrow(
      SessionConfigurationError,
    );
  });

  it('rejects SameSite=None without Secure', () => {
    expect(() =>
      parseSessionConfig({ cookie: { sameSite: 'none', secure: false } }),
    ).toThrow(SessionConfigurationError);
  });

  it('applies defaults', () => {
    const config = parseSessionConfig();
    expect(config.enabled).toBe(false);
    expect(config.namespace).toBe('authcore');
    expect(config.ttl).toBe(TTL);
    expect(config.jtiIndex.enabled).toBe(false);
  });
});