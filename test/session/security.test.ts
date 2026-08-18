import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { RedisClientWrapper } from '../../src/client.js';
import { createSessionManager } from '../../src/session/session-manager.js';
import type { SessionKeyProvider } from '../../src/session/session-encryption.js';
import { createRandomSessionKeyProvider } from '../../src/session/session-encryption.js';
import { StaticSessionKeyProvider } from '../../src/session/session-encryption.js';
import { REDIS_HOST, REDIS_PORT, connectSuite, freshManager, invalidReason, suiteGuard } from './helpers.js';

const PREFIX = 't-security';

let client: Awaited<ReturnType<typeof connectSuite>>;
let ready = false;

const gated = (title: string, fn: () => Promise<void>) =>
  it(title, async () => {
    if (!ready) return;
    await fn();
  });

describe('session security (real Redis)', () => {
  beforeAll(async () => {
    client = await connectSuite(PREFIX);
    ready = suiteGuard(client);
  });

  gated('rotation replay: same nonce replays, different nonce is invalid', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'su-1' });
    const nonce = 'replay-nonce-0001';

    const first = await m.service.rotate(created.token, { userId: 'su-1', rotationNonce: nonce });
    expect(first.replayed).toBe(false);

    const replay = await m.service.rotate(created.token, { userId: 'su-1', rotationNonce: nonce });
    expect(replay.replayed).toBe(true);
    expect(replay.token).toBeUndefined();
    expect(replay.session.jti).toBe(first.session.jti);

    await expect(
      m.service.rotate(created.token, { userId: 'su-1', rotationNonce: 'other-nonce-002' }),
    ).rejects.toMatchObject({ name: 'SessionRevokedError' });

    // The replay path also consumes without a userId via the jti index.
    const m2 = freshManager(client!, PREFIX, { touchInterval: 1, jtiIndex: { enabled: true } });
    const c2 = await m2.service.create({ userId: 'su-1' });
    await m2.service.rotate(c2.token, { rotationNonce: 'nonce-a' });
    const r2 = await m2.service.rotate(c2.token, { rotationNonce: 'nonce-a' });
    expect(r2.replayed).toBe(true);
  });

  gated('consumed tombstone: old token stays invalid, no resurrection', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'su-2' });
    const rotated = await m.service.rotate(created.token, { userId: 'su-2' });
    expect(rotated.token).toBeDefined();

    for (let i = 0; i < 3; i++) {
      const v = await m.service.validate(created.token, { userId: 'su-2' });
      expect(v.valid).toBe(false);
      expect(invalidReason(v)).toBe('invalid'); // consumed
    }
    const fresh = await m.service.validate(rotated.token!, { userId: 'su-2' });
    expect(fresh.valid).toBe(true);
  });

  gated('tampered plain record is invalid and cleaned up', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({
      userId: 'su-3',
      metadata: { plan: 'pro' },
    });
    const key = `${m.config.namespace}:session:{su-3}:session:${created.session.jti}`;
    const raw = await client!.get(key);
    expect(raw).not.toBeNull();

    const envelope = JSON.parse(raw!) as Record<string, unknown>;
    // Corrupt a field the app-side serializer validates: the record fails
    // closed as invalid and is cleaned up. (v1 plain records carry no MAC;
    // unknown extra keys are tolerated for forward compatibility.)
    envelope.s = { ...(envelope.s as Record<string, unknown>), jti: 'tampered-jti-value' };
    await client!.set(key, JSON.stringify(envelope));

    const v = await m.service.validate(created.token, { userId: 'su-3' });
    expect(v).toEqual({ valid: false, reason: 'invalid' });
    // Tampered records are deleted (fail closed, self-healing).
    expect(await client!.get(key)).toBeNull();
  });

  gated('tampered encrypted record is invalid and cleaned up', async () => {
    const keyProvider = createRandomSessionKeyProvider(1);
    const m = freshManager(
      client!,
      PREFIX,
      { touchInterval: 1, encryption: { enabled: true } },
      { keyProvider },
    );
    const created = await m.service.create({ userId: 'su-4', metadata: { plan: 'pro' } });
    const key = `${m.config.namespace}:session:{su-4}:session:${created.session.jti}`;
    const raw = await client!.get(key);
    expect(raw).not.toBeNull();

    const envelope = JSON.parse(raw!) as Record<string, unknown>;
    const cipher = Buffer.from(String(envelope.c), 'base64');
    cipher[cipher.length - 1] = cipher[cipher.length - 1]! ^ 0xff; // corrupt auth tag
    envelope.c = cipher.toString('base64');
    await client!.set(key, JSON.stringify(envelope));

    const v = await m.service.validate(created.token, { userId: 'su-4' });
    expect(v).toEqual({ valid: false, reason: 'invalid' });
    expect(await client!.get(key)).toBeNull();
  });

  gated('expired session (ttl) is rejected as expired', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1, ttl: 1, idleTimeout: null });
    const created = await m.service.create({ userId: 'su-5' });
    const key = `${m.config.namespace}:session:{su-5}:session:${created.session.jti}`;

    // Remove the Redis TTL so the record outlives its expiry: the script
    // boundary (absolute exp vs TIME) is what rejects it.
    expect(await client!.raw.persist(key)).toBe(1);
    expect((await m.service.validate(created.token, { userId: 'su-5' })).valid).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1300));
    const v = await m.service.validate(created.token, { userId: 'su-5' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('expired');
  });

  gated('idle timeout: touch extends the idle boundary, absence expires', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 0,
      ttl: 120,
      idleTimeout: 1,
      rolling: false,
    });
    const created = await m.service.create({ userId: 'su-6' });

    // Non-rolling sessions keep the key until the absolute expiry; the idle
    // boundary is enforced by the script, so it stays observable.
    expect(await m.service.touch(created.token, { userId: 'su-6', force: true })).toBe('touched');
    expect((await m.service.validate(created.token, { userId: 'su-6' })).valid).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1300));
    const v = await m.service.validate(created.token, { userId: 'su-6' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('idle_timeout');

    // The first read of an idle-expired record cleans it up lazily; the
    // record is gone afterwards.
    expect(await m.service.touch(created.token, { userId: 'su-6', force: true })).toBe(
      'not_found',
    );
    expect(await m.service.validate(created.token, { userId: 'su-6' })).toEqual({
      valid: false,
      reason: 'not_found',
    });
  });

  gated('security version bump invalidates older sessions', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      securityVersion: { enabled: true },
    });
    const old = await m.service.create({ userId: 'su-7' });
    expect((await m.service.validate(old.token, { userId: 'su-7' })).valid).toBe(true);

    await m.service.setSecurityVersion('su-7', 2);
    const v = await m.service.validate(old.token, { userId: 'su-7' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('revoked');

    const fresh = await m.service.create({ userId: 'su-7' });
    expect((await m.service.validate(fresh.token, { userId: 'su-7' })).valid).toBe(true);
    expect(await m.service.getSecurityVersion('su-7')).toBe(2);
  });

  gated('strict binding rejects on IP mismatch', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      storeIpAddress: true,
      bindingPolicy: 'strict',
    });
    const created = await m.service.create({ userId: 'su-8', ipAddress: '10.0.0.1' });

    expect((await m.service.validate(created.token, { userId: 'su-8', ipAddress: '10.0.0.1' })).valid).toBe(true);
    const v = await m.service.validate(created.token, { userId: 'su-8', ipAddress: '10.0.0.2' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('binding_mismatch');
  });

  gated('jti-index entry removal degrades to not_found, never resurrects', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1, jtiIndex: { enabled: true } });
    const created = await m.service.create({ userId: 'su-9' });

    expect((await m.service.validate(created.token)).valid).toBe(true);

    const indexKey = `${m.config.namespace}:jti-index:${created.session.jti}`;
    expect(await client!.del(indexKey)).toBe(1);

    // Without the index entry and without a userId, the session is
    // reported not_found (the index is never authoritative).
    expect(await m.service.validate(created.token)).toEqual({
      valid: false,
      reason: 'not_found',
    });
    // With a userId the record is still authoritative.
    expect((await m.service.validate(created.token, { userId: 'su-9' })).valid).toBe(true);
  });

  gated('expired session removes its stale jti-index entry on lazy cleanup', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      ttl: 1,
      idleTimeout: null,
      jtiIndex: { enabled: true },
    });
    const created = await m.service.create({ userId: 'su-9b' });
    const indexKey = `${m.config.namespace}:jti-index:${created.session.jti}`;
    expect(await client!.get(indexKey)).toBe('su-9b');

    // Outlive the TTL: the record (and its index entry) is lazily deleted
    // when read, so both must outlive the boundary.
    await client!.raw.persist(m.keys.sessionKey('su-9b', created.session.jti));
    await client!.raw.persist(indexKey);
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(await m.service.validate(created.token)).toEqual({
      valid: false,
      reason: 'expired',
    });
    // The record was lazily deleted and the stale index entry removed.
    expect(await client!.get(indexKey)).toBeNull();
  });

  gated('mode mismatch fails closed', async () => {
    const plain = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await plain.service.create({ userId: 'su-10' });

    // An encrypted-mode manager reading the SAME namespace/record cannot
    // decrypt a plain record: the read fails closed as invalid.
    const enc = createSessionManager({
      client: client!,
      config: {
        enabled: true,
        namespace: plain.config.namespace,
        touchInterval: 1,
        encryption: { enabled: true },
      },
      encryptionKeyProvider: createRandomSessionKeyProvider(1),
    });
    const v = await enc.service.validate(created.token, { userId: 'su-10' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('invalid');
  });

  gated('key rotation: old keys keep validating, removed keys invalidate', async () => {
    const k1 = createRandomSessionKeyProvider(1);
    const ns = `${PREFIX}-rot-${Math.random().toString(36).slice(2, 10)}`;
    const make = (keyProvider: SessionKeyProvider) =>
      createSessionManager({
        client: client!,
        config: {
          enabled: true,
          namespace: ns,
          touchInterval: 1,
          encryption: { enabled: true },
        },
        encryptionKeyProvider: keyProvider,
      });

    const m1 = make(k1);
    const old = await m1.service.create({ userId: 'su-11' });

    // Rotate keys: v1 retired, v2 current (both known).
    const rotated = new StaticSessionKeyProvider(
      new Map([
        [1, k1.getKey(1)!],
        [2, randomBytes(32)],
      ]),
      2,
    );
    const m2 = make(rotated);
    expect((await m2.service.validate(old.token, { userId: 'su-11' })).valid).toBe(true);

    const now = await m2.service.create({ userId: 'su-11' });
    const raw = await client!.get(`${ns}:session:{su-11}:session:${now.session.jti}`);
    const envelope = JSON.parse(raw!) as Record<string, unknown>;
    expect(envelope.k).toBe(2);

    // Drop v1: sessions encrypted under it are unrecoverable -> invalid.
    const truncated = new StaticSessionKeyProvider(new Map([[2, rotated.getKey(2)!]]), 2);
    const m3 = make(truncated);
    const v = await m3.service.validate(old.token, { userId: 'su-11' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('invalid');
  });

  gated('idempotency claim is not reusable across users', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      enableCreateIdempotency: true,
    });
    const key = 'idem-cross-user-123';
    const c1 = await m.service.create({ userId: 'su-12', idempotencyKey: key });
    expect(c1.replayed).toBeUndefined();

    // Same key, different user: claims are user-scoped, so no replay.
    const c2 = await m.service.create({ userId: 'su-13', idempotencyKey: key });
    expect(c2.replayed).toBeUndefined();

    // Both sessions are independent and valid in their own namespace.
    // NOTE: the derived jti is hash(key), identical for both users — the
    // caller must use globally unique keys (UUIDs), otherwise derived
    // state (jti index, revocation store) collides across users.
    expect((await m.service.validate(c1.token, { userId: 'su-12' })).valid).toBe(true);
    expect((await m.service.validate(c2.token, { userId: 'su-13' })).valid).toBe(true);
  });
});