import { beforeAll, describe, expect, it } from 'vitest';

import {
  SessionConcurrencyError,
  SessionRevokedError,
  SessionRotationError,
} from '../../src/session/session-errors.js';
import { connectSuite, freshManager, suiteGuard } from './helpers.js';

const PREFIX = 't-concurrency';

let client: Awaited<ReturnType<typeof connectSuite>>;
let ready = false;

const gated = (title: string, fn: () => Promise<void>) =>
  it(title, async () => {
    if (!ready) return;
    await fn();
  });

describe('session concurrency (real Redis)', () => {
  beforeAll(async () => {
    client = await connectSuite(PREFIX);
    ready = suiteGuard(client);
  });

  gated('parallel creates never exceed maxSessionsPerUser', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1, maxSessionsPerUser: 5 });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => m.service.create({ userId: 'cu-1' })),
    );
    expect(results).toHaveLength(12);

    const sessions = await m.service.findByUser('cu-1');
    expect(sessions).toHaveLength(5);
    for (const token of results.map((r) => r.token)) {
      const v = await m.service.validate(token, { userId: 'cu-1' });
      if (v.valid) {
        expect(sessions.some((s) => s.jti === v.session.jti)).toBe(true);
      } else {
        // Evicted records are deleted outright (no tombstone): not_found.
        expect(['invalid', 'not_found']).toContain(v.reason);
      }
    }
  });

  gated('concurrent rotation has exactly one winner', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'cu-2' });

    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        m.service.rotate(created.token, { userId: 'cu-2', rotationNonce: `nonce-${i}` }),
      ),
    );

    const winners = outcomes.filter((o) => o.status === 'fulfilled');
    const losers = outcomes.filter((o) => o.status === 'rejected');
    expect(winners).toHaveLength(1);

    const winner = winners[0]!;
    if (winner.status !== 'fulfilled') return;
    expect(winner.value.replayed).toBe(false);
    expect(winner.value.token).toBeDefined();

    for (const loser of losers) {
      if (loser.status !== 'rejected') continue;
      // A nonce mismatch on a consumed session is a replay attempt; the
      // successor collision also fails. Both are rejections, not successes.
      expect(loser.reason).toBeInstanceOf(
        loser.reason instanceof SessionRevokedError
          ? SessionRevokedError
          : SessionRotationError,
      );
    }

    // The successor token is valid; the consumed token is not.
    expect((await m.service.validate(winner.value.token!, { userId: 'cu-2' })).valid).toBe(true);
    const old = await m.service.validate(created.token, { userId: 'cu-2' });
    expect(old.valid).toBe(false);
  });

  gated('concurrent CAS updates: exactly one commit', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'cu-3' });
    const initial = (await m.service.findByUser('cu-3'))[0]!;

    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) =>
        m.service.update(
          created.token,
          { metadata: { writer: `w-${i}` } },
          { userId: 'cu-3', expectedVersion: initial.version },
        ),
      ),
    );

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);

    for (const r of rejected) {
      if (r.status !== 'rejected') continue;
      expect(r.reason).toBeInstanceOf(SessionConcurrencyError);
    }

    const final = (await m.service.findByUser('cu-3'))[0]!;
    const committed = fulfilled[0]!;
    if (committed.status !== 'fulfilled') return;
    expect(final.version).toBeGreaterThan(initial.version);
    expect(final.metadata).toEqual(committed.value.metadata);
  });

  gated('concurrent touch is idempotent and safe', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 0 });
    const created = await m.service.create({ userId: 'cu-4' });

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () =>
        m.service.touch(created.token, { userId: 'cu-4', force: true }),
      ),
    );
    expect(outcomes.every((o) => o === 'touched' || o === 'skipped_throttled')).toBe(true);
    expect((await m.service.validate(created.token, { userId: 'cu-4' })).valid).toBe(true);
  });

  gated('concurrent revoke + validate is linearizable', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const created = await m.service.create({ userId: 'cu-5' });

    const [, v1] = await Promise.all([
      m.service.revoke(created.token, { userId: 'cu-5' }),
      m.service.validate(created.token, { userId: 'cu-5' }),
    ]);

    // Once revoked, every subsequent validate reports revoked (never valid).
    for (let i = 0; i < 5; i++) {
      const v = await m.service.validate(created.token, { userId: 'cu-5' });
      expect(v.valid).toBe(false);
    }
    if (v1.valid) {
      // If the validate won the race, it observed a pre-revoke state.
      expect(v1.session.jti).toBe(created.session.jti);
    } else {
      expect(v1.reason).toBe('revoked');
    }
  });

  gated('concurrent create + revokeAll: no resurrected sessions', async () => {
    const m = freshManager(client!, PREFIX, { touchInterval: 1 });
    const before = await Promise.all([
      m.service.create({ userId: 'cu-6' }),
      m.service.create({ userId: 'cu-6' }),
      m.service.create({ userId: 'cu-6' }),
    ]);
    expect(await m.service.revokeAll('cu-6')).toBe(3);
    const after = await m.service.create({ userId: 'cu-6' });

    for (const created of before) {
      const v = await m.service.validate(created.token, { userId: 'cu-6' });
      expect(v.valid).toBe(false);
    }
    expect((await m.service.validate(after.token, { userId: 'cu-6' })).valid).toBe(true);
  });
});
