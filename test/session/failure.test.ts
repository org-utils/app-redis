import { beforeAll, describe, expect, it } from 'vitest';

import { RedisClientWrapper } from '../../src/client.js';
import { RedisRevocationStore } from '../../src/session/revocation-store.js';
import {
  RevocationError,
  SessionConcurrencyError,
  SessionRevokedError,
  SessionStorageError,
} from '../../src/session/session-errors.js';
import { SessionService } from '../../src/session/session-service.js';
import type { SessionRepository } from '../../src/session/session-repository.js';
import { connectSuite, freshManager, suiteGuard, testClientConfig } from './helpers.js';

const PREFIX = 't-failure';

let client: Awaited<ReturnType<typeof connectSuite>>;
let ready = false;

const gated = (title: string, fn: () => Promise<void>) =>
  it(title, async () => {
    if (!ready) return;
    await fn();
  });

/** Repository whose every operation throws like an infrastructure failure. */
function failingRepository(): SessionRepository {
  const fail = async (): Promise<never> => {
    throw new Error('simulated infrastructure failure');
  };
  return {
    create: fail,
    validateRead: fail,
    touch: fail,
    rotate: fail,
    update: fail,
    destroy: fail,
    revoke: fail,
    revokeAll: fail,
    deleteByUser: fail,
    findByUser: fail,
    listJtis: fail,
    get: fail,
    setSecurityVersion: fail,
    getSecurityVersion: fail,
    writeJtiIndex: fail,
    readJtiIndex: fail,
    deleteJtiIndex: fail,
    deleteJtiIndexMany: fail,
    keyProvider: null,
  } as unknown as SessionRepository;
}

describe('failure handling (fail closed)', () => {
  beforeAll(async () => {
    client = await connectSuite(PREFIX);
    ready = suiteGuard(client);
  });

  gated('repository failure surfaces as SessionStorageError, never "invalid"', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const service = new SessionService({
      config: m.config,
      client: client!,
      repository: failingRepository(),
      token: m.token,
      keys: m.keys,
      metrics: m.metrics,
      health: m.health,
    });
    const token = m.token.generate();

    await expect(service.validate(token, { userId: 'f-1' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(service.touch(token, { userId: 'f-1' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(service.rotate(token, { userId: 'f-1' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(
      service.update(token, { metadata: { x: 1 } }, { userId: 'f-1' }),
    ).rejects.toBeInstanceOf(SessionStorageError);
    await expect(service.destroy(token, { userId: 'f-1' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(service.revoke(token, { userId: 'f-1' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(service.create({ userId: 'f-1' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(service.findByUser('f-1')).rejects.toBeInstanceOf(SessionStorageError);
  });

  gated('circuit breaker opens and fast-fails with circuit_open', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 2,
        resetTimeoutMs: 1000,
        halfOpenMaxRequests: 1,
      },
    });
    expect(m.circuitBreaker).not.toBeNull();
    const service = new SessionService({
      config: m.config,
      client: client!,
      repository: failingRepository(),
      token: m.token,
      keys: m.keys,
      metrics: m.metrics,
      health: m.health,
      ...(m.circuitBreaker !== null ? { circuitBreaker: m.circuitBreaker } : {}),
    });

    // Two consecutive infra failures trip the breaker.
    await expect(service.validate(m.token.generate(), { userId: 'f-2' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    await expect(service.validate(m.token.generate(), { userId: 'f-2' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    expect(m.circuitBreaker!.state).toBe('open');

    // While open: fail fast, no repository call, circuit_open reason.
    const fast = await service.validate(m.token.generate(), { userId: 'f-2' }).catch((e) => e);
    expect(fast).toBeInstanceOf(SessionStorageError);
    expect(fast.details).toMatchObject({ reason: 'circuit_open' });

    // After the reset window, the next call probes (half-open) and the
    // failing probe re-opens the circuit.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(service.validate(m.token.generate(), { userId: 'f-2' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
    expect(m.circuitBreaker!.state).toBe('open');
  });

  gated('breaker counts only storage failures, not invalid outcomes', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      circuitBreaker: {
        enabled: true,
        failureThreshold: 2,
        resetTimeoutMs: 30_000,
        halfOpenMaxRequests: 1,
      },
    });
    const service = new SessionService({
      config: m.config,
      client: client!,
      repository: failingRepository(),
      token: m.token,
      keys: m.keys,
      metrics: m.metrics,
      health: m.health,
      ...(m.circuitBreaker !== null ? { circuitBreaker: m.circuitBreaker } : {}),
    });

    // Invalid-token results are outcomes, not failures: breaker untouched.
    expect(await service.validate('nope', { userId: 'f-3' })).toEqual({
      valid: false,
      reason: 'invalid',
    });
    expect(m.circuitBreaker!.state).toBe('closed');
  });

  gated('repeated business errors never open the breaker', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      jtiIndex: { enabled: true },
      circuitBreaker: {
        enabled: true,
        failureThreshold: 2,
        resetTimeoutMs: 30_000,
        halfOpenMaxRequests: 1,
      },
    });
    const created = await m.service.create({ userId: 'f-3b' });
    await m.service.rotate(created.token); // consume the session

    // Attacker/buggy-caller churn: rotate/update on a consumed session throw
    // business errors far past the failure threshold.
    for (let i = 0; i < 6; i++) {
      await expect(m.service.rotate(created.token)).rejects.toThrow(SessionRevokedError);
      await expect(
        m.service.update(created.token, { metadata: { i } }, { userId: 'f-3b' }),
      ).rejects.toThrow(SessionConcurrencyError);
    }

    // The breaker must still be closed and the subsystem fully functional.
    expect(m.circuitBreaker!.state).toBe('closed');
    const fresh = await m.service.create({ userId: 'f-3b' });
    expect((await m.service.validate(fresh.token)).valid).toBe(true);
  });

  gated('revocation store read failure is fail-closed (503, not "valid")', async () => {
    // Dedicated client + manager so closing the connection cannot affect
    // the rest of the suite.
    const c = new RedisClientWrapper({ ...testClientConfig(), maxRetries: 1, connectionTimeout: 1000 });
    try {
      await c.raw.ping();
    } catch {
      return; // Redis unavailable: skip.
    }
    const m = freshManager(
      c,
      PREFIX,
      { touchInterval: 1, checkRevocationStore: true },
      { revocationStore: true },
    );
    const created = await m.service.create({ userId: 'f-4' });
    expect((await m.service.validate(created.token, { userId: 'f-4' })).valid).toBe(true);

    // Break the store by closing the underlying connection: isRevoked must
    // reject (fail closed), so validate must surface 503, never "valid".
    await c.raw.quit();
    await expect(m.service.validate(created.token, { userId: 'f-4' })).rejects.toBeInstanceOf(
      SessionStorageError,
    );
  });

  gated('revocation store rejects on closed connection with RevocationError', async () => {
    const c = new RedisClientWrapper({ ...testClientConfig(), maxRetries: 1, connectionTimeout: 1000 });
    try {
      await c.raw.ping();
    } catch {
      return; // Redis unavailable: skip.
    }
    const store = new RedisRevocationStore({ client: c, keyPrefix: `${PREFIX}-dead:revoked:` });
    await c.raw.quit();

    await expect(store.isRevoked('jti-anything')).rejects.toBeInstanceOf(RevocationError);
    await expect(store.revoke({ jti: 'jti-anything', reason: 'x', expiresAt: 0 })).rejects.toBeInstanceOf(
      RevocationError,
    );
  });

  gated('metadata too large is rejected before any write', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    await expect(
      m.service.create({ userId: 'f-5', metadata: { blob: 'x'.repeat(5000) } }),
    ).rejects.toMatchObject({ name: 'SessionInvalidError' });
  });

  gated('cyclic metadata is rejected as invalid input, not a 503', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const cyclic: Record<string, unknown> = { self: null };
    cyclic.self = cyclic;

    await expect(m.service.create({ userId: 'f-5b', metadata: cyclic })).rejects.toMatchObject({
      name: 'SessionInvalidError',
      details: { reason: 'metadata_cyclic' },
    });

    const created = await m.service.create({ userId: 'f-5b', metadata: { ok: 1 } });
    await expect(
      m.service.update(created.token, { metadata: cyclic }, { userId: 'f-5b' }),
    ).rejects.toMatchObject({
      name: 'SessionInvalidError',
      details: { reason: 'metadata_cyclic' },
    });
  });
});