import { beforeAll, describe, expect, it } from 'vitest';

import { RedisRevocationStore } from '../../src/session/revocation-store.js';
import {
  RevocationError,
  SessionConcurrencyError,
  SessionNotFoundError,
} from '../../src/session/session-errors.js';
import { connectSuite, freshManager, invalidReason, suiteGuard } from './helpers.js';

const PREFIX = "t-session";

let client: Awaited<ReturnType<typeof connectSuite>>;
let ready = false;

// Gates a test on Redis availability at runtime (runIf evaluates too early).
const gated = (title: string, fn: () => Promise<void>) =>
  it(title, async () => {
    if (!ready) return; // Redis unavailable: skip silently.
    await fn();
  });

describe('session lifecycle (real Redis)', () => {
  beforeAll(async () => {
    client = await connectSuite(PREFIX);
    ready = suiteGuard(client);
  });

  gated('create -> validate -> touch -> destroy', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-1', metadata: { plan: 'pro' } });

    let v = await m.service.validate(created.token, { userId: 'u-1' });
    expect(v.valid).toBe(true);
    if (v.valid) {
      expect(v.session.metadata).toEqual({ plan: 'pro' });
    }

    expect(await m.service.touch(created.token, { userId: 'u-1', force: true })).toBe('touched');
    expect(await m.service.destroy(created.token, { userId: 'u-1' })).toBe(true);
    expect(await m.service.destroy(created.token, { userId: 'u-1' })).toBe(false);
    v = await m.service.validate(created.token, { userId: 'u-1' });
    expect(v).toEqual({ valid: false, reason: 'not_found' });
  });

  gated('rotate invalidates the old token and issues a successor', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-2' });

    const rotated = await m.service.rotate(created.token, { userId: 'u-2' });
    expect(rotated.replayed).toBe(false);
    expect(rotated.token).toBeDefined();

    const old = await m.service.validate(created.token, { userId: 'u-2' });
    expect(old.valid).toBe(false);
    expect(invalidReason(old)).toBe('invalid'); // consumed

    const fresh = await m.service.validate(rotated.token!, { userId: 'u-2' });
    expect(fresh.valid).toBe(true);
  });

  gated('retry-safe rotation replay', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-3' });
    const nonce = 'nonce-abcdef0123456789';

    const first = await m.service.rotate(created.token, { userId: 'u-3', rotationNonce: nonce });
    const retry = await m.service.rotate(created.token, { userId: 'u-3', rotationNonce: nonce });

    expect(retry.replayed).toBe(true);
    expect(retry.token).toBeUndefined();
    expect(retry.session.jti).toBe(first.session.jti);
  });

  gated('replay without the right nonce is rejected', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-4' });
    await m.service.rotate(created.token, { userId: 'u-4', rotationNonce: 'nonce-a' });
    await expect(
      m.service.rotate(created.token, { userId: 'u-4', rotationNonce: 'nonce-b' }),
    ).rejects.toMatchObject({ name: 'SessionRevokedError' });
  });

  gated('update bumps the version; stale CAS conflicts', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-5' });

    const updated = await m.service.update(
      created.token,
      { deviceId: 'dev-1' },
      { userId: 'u-5', expectedVersion: 1 },
    );
    expect(updated.version).toBe(2);

    await expect(
      m.service.update(created.token, { deviceId: 'dev-2' }, { userId: 'u-5', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(SessionConcurrencyError);

    const ok = await m.service.update(
      created.token,
      { deviceId: 'dev-2' },
      { userId: 'u-5', expectedVersion: 2 },
    );
    expect(ok.deviceId).toBe('dev-2');
  });

  gated('list and deleteByUser', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      tokens.push((await m.service.create({ userId: 'u-6' })).token);
    }

    const all = await m.service.findByUser('u-6');
    expect(all.length).toBe(5);
    expect(all.every((s) => s.status === 'active')).toBe(true);

    // destroy one: it disappears from the list and the index self-heals
    await m.service.destroy(tokens[0]!, { userId: 'u-6' });
    expect((await m.service.findByUser('u-6')).length).toBe(4);

    const deleted = await m.service.deleteByUser('u-6');
    expect(deleted.length).toBe(4);
    expect(await m.service.findByUser('u-6')).toEqual([]);
  });

  gated('security version invalidates older sessions', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      securityVersion: { enabled: true },
    });
    const older = await m.service.create({ userId: 'u-7' });
    const newer = await m.service.create({ userId: 'u-7' });

    expect((await m.service.validate(older.token, { userId: 'u-7' })).valid).toBe(true);

    await m.service.setSecurityVersion('u-7', 7);
    expect((await m.service.validate(older.token, { userId: 'u-7' })).valid).toBe(false);
    expect((await m.service.validate(newer.token, { userId: 'u-7' })).valid).toBe(false);

    // sessions created after the bump are valid again
    const latest = await m.service.create({ userId: 'u-7' });
    expect((await m.service.validate(latest.token, { userId: 'u-7' })).valid).toBe(true);
  });

  gated('idempotent create returns the same session', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      enableCreateIdempotency: true,
    });
    const key = 'idem-key-1111111111';

    const c1 = await m.service.create({ userId: 'u-8', idempotencyKey: key });
    const c2 = await m.service.create({ userId: 'u-8', idempotencyKey: key });

    expect(c2.replayed).toBe(true);
    expect(c2.session.jti).toBe(c1.session.jti);
    expect((await m.service.validate(c2.token, { userId: 'u-8' })).valid).toBe(true);
  });

  gated('idempotency claim expires with the claim TTL (bounded replay window)', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      ttl: 1,
      idleTimeout: null,
      enableCreateIdempotency: true,
    });
    const key = 'idem-key-2222222222';

    const c1 = await m.service.create({ userId: 'u-8b', idempotencyKey: key });
    await new Promise((resolve) => setTimeout(resolve, 1300));

    // Claim TTL (min(60, ttl)) expired: the same key now creates a fresh
    // session instead of replaying indefinitely.
    const c2 = await m.service.create({ userId: 'u-8b', idempotencyKey: key });
    expect(c2.replayed).toBeUndefined();
    // jti is hash(key) by design, but the record is a fresh one.
    expect(c2.session.jti).toBe(c1.session.jti);
    expect(c2.session.createdAt).toBeGreaterThan(c1.session.createdAt);
    expect((await m.service.validate(c2.token, { userId: 'u-8b' })).valid).toBe(true);
  });

  gated('binding policy: strict rejects, advisory reports', async () => {
    const strict = freshManager(client!, PREFIX, {
      touchInterval: 1,
      storeIpAddress: true,
      bindingPolicy: 'strict',
    });
    const created = await strict.service.create({ userId: 'u-9', ipAddress: '10.1.2.3' });

    expect(
      (await strict.service.validate(created.token, { userId: 'u-9', ipAddress: '10.1.2.3' }))
        .valid,
    ).toBe(true);
    const mismatch = await strict.service.validate(created.token, {
      userId: 'u-9',
      ipAddress: '10.9.9.9',
    });
    expect(mismatch).toEqual({ valid: false, reason: 'binding_mismatch' });

    const advisory = freshManager(client!, PREFIX, {
      touchInterval: 1,
      storeIpAddress: true,
      bindingPolicy: 'advisory',
    });
    const created2 = await advisory.service.create({ userId: 'u-10', ipAddress: '10.1.2.3' });
    const result = await advisory.service.validate(created2.token, {
      userId: 'u-10',
      ipAddress: '10.9.9.9',
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.binding).toEqual({ ipAddress: true, userAgent: false, deviceId: false });
    }
  });

  gated('jti-index lookup without userId', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1, jtiIndex: { enabled: true } });
    const created = await m.service.create({ userId: 'u-11' });

    expect((await m.service.validate(created.token)).valid).toBe(true);
    await m.service.rotate(created.token, { rotationNonce: 'nonce-1' });
    const fresh = await m.service.rotate(created.token, { rotationNonce: 'nonce-1' });
    expect(fresh.replayed).toBe(true);
  });

  gated('revocation store: revoke, check, fail-closed validation', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      { touchInterval: 1, checkRevocationStore: true },
      { revocationStore: true },
    );
    const store = new RedisRevocationStore({
      client: client!,
      keyPrefix: `${m.config.namespace}:revoked:`,
    });
    const created = await m.service.create({ userId: 'u-12' });
    expect((await m.service.validate(created.token, { userId: 'u-12' })).valid).toBe(true);

    // direct store revocation
    await store.revoke({
      jti: m.token.hash(created.token),
      reason: 'external',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const v = await m.service.validate(created.token, { userId: 'u-12' });
    expect(v).toEqual({ valid: false, reason: 'revoked' });

    await expect(
      store.revoke({ jti: 'x', reason: 'bad', expiresAt: Math.floor(Date.now() / 1000) - 10 }),
    ).rejects.toBeInstanceOf(RevocationError);
    expect(await store.isRevoked('x')).toBe(false);

    // revokeMany groups by slot
    await store.revokeMany([
      { jti: 'a'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 60 },
      { jti: 'b'.repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 60 },
    ]);
    const revoked = await store.isRevokedMany(['a'.repeat(43), 'c'.repeat(43)]);
    expect(revoked.has('a'.repeat(43))).toBe(true);
    expect(revoked.has('c'.repeat(43))).toBe(false);
  });

  gated('session.revoke keeps a tombstone; destroy removes it', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-13' });

    expect(await m.service.revoke(created.token, { userId: 'u-13' })).toBe('revoked');
    expect(await m.service.revoke(created.token, { userId: 'u-13' })).toBe('already_revoked');
    const v = await m.service.validate(created.token, { userId: 'u-13' });
    expect(invalidReason(v)).toBe('revoked');
    expect(await m.service.destroy(created.token, { userId: 'u-13' })).toBe(true);
  });

  gated('validate without userId and no jtiIndex is a config error', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'u-14' });
    await expect(m.service.validate(created.token)).rejects.toMatchObject({
      name: 'SessionConfigurationError',
    });
  });

  gated('revokeAll invalidates every session', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const tokens: string[] = [];
    for (let i = 0; i < 3; i++) {
      tokens.push((await m.service.create({ userId: 'u-15' })).token);
    }

    const n = await m.service.revokeAll('u-15');
    expect(n).toBe(3);
    for (const token of tokens) {
      expect((await m.service.validate(token, { userId: 'u-15' })).valid).toBe(false);
    }
  });

  gated('touch throttles inside touchInterval and forces past it', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 60 });
    const created = await m.service.create({ userId: 'u-16' });

    expect(await m.service.touch(created.token, { userId: 'u-16' })).toBe('skipped_throttled');
    expect(await m.service.touch(created.token, { userId: 'u-16', force: true })).toBe('touched');
  });

  gated('missing sessions are not_found without throwing', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const token = m.token.generate();

    expect(await m.service.validate(token, { userId: 'nobody' })).toEqual({
      valid: false,
      reason: 'not_found',
    });
    expect(await m.service.touch(token, { userId: 'nobody' })).toBe('not_found');
    expect(await m.service.destroy(token, { userId: 'nobody' })).toBe(false);
    expect(await m.service.revoke(token, { userId: 'nobody' })).toBe('not_found');
    await expect(m.service.rotate(token, { userId: 'nobody' })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});