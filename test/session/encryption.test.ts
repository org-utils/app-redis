import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { createSessionManager } from '../../src/session/session-manager.js';
import {
  createRandomSessionKeyProvider,
  StaticSessionKeyProvider,
} from '../../src/session/session-encryption.js';
import type { SessionKeyProvider } from '../../src/session/session-encryption.js';
import { connectSuite, freshManager, invalidReason, suiteGuard } from './helpers.js';

const PREFIX = 't-encryption';

let client: Awaited<ReturnType<typeof connectSuite>>;
let ready = false;

const gated = (title: string, fn: () => Promise<void>) =>
  it(title, async () => {
    if (!ready) return;
    await fn();
  });

/** Manager factory with a shared namespace (for cross-manager reads). */
function managerWith(client: Awaited<ReturnType<typeof connectSuite>>, ns: string, keyProvider: SessionKeyProvider) {
  return createSessionManager({
    client: client!,
    config: {
      enabled: true,
      namespace: ns,
      touchInterval: 1,
      storeIpAddress: true,
      encryption: { enabled: true },
    },
    encryptionKeyProvider: keyProvider,
  });
}

describe('encrypted sessions (real Redis)', () => {
  beforeAll(async () => {
    client = await connectSuite(PREFIX);
    ready = suiteGuard(client);
  });

  gated('encrypted lifecycle: create, validate, touch, rotate, update, destroy', async () => {
    const keyProvider = createRandomSessionKeyProvider(1);
    const ns = `${PREFIX}-life-${Math.random().toString(36).slice(2, 10)}`;
    const m = managerWith(client, ns, keyProvider);

    const created = await m.service.create({
      userId: 'eu-1',
      metadata: { plan: 'pro', tags: ['a', 'b'] },
      ipAddress: '10.1.2.3',
    });
    expect(created.session.jti).toBeDefined();

    // The stored record is an opaque v2 envelope; no plaintext fields leak.
    const raw = await client!.get(`${ns}:session:{eu-1}:session:${created.session.jti}`);
    expect(raw).not.toBeNull();
    const envelope = JSON.parse(raw!) as Record<string, unknown>;
    expect(envelope.v).toBe(2);
    expect(envelope.e).toBe(1);
    expect(typeof envelope.c).toBe('string');
    expect(JSON.stringify(envelope)).not.toContain('pro');
    expect(JSON.stringify(envelope)).not.toContain('eu-1');

    let v = await m.service.validate(created.token, { userId: 'eu-1' });
    expect(v.valid).toBe(true);
    if (v.valid) {
      expect(v.session.metadata).toEqual({ plan: 'pro', tags: ['a', 'b'] });
      expect(v.session.ipAddress).toBe('10.1.2.3');
    }

    expect(await m.service.touch(created.token, { userId: 'eu-1', force: true })).toBe('touched');

    const rotated = await m.service.rotate(created.token, { userId: 'eu-1' });
    expect(rotated.token).toBeDefined();
    expect((await m.service.validate(rotated.token!, { userId: 'eu-1' })).valid).toBe(true);
    expect((await m.service.validate(created.token, { userId: 'eu-1' })).valid).toBe(false);

    const updated = await m.service.update(
      rotated.token!,
      { metadata: { plan: 'enterprise' } },
      { userId: 'eu-1' },
    );
    expect(updated.metadata).toEqual({ plan: 'enterprise' });

    expect(await m.service.destroy(rotated.token!, { userId: 'eu-1' })).toBe(true);
    expect((await m.service.validate(rotated.token!, { userId: 'eu-1' })).valid).toBe(false);
  });

  gated('encrypted rotation replay with nonce across managers', async () => {
    const keyProvider = createRandomSessionKeyProvider(1);
    const ns = `${PREFIX}-replay-${Math.random().toString(36).slice(2, 10)}`;
    const m = managerWith(client, ns, keyProvider);
    const created = await m.service.create({ userId: 'eu-2' });
    const nonce = 'enc-nonce-1234567890';

    const first = await m.service.rotate(created.token, { userId: 'eu-2', rotationNonce: nonce });
    expect(first.replayed).toBe(false);
    expect(first.token).toBeDefined();

    // A second manager with the same key sees the tombstone and replays.
    const m2 = managerWith(client, ns, keyProvider);
    const retry = await m2.service.rotate(created.token, { userId: 'eu-2', rotationNonce: nonce });
    expect(retry.replayed).toBe(true);
    expect(retry.token).toBeUndefined();
    expect(retry.session.jti).toBe(first.session.jti);

    // The successor token from the first attempt is still authoritative.
    expect((await m2.service.validate(first.token!, { userId: 'eu-2' })).valid).toBe(true);
  });

  gated('encrypted update with expectedVersion CAS', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      { touchInterval: 1, encryption: { enabled: true } },
      { keyProvider: createRandomSessionKeyProvider(1) },
    );
    const created = await m.service.create({ userId: 'eu-3' });
    const before = (await m.service.findByUser('eu-3'))[0]!;

    const updated = await m.service.update(
      created.token,
      { deviceId: 'device-1' },
      { userId: 'eu-3', expectedVersion: before.version },
    );
    expect(updated.deviceId).toBe('device-1');
    expect(updated.version).toBeGreaterThan(before.version);
  });

  gated('every record is encrypted with the current key version', async () => {
    const keys = new StaticSessionKeyProvider(
      new Map([
        [1, randomBytes(32)],
        [2, randomBytes(32)],
      ]),
      2,
    );
    const ns = `${PREFIX}-kver-${Math.random().toString(36).slice(2, 10)}`;
    const m = managerWith(client, ns, keys);

    const a = await m.service.create({ userId: 'eu-4' });
    const b = await m.service.create({ userId: 'eu-4' });

    for (const created of [a, b]) {
      const raw = await client!.get(`${ns}:session:{eu-4}:session:${created.session.jti}`);
      const envelope = JSON.parse(raw!) as Record<string, unknown>;
      expect(envelope.k).toBe(2);
    }

    // Old sessions remain readable while the old key is retained.
    const mOld = managerWith(client, ns, new StaticSessionKeyProvider(new Map([[1, keys.getKey(1)!]]), 1));
    const legacy = await mOld.service.create({ userId: 'eu-4' });
    const raw = await client!.get(`${ns}:session:{eu-4}:session:${legacy.session.jti}`);
    expect((JSON.parse(raw!) as Record<string, unknown>).k).toBe(1);

    expect((await m.service.validate(legacy.token, { userId: 'eu-4' })).valid).toBe(true);
  });

  gated('rotation nonce hash is stored, not the raw nonce', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      { touchInterval: 1, encryption: { enabled: true } },
      { keyProvider: createRandomSessionKeyProvider(1) },
    );
    const created = await m.service.create({ userId: 'eu-5' });
    const nonce = 'super-secret-nonce-value';

    const rotated = await m.service.rotate(created.token, { userId: 'eu-5', rotationNonce: nonce });
    expect(rotated.token).toBeDefined();

    // The nonce never appears in Redis.
    const raw = await client!.get(
      `${m.config.namespace}:session:{eu-5}:session:${rotated.session.jti}`,
    );
    expect(raw).not.toContain(nonce);
    expect(raw).not.toContain('super-secret');
  });

  gated('encrypted + security version: bump invalidates old sessions', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      {
        touchInterval: 1,
        encryption: { enabled: true },
        securityVersion: { enabled: true },
      },
      { keyProvider: createRandomSessionKeyProvider(1) },
    );
    const old = await m.service.create({ userId: 'eu-6' });
    expect((await m.service.validate(old.token, { userId: 'eu-6' })).valid).toBe(true);

    await m.service.setSecurityVersion('eu-6', 2);
    const v = await m.service.validate(old.token, { userId: 'eu-6' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('revoked');

    const fresh = await m.service.create({ userId: 'eu-6' });
    expect((await m.service.validate(fresh.token, { userId: 'eu-6' })).valid).toBe(true);
    expect(await m.service.getSecurityVersion('eu-6')).toBe(2);
  });

  gated('encrypted absolute expiry: v2 branch rejects and cleans the index', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      { touchInterval: 1, ttl: 1, idleTimeout: null, encryption: { enabled: true } },
      { keyProvider: createRandomSessionKeyProvider(1) },
    );
    const created = await m.service.create({ userId: 'eu-7' });
    const key = `${m.config.namespace}:session:{eu-7}:session:${created.session.jti}`;
    const indexKey = `${m.config.namespace}:user-sessions:{eu-7}`;

    expect(await client!.raw.persist(key)).toBe(1);
    expect((await m.service.validate(created.token, { userId: 'eu-7' })).valid).toBe(true);
    expect(await client!.raw.zscore(indexKey, created.session.jti)).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1300));
    const v = await m.service.validate(created.token, { userId: 'eu-7' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('expired');

    // Lazy cleanup removed the record and its index member.
    expect(await client!.get(key)).toBeNull();
    expect(await client!.raw.zscore(indexKey, created.session.jti)).toBeNull();
  });

  gated('encrypted idle timeout: v2 branch rejects and cleans the index', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      {
        touchInterval: 0,
        ttl: 120,
        idleTimeout: 1,
        rolling: false,
        encryption: { enabled: true },
      },
      { keyProvider: createRandomSessionKeyProvider(1) },
    );
    const created = await m.service.create({ userId: 'eu-8' });
    const key = `${m.config.namespace}:session:{eu-8}:session:${created.session.jti}`;
    const indexKey = `${m.config.namespace}:user-sessions:{eu-8}`;

    expect(await m.service.touch(created.token, { userId: 'eu-8', force: true })).toBe('touched');
    await new Promise((resolve) => setTimeout(resolve, 1300));

    const v = await m.service.validate(created.token, { userId: 'eu-8' });
    expect(v.valid).toBe(false);
    expect(invalidReason(v)).toBe('idle_timeout');

    expect(await client!.get(key)).toBeNull();
    expect(await client!.raw.zscore(indexKey, created.session.jti)).toBeNull();
  });

  gated('encrypted CAS: stale expectedVersion conflicts, never overwrites', async () => {
    const m = freshManager(
      client!,
      PREFIX,
      {
        touchInterval: 1,
        encryption: { enabled: true },
      },
      { keyProvider: createRandomSessionKeyProvider(1) },
    );
    const created = await m.service.create({ userId: 'eu-9' });

    const v1 = await m.service.update(
      created.token,
      { metadata: { step: 1 } },
      { userId: 'eu-9', expectedVersion: 1 },
    );
    expect(v1.version).toBe(2);

    // A stale expectedVersion (still 1) must be rejected atomically by the
    // encrypted CAS script — not silently overwrite the newer record.
    await expect(
      m.service.update(created.token, { metadata: { step: 2 } }, { userId: 'eu-9', expectedVersion: 1 }),
    ).rejects.toMatchObject({
      name: 'SessionConcurrencyError',
      details: { reason: 'version_conflict' },
    });

    const after = await m.service.findByUser('eu-9');
    expect(after[0]?.metadata).toEqual({ step: 1 });
  });
});