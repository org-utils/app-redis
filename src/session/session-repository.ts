import type { RedisClientWrapper } from '../client.js';
import { chunk, executeBySlot, mapWithConcurrency } from '../cluster.js';
import type { SessionConfig } from './session-config.js';
import {
  SessionConcurrencyError,
  SessionNotFoundError,
  SessionSerializationError,
  SessionStorageError,
  redactIdentifier,
} from './session-errors.js';
import type { SessionKeyProvider } from './session-encryption.js';
import type { SessionKeyStrategy } from './session-keys.js';
import type { SessionScriptRegistry } from './session-scripts.js';
import {
  deserializeSession,
  serializeEncryptedSession,
  serializeSession,
  validateSessionRecord,
} from './session-serializer.js';
import type {
  SessionRecord,
  SessionUpdatePatch,
  TouchOutcome,
} from './session-types.js';

/* -------------------------------------------------------------------------- */
/* SessionRepository: Redis data access for sessions.                          */
/*                                                                             */
/* Responsibilities:                                                           */
/*   - key derivation (via SessionKeyStrategy)                                 */
/*   - serialization/encryption (via SessionSerializer + key provider)         */
/*   - atomic state transitions (via SessionScriptRegistry)                    */
/*   - bounded fan-out for cross-slot cleanup (via executeBySlot)              */
/*                                                                             */
/* The repository contains NO topology branching (isCluster, node selection,   */
/* MOVED/ASK handling). All cluster behavior is provided by RedisClientWrapper */
/* and the cluster.ts primitives.                                              */
/*                                                                             */
/* Time semantics:                                                             */
/*   - state decisions that must be ordered (touch, rotate, expiry) use the    */
/*     Redis server clock inside Lua scripts.                                  */
/*   - TTL arguments are computed from the app clock and clamped; the record's */
/*     absoluteExpiresAt remains authoritative for validity.                   */
/*   - encrypted envelopes carry app-stamped timestamps guarded by script-     */
/*     enforced monotonicity (see docs/architecture.md, "Clock skew").         */
/* -------------------------------------------------------------------------- */

export class SessionRepository {
  private readonly client: RedisClientWrapper;
  private readonly keys: SessionKeyStrategy;
  private readonly config: SessionConfig;
  private readonly scripts: SessionScriptRegistry;
  /** Encryption key provider, or null when encryption is disabled. */
  readonly keyProvider: SessionKeyProvider | null;

  constructor(options: {
    client: RedisClientWrapper;
    keys: SessionKeyStrategy;
    config: SessionConfig;
    scripts: SessionScriptRegistry;
    keyProvider?: SessionKeyProvider | null;
  }) {
    this.client = options.client;
    this.keys = options.keys;
    this.config = options.config;
    this.scripts = options.scripts;
    this.keyProvider = options.keyProvider ?? null;
  }

  /** True when the repository can decrypt stored sessions. */
  hasKeyProvider(): boolean {
    return this.keyProvider !== null;
  }

  private get encrypted(): boolean {
    return this.config.encryption.enabled;
  }

  private get jtiIndexEnabled(): boolean {
    return this.config.jtiIndex.enabled;
  }

  private get maxBatchSize(): number {
    return this.config.limits.maxBatchSize;
  }

  private get maxFanOut(): number {
    return this.config.limits.maxFanOutConcurrency;
  }

  /* ------------------------------------------------------------------------ */
  /* Create                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Stores a session atomically with its user index entry and (bounded)
   * max-session eviction. Returns the outcome; on idempotent replays the
   * claim's jti identifies the pre-existing session.
   */
  async create(
    record: SessionRecord,
    ttl: number,
  ): Promise<{ status: 'created' } | { status: 'replayed'; jti: string }> {
    const key = this.keys.sessionKey(record.userId, record.jti);
    const indexKey = this.keys.userIndexKey(record.userId);

    const serialized = this.encrypted
      ? serializeEncryptedSession(record, this.keyProvider!)
      : serializeSession(record);

    const claimKey = this.keys.createClaimKey(record.userId, record.jti);
    const claimTtl = this.config.enableCreateIdempotency ? Math.min(60, Math.max(1, ttl)) : '';

    const result = await this.scripts.eval(
      'create',
      this.config.enableCreateIdempotency ? 3 : 2,
      key,
      indexKey,
      ...(this.config.enableCreateIdempotency ? [claimKey] : []),
      serialized,
      record.jti,
      String(record.createdAt),
      String(ttl),
      String(this.config.maxSessionsPerUser),
      this.keys.sessionKeyPrefix(record.userId),
      String(this.config.limits.maxEvictionsPerCall),
      String(claimTtl),
    );

    if (Array.isArray(result)) {
      const code = Number(result[0]);
      if (code === 3) {
        const jti = String(result[1] ?? '');
        return { status: 'replayed', jti };
      }
      if (code === 1) {
        return { status: 'created' };
      }
    }

    const code = Number(result);
    if (code === -5) {
      throw new SessionConcurrencyError({ reason: 'jti_collision' });
    }

    throw new SessionStorageError('Session create script returned an unexpected result.', {
      code,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Read paths                                                               */
  /* ------------------------------------------------------------------------ */

  /**
   * Reads and deserializes a session. Returns null when missing.
   * Throws SessionSerializationError when the stored payload is corrupt.
   */
  async get(userId: string, jti: string): Promise<SessionRecord | null> {
    const raw = await this.client.get(this.keys.sessionKey(userId, jti));
    if (raw === null) return null;
    return deserializeSession(raw, this.keyProvider ?? undefined);
  }

  /**
   * Single-round-trip validation read (session + security version).
   * Returns { found: false } for missing records, or the raw envelope plus
   * the current security version for further app-side checks.
   */
  async validateRead(
    userId: string,
    jti: string,
  ): Promise<
    | { found: false }
    | { found: true; raw: string; currentSecurityVersion: number | null }
    | { found: true; code: -1; status: string }
    | { found: true; code: -2 }
    | { found: true; code: -3 }
    | { found: true; code: -4 }
  > {
    const result = await this.scripts.eval(
      'validate',
      3,
      this.keys.sessionKey(userId, jti),
      this.keys.securityVersionKey(userId),
      this.keys.userIndexKey(userId),
      jti,
    );

    if (!Array.isArray(result)) {
      throw new SessionStorageError('Validate script returned an unexpected result.', {
        result: String(result),
      });
    }

    const code = Number(result[0]);

    if (code === 0) {
      // The record is gone: any jti index entry for this jti is stale by
      // definition (the record is authoritative). Remove it best-effort —
      // the not_found outcome is already decided and a failed cleanup must
      // never turn it into a storage error.
      await this.cleanupJtiIndex(jti);
      return { found: false };
    }
    if (code === 1) {
      const raw = result[1];
      const currentVersion =
        result[2] !== undefined && result[2] !== null ? Number(result[2]) : null;
      if (typeof raw !== 'string') {
        throw new SessionSerializationError({ reason: 'validate_raw_missing' });
      }
      return { found: true, raw, currentSecurityVersion: currentVersion };
    }
    if (code === -1) {
      return { found: true, code: -1, status: String(result[1] ?? 'unknown') };
    }
    if (code === -2) {
      await this.cleanupJtiIndex(jti);
      return { found: true, code: -2 };
    }
    if (code === -3) {
      await this.cleanupJtiIndex(jti);
      return { found: true, code: -3 };
    }
    return { found: true, code: -4 };
  }

  /** Best-effort removal of a stale jti index entry (never throws). */
  private async cleanupJtiIndex(jti: string): Promise<void> {
    if (!this.config.jtiIndex.enabled) return;
    try {
      await this.deleteJtiIndex(jti);
    } catch {
      // Swallowed: derived-state hygiene, not an auth decision.
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Touch                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Throttled monotonic activity refresh.
   *
   * Plain sessions: one atomic script (server time). Encrypted sessions:
   * read + decrypt + re-encrypt + atomic CAS (two round trips).
   */
  async touch(userId: string, jti: string, force: boolean): Promise<TouchOutcome> {
    const key = this.keys.sessionKey(userId, jti);
    const interval = String(this.config.touchInterval);
    const idleTimeout = this.config.idleTimeout !== null ? String(this.config.idleTimeout) : '';

    if (!this.encrypted) {
      const result = await this.scripts.eval(
        'touch',
        1,
        key,
        interval,
        idleTimeout,
        force ? '1' : '0',
      );
      const outcome = mapTouchCode(Number(result));
      if (outcome === 'not_found') {
        await this.cleanupJtiIndex(jti);
      }
      return outcome;
    }

    // Encrypted path: read, decrypt, re-encrypt with the current key.
    const raw = await this.client.get(key);
    if (raw === null) {
      await this.cleanupJtiIndex(jti);
      return 'not_found';
    }

    let record: SessionRecord;
    try {
      record = deserializeSession(raw, this.keyProvider!);
    } catch (error) {
      if (error instanceof SessionSerializationError) {
        await this.cleanupJtiIndex(jti);
        return 'not_found';
      }
      throw error;
    }

    if (record.status !== 'active') return 'consumed';

    const now = Math.floor(Date.now() / 1000);
    if (record.absoluteExpiresAt <= now) {
      await this.client.del(key);
      return 'expired';
    }
    if (record.idleExpiresAt !== null && record.idleExpiresAt <= now) {
      return 'idle_expired';
    }
    if (!force && now - record.lastAccessedAt < this.config.touchInterval) {
      return 'skipped_throttled';
    }

    const updated: SessionRecord = {
      ...record,
      lastAccessedAt: now,
      idleExpiresAt:
        this.config.idleTimeout !== null
          ? Math.min(now + this.config.idleTimeout, record.absoluteExpiresAt)
          : record.idleExpiresAt,
    };

    const serialized = serializeEncryptedSession(updated, this.keyProvider!);
    const ttl = Math.max(1, updated.absoluteExpiresAt - now);

    const result = await this.scripts.eval(
      'touchEncrypted',
      1,
      key,
      interval,
      idleTimeout,
      force ? '1' : '0',
      serialized,
      String(now),
      updated.idleExpiresAt !== null ? String(updated.idleExpiresAt) : '',
      String(ttl),
    );

    return mapTouchCode(Number(result));
  }

  /* ------------------------------------------------------------------------ */
  /* Rotate                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Atomic single-use rotation. Returns the successor jti on success.
   *
   * Plain sessions: one script (server time). Encrypted sessions: read +
   * decrypt + build + atomic script (two round trips).
   */
  async rotate(options: {
    userId: string;
    oldJti: string;
    successor: SessionRecord;
    expectedVersion?: number;
    rotationNonceHash?: string;
    retainTombstone: boolean;
  }): Promise<{ code: number; successorJti?: string; status?: string }> {
    const { userId, oldJti, successor } = options;
    const oldKey = this.keys.sessionKey(userId, oldJti);
    const newKey = this.keys.sessionKey(userId, successor.jti);
    const indexKey = this.keys.userIndexKey(userId);

    const expected = options.expectedVersion !== undefined ? String(options.expectedVersion) : '';
    const nonce = options.rotationNonceHash ?? '';
    const retain = options.retainTombstone ? '1' : '0';

    if (!this.encrypted) {
      const serialized = serializeSession(successor);
      const result = await this.scripts.eval(
        'rotate',
        3,
        oldKey,
        newKey,
        indexKey,
        serialized,
        successor.jti,
        expected,
        nonce,
        retain,
        oldJti,
      );

      const outcome = parseRotateResult(result, successor.jti);
      if (outcome.code === 0) {
        await this.cleanupJtiIndex(oldJti);
      }
      return outcome;
    }

    // Encrypted path.
    const raw = await this.client.get(oldKey);
    if (raw === null) {
      await this.cleanupJtiIndex(oldJti);
      return { code: 0 };
    }

    let current: SessionRecord;
    try {
      current = deserializeSession(raw, this.keyProvider!);
    } catch (error) {
      if (error instanceof SessionSerializationError) {
        return { code: 3 };
      }
      throw error;
    }

    if (current.status !== 'active') {
      // Retry-safe replay: the stored rotatedTo jti is authoritative; the
      // retry's freshly generated successor jti must never be compared
      // against it (it is discarded, exactly like the plain path).
      if (nonce !== '' && current.rotationNonceHash === nonce && current.rotatedTo !== null) {
        return { code: 2, successorJti: current.rotatedTo };
      }
      return { code: -1, status: current.status };
    }

    const now = Math.floor(Date.now() / 1000);
    if (current.absoluteExpiresAt <= now) {
      await this.client.del(oldKey);
      return { code: -2 };
    }
    if (options.expectedVersion !== undefined && current.version !== options.expectedVersion) {
      return { code: -3 };
    }

    const consumed: SessionRecord = {
      ...current,
      status: 'consumed',
      consumedAt: now,
      rotatedTo: successor.jti,
      rotationNonceHash: nonce !== '' ? nonce : null,
    };

    const consumedSerialized = serializeEncryptedSession(consumed, this.keyProvider!);
    const successorSerialized = serializeEncryptedSession(successor, this.keyProvider!);
    const successorTtl = Math.max(1, successor.absoluteExpiresAt - now);
    const consumedTtl = Math.max(1, consumed.absoluteExpiresAt - now);

    const result = await this.scripts.eval(
      'rotateEncrypted',
      3,
      oldKey,
      newKey,
      indexKey,
      consumedSerialized,
      successorSerialized,
      successor.jti,
      expected,
      nonce,
      retain,
      oldJti,
      String(successorTtl),
      String(consumedTtl),
    );

    return parseRotateResult(result, successor.jti);
  }

  /* ------------------------------------------------------------------------ */
  /* Update                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Optimistic-concurrency patch update. Returns the updated record, or
   * null when missing. Throws SessionConcurrencyError on version conflict.
   */
  async update(
    userId: string,
    jti: string,
    patch: SessionUpdatePatch,
    expectedVersion?: number,
  ): Promise<SessionRecord | null> {
    const key = this.keys.sessionKey(userId, jti);
    const expected = expectedVersion !== undefined ? String(expectedVersion) : '';

    if (!this.encrypted) {
      const result = await this.scripts.eval(
        'conditionalUpdate',
        1,
        key,
        expected,
        JSON.stringify(patch),
      );

      if (Array.isArray(result) && Number(result[0]) === 1) {
        return this.get(userId, jti);
      }
      if (Number(Array.isArray(result) ? result[0] : result) === 0) {
        await this.cleanupJtiIndex(jti);
        return null;
      }
      throwOrNull(Number(Array.isArray(result) ? result[0] : result));
      return null;
    }

    // Encrypted path: read, patch, re-encrypt, CAS.
    const raw = await this.client.get(key);
    if (raw === null) {
      await this.cleanupJtiIndex(jti);
      return null;
    }

    let current: SessionRecord;
    try {
      current = deserializeSession(raw, this.keyProvider!);
    } catch (error) {
      if (error instanceof SessionSerializationError) {
        return null;
      }
      throw error;
    }

    if (current.status !== 'active') throwOrNull(-1);
    const now = Math.floor(Date.now() / 1000);
    if (current.absoluteExpiresAt <= now) {
      await this.client.del(key);
      throwOrNull(-2);
    }
    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      throwOrNull(-3);
    }

    const nextVersion = current.version + 1;
    const updated: SessionRecord = {
      ...current,
      deviceId: patch.deviceId !== undefined ? patch.deviceId : current.deviceId,
      ipAddress: patch.ipAddress !== undefined ? patch.ipAddress : current.ipAddress,
      userAgent: patch.userAgent !== undefined ? patch.userAgent : current.userAgent,
      metadata: patch.metadata !== undefined ? patch.metadata : current.metadata,
      version: nextVersion,
    };

    const serialized = serializeEncryptedSession(updated, this.keyProvider!);
    const ttl = Math.max(1, updated.absoluteExpiresAt - now);

    const result = await this.scripts.eval(
      'conditionalUpdateEncrypted',
      1,
      key,
      expected,
      serialized,
      String(nextVersion),
      String(ttl),
    );

    if (Array.isArray(result) && Number(result[0]) === 1) {
      return updated;
    }
    throwOrNull(Number(Array.isArray(result) ? result[0] : result));
    return null;
  }

  /* ------------------------------------------------------------------------ */
  /* Destroy / revoke                                                         */
  /* ------------------------------------------------------------------------ */

  /** Physically deletes a session and its index entry. Idempotent. */
  async destroy(userId: string, jti: string): Promise<boolean> {
    const result = await this.scripts.eval(
      'delete',
      2,
      this.keys.sessionKey(userId, jti),
      this.keys.userIndexKey(userId),
      jti,
    );
    const deleted = Number(result) === 1;
    if (!deleted) {
      await this.cleanupJtiIndex(jti);
    }
    return deleted;
  }

  /**
   * Logically revokes a session with a bounded tombstone TTL.
   * Returns 'revoked' | 'already_revoked' | 'not_found'.
   */
  async revoke(userId: string, jti: string, tombstoneTtl: number): Promise<string> {
    const key = this.keys.sessionKey(userId, jti);
    const ttl = String(Math.max(1, tombstoneTtl));

    let payloadArg = '';

    if (this.encrypted) {
      const raw = await this.client.get(key);
      if (raw === null) {
        await this.cleanupJtiIndex(jti);
        return 'not_found';
      }
      let record: SessionRecord;
      try {
        record = deserializeSession(raw, this.keyProvider!);
      } catch (error) {
        if (error instanceof SessionSerializationError) {
          await this.cleanupJtiIndex(jti);
          return 'not_found';
        }
        throw error;
      }
      const revoked: SessionRecord = { ...record, status: 'revoked' };
      payloadArg = serializeEncryptedSession(revoked, this.keyProvider!);
    }

    const result = await this.scripts.eval('revoke', 1, key, payloadArg, ttl);
    const code = Number(result);

    if (code === 1) return 'revoked';
    if (code === 2) return 'already_revoked';
    if (code === 0) {
      await this.cleanupJtiIndex(jti);
      return 'not_found';
    }
    throw new SessionStorageError('Revoke script returned an unexpected result.', { code });
  }

  /* ------------------------------------------------------------------------ */
  /* User index operations                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Lists a user's sessions (oldest first), lazily cleaning stale index
   * members. Bounded: fetches at most `limit` members plus cleanup batches.
   */
  async listByUser(
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<SessionRecord[]> {
    const indexKey = this.keys.userIndexKey(userId);
    const limit = Math.max(1, options.limit ?? this.config.limits.maxListPageSize);
    const offset = Math.max(0, options.offset ?? 0);

    // ZRANGE WITHSCORES is unnecessary: scores are createdAt and we have
    // the records. Fetch only the requested window.
    const jtis = await this.client.zrange(indexKey, offset, offset + limit - 1);

    if (jtis.length === 0) return [];

    const sessionKeys = jtis.map((jti) => this.keys.sessionKey(userId, jti));
    const values = await this.client.mget(...sessionKeys);

    const sessions: SessionRecord[] = [];
    const stale: string[] = [];

    for (let i = 0; i < jtis.length; i++) {
      const raw = values[i];
      if (raw === null || raw === undefined) {
        stale.push(jtis[i]!);
        continue;
      }
      try {
        sessions.push(deserializeSession(raw, this.keyProvider ?? undefined));
      } catch (error) {
        if (error instanceof SessionSerializationError) {
          // Corrupt record: skip it, clean it up, never fail the list.
          stale.push(jtis[i]!);
          continue;
        }
        throw error;
      }
    }

    if (stale.length > 0) {
      await this.cleanupIndexEntries(userId, stale);
    }

    return sessions;
  }

  /**
   * Deletes all of a user's sessions in bounded same-slot batches.
   * Returns the jtis whose records were deleted.
   */
  async deleteByUser(userId: string): Promise<string[]> {
    const indexKey = this.keys.userIndexKey(userId);
    const jtis = await this.client.zrange(indexKey, 0, -1);

    if (jtis.length === 0) {
      await this.client.del(indexKey);
      return [];
    }

    const deleted: string[] = [];
    const batchSize = Math.min(this.maxBatchSize, this.config.limits.maxSessionsPerUserHardCap || this.maxBatchSize);

    for (const batch of chunk(jtis, batchSize)) {
      const sessionKeys = batch.map((jti) => this.keys.sessionKey(userId, jti));
      const result = await this.scripts.eval(
        'deleteByUser',
        1 + batch.length,
        indexKey,
        ...sessionKeys,
        ...batch,
      );
      if (Array.isArray(result)) {
        deleted.push(...result.map(String));
      }
    }

    return deleted;
  }

  /**
   * Removes stale (missing) members from a user's index. Bounded, safe to
   * run repeatedly.
   */
  async cleanupUserIndex(userId: string): Promise<number> {
    const indexKey = this.keys.userIndexKey(userId);
    const jtis = await this.client.zrange(indexKey, 0, -1);

    if (jtis.length === 0) return 0;

    let removed = 0;
    for (const batch of chunk(jtis, this.maxBatchSize)) {
      const sessionKeys = batch.map((jti) => this.keys.sessionKey(userId, jti));
      const result = await this.scripts.eval(
        'cleanupIndex',
        1 + batch.length,
        indexKey,
        ...sessionKeys,
        ...batch,
      );
      if (Array.isArray(result)) {
        removed += result.length;
      }
    }
    return removed;
  }

  /** Removes specific stale entries from a user's index (bounded). */
  async cleanupIndexEntries(userId: string, jtis: string[]): Promise<string[]> {
    if (jtis.length === 0) return [];

    const indexKey = this.keys.userIndexKey(userId);
    const removed: string[] = [];

    for (const batch of chunk(jtis, this.maxBatchSize)) {
      const sessionKeys = batch.map((jti) => this.keys.sessionKey(userId, jti));
      const result = await this.scripts.eval(
        'cleanupIndex',
        1 + batch.length,
        indexKey,
        ...sessionKeys,
        ...batch,
      );
      if (Array.isArray(result)) {
        removed.push(...result.map(String));
      }
    }
    return removed;
  }

  /**
   * Standalone max-session enforcement (used after revokeAll-style bulk
   * operations and by admin repair). Loops in bounded steps until the
   * index fits the limit or a hard cap is reached.
   */
  async enforceLimit(userId: string): Promise<number> {
    const maxSessions = this.config.maxSessionsPerUser;
    if (maxSessions <= 0) return 0;

    const indexKey = this.keys.userIndexKey(userId);
    let totalEvicted = 0;
    const hardCap = this.config.limits.maxSessionsPerUserHardCap;

    for (let i = 0; i < 100 && totalEvicted < hardCap; i++) {
      const result = await this.scripts.eval(
        'enforceLimit',
        1,
        indexKey,
        String(maxSessions),
        String(this.config.limits.maxEvictionsPerCall),
        this.keys.sessionKeyPrefix(userId),
      );

      if (!Array.isArray(result) || result.length < 2) {
        throw new SessionStorageError('Enforce-limit script returned an unexpected result.');
      }

      const evicted = Number(result[0]);
      totalEvicted += evicted;
      if (evicted === 0) break;
    }

    return totalEvicted;
  }

  /* ------------------------------------------------------------------------ */
  /* Security version                                                         */
  /* ------------------------------------------------------------------------ */

  /** Sets the current security version for a user (invalidates older sessions). */
  async setSecurityVersion(userId: string, version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new SessionConcurrencyError({ reason: 'invalid_security_version' });
    }
    await this.client.set(this.keys.securityVersionKey(userId), String(version));
  }

  /** Reads the current security version for a user, or null when unset. */
  async getSecurityVersion(userId: string): Promise<number | null> {
    const raw = await this.client.get(this.keys.securityVersionKey(userId));
    if (raw === null) return null;
    const version = Number(raw);
    return Number.isSafeInteger(version) && version >= 0 ? version : null;
  }

  /* ------------------------------------------------------------------------ */
  /* Optional global JTI index (derived state, never authoritative)           */
  /* ------------------------------------------------------------------------ */

  /** Best-effort write of the JTI lookup index (cross-slot, self-healing). */
  async writeJtiIndex(jti: string, userId: string, ttl: number): Promise<boolean> {
    if (!this.jtiIndexEnabled) return true;
    try {
      await this.client.set(this.keys.jtiIndexKey(jti), userId, ttl);
      return true;
    } catch {
      // The index is derived state: a failed write degrades JTI-only lookup,
      // never authentication. Callers should surface a metric.
      return false;
    }
  }

  /** Reads the JTI lookup index (only valid when the index is enabled). */
  async readJtiIndex(jti: string): Promise<string | null> {
    if (!this.jtiIndexEnabled) return null;
    return this.client.get(this.keys.jtiIndexKey(jti));
  }

  /** Deletes one JTI index entry (idempotent, cross-slot). */
  async deleteJtiIndex(jti: string): Promise<void> {
    if (!this.jtiIndexEnabled) return;
    await this.client.del(this.keys.jtiIndexKey(jti));
  }

  /**
   * Deletes JTI index entries through bounded slot-grouped pipelines
   * (cross-slot fan-out lives here, not in the session layer).
   */
  async deleteJtiIndexMany(jtis: string[]): Promise<void> {
    if (!this.jtiIndexEnabled || jtis.length === 0) return;

    const commands = jtis.map((jti) => {
      const key = this.keys.jtiIndexKey(jti);
      return { command: 'del', args: [key], slot: this.client.calculateSlot(key) };
    });

    await mapWithConcurrency(
      [...chunk(commands, this.maxBatchSize)],
      this.maxFanOut,
      async (batch) => {
      const results = await executeBySlot(this.client, batch, {
        concurrency: this.maxFanOut,
        retry: 1,
      });
      // Command-level errors are swallowed here on purpose: the index is
      // derived state and stale entries self-heal. Never fail auth flows.
      void results;
    });
  }

  /** Returns the user id behind a jti via the index, or null. */
  async resolveUserIdByJti(jti: string): Promise<string | null> {
    return this.readJtiIndex(jti);
  }

  /* ------------------------------------------------------------------------ */
  /* Misc                                                                     */
  /* ------------------------------------------------------------------------ */

  /** Server time in seconds (authoritative clock). */
  async serverTime(): Promise<number> {
    return this.client.time();
  }

  /** Number of sessions currently in a user's index. */
  async countByUser(userId: string): Promise<number> {
    return this.client.zcard(this.keys.userIndexKey(userId));
  }

  /**
   * Lists the jtis of a user's sessions (oldest first), bounded to `max`.
   * Used by bulk operations (revokeAll, deleteByUser).
   */
  async listJtis(userId: string, max: number): Promise<string[]> {
    if (max <= 0) return [];
    const indexKey = this.keys.userIndexKey(userId);
    const cardinality = await this.client.zcard(indexKey);
    if (cardinality === 0) return [];
    return this.client.zrange(indexKey, 0, Math.min(max, cardinality) - 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function mapTouchCode(code: number): TouchOutcome {
  switch (code) {
    case 1:
      return 'touched';
    case 2:
      return 'skipped_throttled';
    case 3:
    case 5:
      return 'skipped_stale';
    case 0:
      return 'not_found';
    case -1:
      return 'consumed';
    case -2:
      return 'expired';
    case -3:
      return 'idle_expired';
    case 4:
      throw new SessionSerializationError({ reason: 'envelope_mode_mismatch' });
    default:
      throw new SessionStorageError('Touch script returned an unexpected result.', { code });
  }
}

function parseRotateResult(
  result: unknown,
  successorJti: string,
): { code: number; successorJti?: string; status?: string } {
  if (Array.isArray(result) && result.length >= 1) {
    const code = Number(result[0]);
    if (code === 1 || code === 2) {
      const jti = result[1] !== undefined ? String(result[1]) : successorJti;
      return { code, successorJti: jti };
    }
    const status = result[1] !== undefined ? String(result[1]) : undefined;
    return status !== undefined ? { code, status } : { code };
  }
  return { code: Number(result) };
}

function throwOrNull(code: number): void {
  switch (code) {
    case -1:
      throw new SessionConcurrencyError({ reason: 'session_not_active' });
    case -2:
      throw new SessionNotFoundError({ reason: 'expired' });
    case -3:
      throw new SessionConcurrencyError({ reason: 'version_conflict' });
    default:
      break;
  }
}

/** Validates and normalizes an externally provided record (defense in depth). */
export function normalizeRecord(value: unknown): SessionRecord {
  return validateSessionRecord(value);
}