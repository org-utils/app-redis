import type { RevocationRecord, RevocationStore } from './session-types.js';

import type { RedisClientWrapper } from '../client.js';
import { RevocationError, RevocationBatchError, redactIdentifier } from './session-errors.js';

export interface RedisRevocationStoreOptions {
  /**
   * Redis client.
   *
   * Compatible with:
   * - ioredis standalone
   * - ioredis Sentinel
   * - ioredis Cluster
   */
  client: RedisClientWrapper;

  /**
   * Key prefix, so multiple apps can share a Redis instance safely.
   * Default: `authcore:revoked:`.
   *
   * @example
   * ```ts
   * new RedisRevocationStore({ client, keyPrefix: 'auth:revoked:' });
   * ```
   */
  keyPrefix?: string;
}

/**
 * Redis-backed revocation store. Each revoked jti is stored as
 * `{prefix}{jti} -> reason`, with the Redis key TTL itself set to the
 * token's remaining lifetime — expired entries are reclaimed automatically
 * by Redis, no sweep job required.
 *
 * Every operation here is a single-key command, so this store works
 * identically on standalone, Sentinel, and Cluster with no hash tags
 * required (unlike the session store, there's no multi-key atomicity
 * requirement to satisfy).
 *
 * Batched operations (`revokeMany`, `isRevokedMany`) group their commands
 * by hash slot and issue one pipeline per slot, so they never trigger
 * `CROSSSLOT` errors on Redis Cluster. Pipeline failures are surfaced via
 * {@link RevocationBatchError} instead of being silently swallowed —
 * a missed revocation is a security bug.
 *
 * Validation fails fast and typed: invalid records throw
 * {@link RevocationError} before any network call, and reads fail closed
 * (an infra error is never treated as "not revoked").
 *
 * @example
 * ```ts
 * const revocations = new RedisRevocationStore({ client });
 *
 * await revocations.revoke({
 *   jti: 'a1b2c3d4',
 *   reason: 'password-change',
 *   expiresAt: Math.floor(Date.now() / 1000) + 3600,
 * });
 *
 * if (await revocations.isRevoked('a1b2c3d4')) {
 *   // token was rotated or revoked - reject it
 * }
 * ```
 */
export class RedisRevocationStore implements RevocationStore {
  private readonly client: RedisClientWrapper;
  private readonly keyPrefix: string;

  /**
   * Creates a Redis-backed revocation store.
   *
   * @param options - Client connection and key-prefix configuration.
   *
   * @example
   * ```ts
   * const store = new RedisRevocationStore({
   *   client,
   *   keyPrefix: 'myapp:revoked:',
   * });
   * ```
   */
  constructor(options: RedisRevocationStoreOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? 'authcore:revoked:';
  }

  /* ------------------------------------------------------------------------ */
  /* Revoke                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Marks a jti as revoked for the remainder of its lifetime.
   *
   * Stores `{prefix}{jti} -> reason` with a Redis TTL equal to the
   * record's remaining lifetime (`expiresAt - now`), so the entry is
   * garbage-collected automatically once the original token would have
   * expired anyway. Overwriting an existing entry extends/refreshes its
   * TTL to the new expiry.
   *
   * @param record - The revocation entry (`jti`, `expiresAt`, optional
   *   `reason`). `expiresAt` must be a finite Unix-seconds timestamp in
   *   the future.
   * @throws {RevocationError} when `record.expiresAt` is missing, not a
   *   finite number, or not in the future (fails fast instead of sending
   *   an invalid `EX` to Redis).
   *
   * @example
   * ```ts
   * await revocations.revoke({
   *   jti: 'a1b2c3d4',
   *   reason: 'logout',
   *   expiresAt: Math.floor(Date.now() / 1000) + 86400,
   * });
   * ```
   */
  async revoke(record: RevocationRecord): Promise<void> {
    const ttl = computeTtl(record);

    try {
      await this.client.set(this.key(record.jti), record.reason ?? '1', ttl);
    } catch (error) {
      throw wrapStorageError(error, { jti: record.jti });
    }
  }

  /**
   * Revokes many jtis in one batched call.
   *
   * All records are validated up front — an invalid `expiresAt` fails
   * before any network call is issued, rather than partway through a
   * batch. Commands are grouped by hash slot (one pipeline per slot) so
   * the batch stays Cluster-safe, and every pipeline result is inspected:
   * any failed command throws {@link RevocationBatchError} listing the
   * affected jtis, because a silently-missed revocation is a security bug.
   *
   * @param records - The revocation entries to create/refresh.
   * @throws {RevocationError} when any record is invalid (validation is
   *   all-or-nothing, before any network call).
   * @throws {RevocationBatchError} when one or more pipeline commands
   *   fail; carries the exact jtis that were not revoked.
   *
   * @example
   * ```ts
   * await revocations.revokeMany([
   *   { jti: 'a1', reason: 'logout-all', expiresAt: expiry },
   *   { jti: 'b2', reason: 'logout-all', expiresAt: expiry },
   * ]);
   * ```
   */
  async revokeMany(records: RevocationRecord[]): Promise<void> {
    if (records.length === 0) return;

    // Validate every record up front - fail before issuing any network
    // calls rather than partway through a batch.
    const ttls = records.map((record) => computeTtl(record));

    // Group by hash slot: the jti keys are not hash-tagged, so they may
    // scatter across Cluster slots. One pipeline per slot avoids
    // CROSSSLOT errors.
    const groups = new Map<number, Array<{ jti: string; value: string; ttl: number }>>();

    for (let i = 0; i < records.length; i++) {
      const record = records[i]!;
      const key = this.key(record.jti);
      const slot = this.client.calculateSlot(key);

      const entry = { jti: record.jti, value: record.reason ?? '1', ttl: ttls[i]! };
      const group = groups.get(slot);
      if (group) {
        group.push(entry);
      } else {
        groups.set(slot, [entry]);
      }
    }

    const failures: { jti: string; error: unknown }[] = [];

    for (const entries of groups.values()) {
      const pipeline = this.client.pipeline();

      for (const entry of entries) {
        pipeline.set(this.key(entry.jti), entry.value, 'EX', entry.ttl);
      }

      const results = await pipeline.exec();

      // pipeline.exec() resolves to [error, result][] - a failed command
      // does NOT reject the pipeline promise. Check every result.
      for (let i = 0; i < entries.length; i++) {
        const result = results?.[i];
        const error = Array.isArray(result) ? result[0] : undefined;

        if (error) {
          failures.push({ jti: entries[i]!.jti, error });
        }
      }
    }

    if (failures.length > 0) {
      throw new RevocationBatchError(failures);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Check                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Checks whether a jti is currently revoked.
   *
   * Fail-closed: infrastructure errors are wrapped in a typed error and
   * must NOT be treated as "not revoked".
   *
   * @param jti - The token/session id to check.
   * @returns `true` when the jti has a live revocation entry.
   * @throws {RevocationError} when the check itself fails (caller must
   *   treat the outcome as unknown).
   *
   * @example
   * ```ts
   * if (await revocations.isRevoked(token.jti)) {
   *   return 401; // token was rotated away or explicitly revoked
   * }
   * ```
   */
  async isRevoked(jti: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(this.key(jti));
      return exists === 1;
    } catch (error) {
      throw wrapStorageError(error, { jti });
    }
  }

  /**
   * Batched revocation check - one network round trip instead of N.
   *
   * Useful for validating a whole family of rotated tokens, or a batch
   * of refresh attempts, at once. Commands are grouped by hash slot
   * (one pipeline per slot) to stay Cluster-safe, and the check fails
   * closed: if any command errors, {@link RevocationBatchError} is thrown
   * rather than silently treating the jti as "not revoked".
   *
   * @param jtis - The token/session ids to check.
   * @returns A `Set` containing exactly the revoked jtis.
   * @throws {RevocationBatchError} when a pipeline command fails -
   *   the caller must treat the outcome as unknown, not as "valid".
   *
   * @example
   * ```ts
   * const revoked = await revocations.isRevokedMany(['a1', 'b2', 'c3']);
   * if (revoked.has('b2')) {
   *   // b2 must not be accepted
   * }
   * ```
   */
  async isRevokedMany(jtis: string[]): Promise<Set<string>> {
    if (jtis.length === 0) return new Set();

    const groups = new Map<number, string[]>();

    for (const jti of jtis) {
      const key = this.key(jti);
      const slot = this.client.calculateSlot(key);

      const group = groups.get(slot);
      if (group) {
        group.push(jti);
      } else {
        groups.set(slot, [jti]);
      }
    }

    const revoked = new Set<string>();

    for (const groupJtis of groups.values()) {
      const pipeline = this.client.pipeline();

      for (const jti of groupJtis) {
        pipeline.exists(this.key(jti));
      }

      const results = await pipeline.exec();

      for (let i = 0; i < groupJtis.length; i++) {
        const result = results?.[i];
        const error = Array.isArray(result) ? result[0] : undefined;
        const value = Array.isArray(result) ? result[1] : undefined;

        if (error) {
          // Fail closed: if we can't confirm a jti's status, don't silently
          // treat it as "not revoked".
          throw new RevocationBatchError([{ jti: groupJtis[i]!, error }]);
        }

        if (value === 1) {
          revoked.add(groupJtis[i]!);
        }
      }
    }

    return revoked;
  }

  private key(jti: string): string {
    return `${this.keyPrefix}${jti}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Validates and computes the Redis TTL for a revocation record.
 *
 * Throws a typed {@link RevocationError} early with a redacted message
 * instead of letting a malformed `expiresAt` (undefined/NaN/past) turn
 * into `Math.max(1, NaN) === NaN`, which would otherwise reach Redis as
 * an invalid `EX` argument and fail with an opaque "value is not an
 * integer" error deep inside the client.
 *
 * @param record - The revocation record to validate.
 * @param now - Reference timestamp (Unix seconds); overridable for tests.
 * @returns The TTL in seconds, at least 1.
 * @throws {RevocationError} on invalid records.
 */
function computeTtl(record: RevocationRecord, now = nowSeconds()): number {
  const safe = redactIdentifier(record.jti);

  if (!record.jti || typeof record.jti !== 'string') {
    throw new RevocationError({ reason: 'missing_jti' });
  }

  if (!Number.isFinite(record.expiresAt)) {
    throw new RevocationError({
      reason: 'invalid_expires_at',
      jti: safe,
      detail: 'expiresAt must be a finite number',
    });
  }

  if (record.expiresAt <= now) {
    throw new RevocationError({
      reason: 'expires_at_in_past',
      jti: safe,
      detail: 'expiresAt must be in the future',
    });
  }

  return Math.max(1, record.expiresAt - now);
}

/**
 * Wraps an underlying storage failure in a typed, redacted error so the
 * caller can fail closed without losing the root cause.
 */
function wrapStorageError(error: unknown, context: { jti: string }): RevocationError {
  if (error instanceof RevocationError) return error;
  return new RevocationError({
    reason: 'storage_failure',
    jti: redactIdentifier(context.jti),
    cause: error instanceof Error ? error.message : String(error),
  });
}
