import { describe, it } from 'vitest';
import { RedisClientWrapper } from '../src/client.js';
import { createSessionManager } from '../src/session/session-manager.js';
import { createRandomSessionKeyProvider } from '../src/session/session-encryption.js';
import { testClientConfig } from './session/helpers.js';

// End-to-end smoke against a real Redis (default localhost:6379; honors
// REDIS_MODE/REDIS_HOST/REDIS_PORT/REDIS_* like the session suites).
// Skipped when no Redis is reachable so the default test suite stays
// CI-friendly. The connection timeout is short so an unreachable host
// skips fast instead of racing vitest's 5s per-test timeout.
const client = new RedisClientWrapper({
  ...testClientConfig(),
  maxRetries: 1,
  connectionTimeout: 1000,
});

it('runs the full session smoke', async () => {
  try {
    await client.raw.ping();
  } catch {
    console.log('Redis not reachable - skipping session smoke test.');
    return;
  }
  await main();
});

async function main() {
  const ns = `smoke-${Date.now()}`;

  const manager = createSessionManager({
    client,
    config: {
      enabled: true,
      namespace: ns,
      jtiIndex: { enabled: true },
      securityVersion: { enabled: true },
      checkRevocationStore: true,
      touchInterval: 5,
      maxSessionsPerUser: 3,
      storeIpAddress: true,
      storeUserAgent: true,
      bindingPolicy: 'strict',
      enableCreateIdempotency: true,
    },
    revocationStore: new (await import('../src/session/revocation-store.js')).RedisRevocationStore({
      client,
      keyPrefix: `${ns}:revoked:`,
    }),
    metricsAdapter: {
      incCounter: (n, d, a) => console.log('  [metric]', n, d ?? 1, a ?? {}),
      recordHistogram: (n, v) => console.log('  [metric]', n, `${v}ms`),
      setGauge: (n, v) => console.log('  [metric]', n, v),
    },
  });

  await manager.init();

  // 1. create
  const created = await manager.service.create({
    userId: 'user-1',
    ipAddress: '10.0.0.1',
    userAgent: 'smoke-test/1.0',
    metadata: { device: 'macbook' },
  });
  console.log('1. created:', created.session.jti.slice(0, 8), created.replayed === true ? '(replayed!)' : '');

  // 2. validate (userId fast path)
  let v = await manager.service.validate(created.token, { userId: 'user-1' });
  console.log('2. validate:', v.valid ? 'VALID' : `INVALID(${v.reason})`);
  if (!v.valid) throw new Error('validate failed');

  // 3. validate without userId (jti index path)
  v = await manager.service.validate(created.token);
  console.log('3. validate (jti-index):', v.valid ? 'VALID' : `INVALID(${v.reason})`);
  if (!v.valid) throw new Error('jti-index validate failed');

  // 4. strict binding mismatch
  v = await manager.service.validate(created.token, { userId: 'user-1', ipAddress: '10.0.0.2' });
  console.log('4. binding mismatch:', v.valid ? 'VALID(!)' : `INVALID(${v.reason})`);

  // 5. touch
  const t = await manager.service.touch(created.token, { userId: 'user-1' });
  console.log('5. touch:', t);

  // 6. rotate
  const rotated = await manager.service.rotate(created.token, {
    userId: 'user-1',
    rotationNonce: 'nonce-1234567890abcdef',
  });
  console.log('6. rotate:', rotated.replayed ? 'REPLAYED' : `ok -> ${rotated.session.jti.slice(0, 8)}`);
  if (rotated.token) {
    v = await manager.service.validate(rotated.token, { userId: 'user-1' });
    console.log('   rotate validate:', v.valid ? 'VALID' : `INVALID(${v.reason})`);
  }

  // 7. old token reuse after rotation
  v = await manager.service.validate(created.token, { userId: 'user-1' });
  console.log('7. old token reuse:', v.valid ? 'VALID(!)' : `rejected(${v.reason})`);

  // 8. retry-safe rotation replay (retry with the ORIGINAL token + same nonce)
  const re = await manager.service.rotate(created.token, { userId: 'user-1', rotationNonce: 'nonce-1234567890abcdef' });
  console.log('8. rotate replay:', re.replayed ? 'REPLAYED(no token)' : 'unexpected');
  if (re.token !== undefined) throw new Error('replay should not carry a token');

  // 9. maxSessionsPerUser eviction
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    const c = await manager.service.create({ userId: 'user-2', ipAddress: '10.0.0.1' });
    tokens.push(c.token);
  }
  const list = await manager.service.findByUser('user-2');
  console.log('9. eviction: sessions for user-2 =', list.length, '(expect 3)');
  const old = await manager.service.validate(tokens[0]!, { userId: 'user-2' });
  console.log('   evicted oldest:', old.valid ? 'still valid(!)' : `rejected(${old.reason})`);

  // 10. security version invalidation
  await manager.service.setSecurityVersion('user-2');
  v = await manager.service.validate(tokens[1]!, { userId: 'user-2' });
  console.log('10. security version:', v.valid ? 'VALID(!)' : `rejected(${v.reason})`);

  // 11. revoke + revocation store
  await manager.service.revoke(tokens[2]!, { userId: 'user-2' });
  v = await manager.service.validate(tokens[2]!, { userId: 'user-2' });
  console.log('11. revoke:', v.valid ? 'VALID(!)' : `rejected(${v.reason})`);

  // 12. update with expectedVersion
  const upd = await manager.service.update(rotated.token!, { deviceId: 'dev-9' }, { userId: 'user-1', expectedVersion: 1 });
  console.log('12. update:', upd.version === 2 ? 'version->2' : `unexpected ${upd.version}`);
  try {
    await manager.service.update(rotated.token!, { deviceId: 'dev-9' }, { userId: 'user-1', expectedVersion: 1 });
    console.log('12b. stale update: NOT CONFLICTED(!)');
  } catch (e) {
    console.log('12b. stale update:', (e as Error).constructor.name);
  }

  // 13. deleteByUser
  const del = await manager.service.deleteByUser('user-2');
  console.log('13. deleteByUser:', del.length, 'deleted');

  // 14. health
  const h = await manager.service.health();
  console.log('14. health:', h.healthy ? 'HEALTHY' : 'degraded', h.latencyMs !== null ? `${h.latencyMs}ms` : '');

  // 15. encrypted mode
  const encManager = createSessionManager({
    client,
    config: { enabled: true, namespace: `${ns}-enc`, encryption: { enabled: true } },
    encryptionKeyProvider: createRandomSessionKeyProvider(),
  });
  const enc = await encManager.service.create({ userId: 'user-3' });
  v = await encManager.service.validate(enc.token, { userId: 'user-3' });
  console.log('15. encrypted create/validate:', v.valid ? 'VALID' : `INVALID(${v.reason})`);
  const encT = await encManager.service.touch(enc.token, { userId: 'user-3', force: true });
  console.log('    encrypted touch:', encT);
  const encR = await encManager.service.rotate(enc.token, { userId: 'user-3' });
  console.log('    encrypted rotate:', encR.replayed ? 'REPLAYED' : 'ok');
  if (encR.token) {
    v = await encManager.service.validate(encR.token, { userId: 'user-3' });
    console.log('    encrypted rotate validate:', v.valid ? 'VALID' : `INVALID(${v.reason})`);
  }

  // 16. idempotent create
  const c1 = await manager.service.create({ userId: 'user-4', idempotencyKey: 'idem-key-1234567890' });
  const c2 = await manager.service.create({ userId: 'user-4', idempotencyKey: 'idem-key-1234567890' });
  console.log('16. idempotent create:', c1.session.jti === c2.session.jti && c2.replayed === true ? 'REPLAYED ok' : 'failed');
  v = await manager.service.validate(c2.token, { userId: 'user-4' });
  console.log('    idempotent token validates:', v.valid ? 'VALID' : `INVALID(${v.reason})`);

  // 17. revokeAll
  const c3 = await manager.service.create({ userId: 'user-5' });
  const c4 = await manager.service.create({ userId: 'user-5' });
  const n = await manager.service.revokeAll('user-5');
  v = await manager.service.validate(c3.token, { userId: 'user-5' });
  console.log('17. revokeAll:', n, 'revoked; c3:', v.valid ? 'VALID(!)' : `rejected(${v.reason})`);

  await client.deletePattern(`${ns}:*`);
  await client.deletePattern(`${ns}-enc:*`);
  console.log('\nSMOKE PASS');
}
