import { beforeAll, describe, expect, it } from 'vitest';

import { connectSuite, freshManager, suiteGuard } from './helpers.js';

const PREFIX = 't-perf';

let client: Awaited<ReturnType<typeof connectSuite>>;
let ready = false;

const gated = (title: string, fn: () => Promise<void>) =>
  it(title, async () => {
    if (!ready) return;
    await fn();
  });

describe('session performance (real Redis)', () => {
  beforeAll(async () => {
    client = await connectSuite(PREFIX);
    ready = suiteGuard(client);
  });

  gated('create + validate + destroy loop stays linear (no pathological blowup)', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      maxSessionsPerUser: 1000,
    });
    const userId = 'perf-1';
    const N = 200;

    const started = performance.now();
    const tokens: string[] = [];
    for (let i = 0; i < N; i++) {
      const created = await m.service.create({ userId });
      tokens.push(created.token);
    }
    const createMs = performance.now() - started;

    const validateStarted = performance.now();
    for (const token of tokens) {
      const result = await m.service.validate(token, { userId });
      if (!result.valid) throw new Error(`session ${result.reason} during perf run`);
    }
    const validateMs = performance.now() - validateStarted;

    const destroyStarted = performance.now();
    for (const token of tokens) {
      await m.service.destroy(token, { userId });
    }
    const destroyMs = performance.now() - destroyStarted;

    // Generous regression bounds (loopback/docker latencies vary widely):
    // the point is to catch quadratic behaviour, not micro-benchmark.
    expect(createMs / N).toBeLessThan(250);
    expect(validateMs / N).toBeLessThan(250);
    expect(destroyMs / N).toBeLessThan(250);
  });

  gated('user index stays bounded under churn (eviction + list remain linear)', async () => {
    const m = freshManager(client!, PREFIX, {
      touchInterval: 1,
      maxSessionsPerUser: 20,
    });
    const userId = 'perf-2';
    const N = 300;

    const started = performance.now();
    for (let i = 0; i < N; i++) {
      await m.service.create({ userId });
    }
    const churnMs = performance.now() - started;

    const sessions = await m.service.findByUser(userId);
    expect(sessions.length).toBe(20);

    // 300 creates under a 20-session ceiling: each create evicts at most
    // ~19 records; the per-create work must stay flat, not grow with N.
    expect(churnMs / N).toBeLessThan(250);
  });
});