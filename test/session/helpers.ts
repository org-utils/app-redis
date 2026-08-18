import { afterAll, beforeAll } from 'vitest';

import { RedisClientWrapper } from '../../src/client.js';
import type { SessionKeyProvider } from '../../src/session/session-encryption.js';
import { RedisRevocationStore } from '../../src/session/revocation-store.js';
import { createSessionManager } from '../../src/session/session-manager.js';
import type { SessionManager } from '../../src/session/session-manager.js';
import type { SessionValidationResult } from '../../src/session/session-types.js';
import { RedisConfig } from '../../src/types.js';

export const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
export const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

type TestClientConfig =  {
  mode?: 'standalone' | 'sentinel' | 'cluster';
  host?: string;
  port?: number;
  clusterNodes?: Array<{ host: string; port: number }>;
  sentinelNodes?: Array<{ host: string; port: number }>;
  sentinelMasterName?: string;
}

/** Builds a client config from the environment (cluster/sentinel overrides). */
// export function testClientConfig(): TestClientConfig {
export function testClientConfig(): RedisConfig {
  const mode = (process.env.REDIS_MODE as TestClientConfig['mode']) ?? 'standalone';
  if (mode === 'cluster') {
    const nodes = (process.env.REDIS_CLUSTER_NODES ?? `${REDIS_HOST}:${REDIS_PORT}`)
      .split(',')
      .map((entry) => {
        const [host, port] = entry.split(':');
        return { host: host ?? REDIS_HOST, port: Number(port ?? REDIS_PORT) };
      });
    return { mode, clusterNodes: nodes };
  }
  if (mode === 'sentinel') {
    const nodes = (process.env.REDIS_SENTINEL_NODES ?? `${REDIS_HOST}:${REDIS_PORT}`)
      .split(',')
      .map((entry) => {
        const [host, port] = entry.split(':');
        return { host: host ?? REDIS_HOST, port: Number(port ?? REDIS_PORT) };
      });
    return {
      mode,
      sentinelNodes: nodes,
      sentinelMasterName: process.env.REDIS_SENTINEL_MASTER ?? 'sessions-master-1',
    };
  }
  return { mode, host: REDIS_HOST, port: REDIS_PORT };
}

/**
 * Connects a suite to real Redis. Returns null when unreachable (suite
 * bodies must bail out). The client is shared and closed once.
 */
export async function connectSuite(namespacePrefix: string): Promise<RedisClientWrapper | null> {
  const client = new RedisClientWrapper({
    ...testClientConfig(),
    maxRetries: 1,
    connectionTimeout: 1000,
  });

  try {
    await client.raw.ping();
  } catch {
    return null;
  }

  beforeAll(() => {
    return client.deletePattern(`${namespacePrefix}:*`);
  });

  afterAll(async () => {
    await client.deletePattern(`${namespacePrefix}:*`);
    await client.close();
  });

  return client;
}

/** Creates a manager on a fresh namespace under the suite's prefix. */
export function freshManager(
  client: RedisClientWrapper,
  suitePrefix: string,
  overrides: Record<string, unknown> = {},
  options: { revocationStore?: boolean; keyProvider?: SessionKeyProvider } = {},
): SessionManager {
  const ns = `${suitePrefix}-${Math.random().toString(36).slice(2, 10)}`;

  const revocationStore = options.revocationStore
    ? new RedisRevocationStore({ client, keyPrefix: `${ns}:revoked:` })
    : undefined;

  return createSessionManager({
    client,
    config: { enabled: true, namespace: ns, ...overrides },
    ...(revocationStore !== undefined ? { revocationStore } : {}),
    ...(options.keyProvider !== undefined ? { encryptionKeyProvider: options.keyProvider } : {}),
  });
}

/** Asserts the suite can run (skips cleanly when Redis is absent). */
export function suiteGuard(client: RedisClientWrapper | null): client is RedisClientWrapper {
  if (client === null) {
    return false;
  }
  return true;
}

/** Narrows a validation result: the invalid reason, or null when valid. */
export function invalidReason(result: SessionValidationResult): string | null {
  return result.valid ? null : result.reason;
}
