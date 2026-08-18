import type { RedisClientWrapper } from '../client.js';
import { mapWithConcurrency } from '../cluster.js';
import type { RevocationStore } from './session-types.js';
import { SessionCircuitBreaker } from './session-circuit-breaker.js';
import type { SessionConfig } from './session-config.js';
import type { SessionKeyProvider } from './session-encryption.js';
import {
  SessionConfigurationError,
  SessionConcurrencyError,
  SessionError,
  SessionExpiredError,
  SessionInvalidError,
  SessionNotFoundError,
  SessionRevokedError,
  SessionRotationError,
  SessionSerializationError,
  SessionStorageError,
} from './session-errors.js';
import { SessionHealthChecker } from './session-health.js';
import type { SessionKeyStrategy } from './session-keys.js';
import { SessionMetrics } from './session-metrics.js';
import type { SessionOperation } from './session-metrics.js';
import { SessionRepository } from './session-repository.js';
import { assertHeaderMatches, deserializeSession } from './session-serializer.js';
import type { SessionTokenManager } from './session-token.js';
import type {
  BindingMismatch,
  CreatedSession,
  EncryptedSessionEnvelope,
  ListOptions,
  RotateOptions,
  RotatedSession,
  SessionCreateInput,
  SessionRecord,
  SessionUpdatePatch,
  SessionValidationResult,
  TouchOptions,
  TouchOutcome,
  UpdateOptions,
  ValidateOptions,
} from './session-types.js';

/* -------------------------------------------------------------------------- */
/* SessionService: the application-facing API.                                 */
/*                                                                             */
/* Responsibilities:                                                           */
/*   - token/jti mapping and userId resolution (jti index or explicit)         */
/*   - fail-closed behavior (storage errors are NEVER "invalid session")       */
/*   - binding policy enforcement, revocation-store checks                     */
/*   - metrics + circuit breaker + health feedback for every operation         */
/*                                                                             */
/* Business rules live here; atomic state transitions live in the repository/  */
/* Lua scripts. The service contains NO topology branching.                    */
/*                                                                             */
/* Fail-closed contract:                                                       */
/*   SessionStorageError (infra) -> 503. CircuitBreakerOpenError -> 503.       */
/*   SessionNotFound/Expired/Revoked/Invalid -> 401. Everything else is a      */
/*   programming or configuration error.                                       */
/* -------------------------------------------------------------------------- */

export interface SessionServiceDeps {
  config: SessionConfig;
  client: RedisClientWrapper;
  repository: SessionRepository;
  token: SessionTokenManager;
  keys: SessionKeyStrategy;
  revocationStore?: RevocationStore;
  metrics?: SessionMetrics;
  circuitBreaker?: SessionCircuitBreaker;
  health?: SessionHealthChecker;
  now?: () => number;
}

const IDEMPOTENCY_MIN_LENGTH = 8;
const IDEMPOTENCY_MAX_LENGTH = 256;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const MAX_THROTTLE_ENTRIES = 10_000;

export class SessionService {
  private readonly deps: SessionServiceDeps;
  private readonly throttle = new Map<string, number>();

  constructor(deps: SessionServiceDeps) {
    this.deps = deps;
  }

  private get config(): SessionConfig {
    return this.deps.config;
  }

  private get repository(): SessionRepository {
    return this.deps.repository;
  }

  private get metrics(): SessionMetrics {
    return this.deps.metrics ?? new SessionMetrics();
  }

  private get breaker(): SessionCircuitBreaker | null {
    return this.deps.circuitBreaker ?? null;
  }

  private get healthChecker(): SessionHealthChecker | null {
    return this.deps.health ?? null;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }

  /* ------------------------------------------------------------------------ */
  /* Guard: metrics + circuit breaker + error normalization per operation.    */
  /* ------------------------------------------------------------------------ */

  private async guard<T>(
    op: SessionOperation,
    fn: () => Promise<T>,
    classify?: (result: T) => 'ok' | 'invalid',
  ): Promise<T> {
    const breaker = this.breaker;
    const started = performance.now();
    const outcome = () => this.metrics.latency(op, Math.round(performance.now() - started));

    const run = async (): Promise<T> => {
      try {
        const result = await fn();
        outcome();
        this.metrics.operation(op, classify ? classify(result) : 'ok');
        this.healthChecker?.recordOp(true);
        return result;
      } catch (error) {
        outcome();
        if (error instanceof SessionError) {
          this.metrics.operation(op, 'error');
          this.healthChecker?.recordOp(false);
          throw error;
        }
        // Unknown errors are infrastructure failures: fail closed, typed.
        this.healthChecker?.recordOp(false);
        this.metrics.operation(op, 'error', 'storage');
        throw new SessionStorageError(undefined, { operation: op, cause: String(error) });
      }
    };

    if (!breaker) return run();

    if (!breaker.tryAcquire()) {
      outcome();
      this.metrics.operation(op, 'error', 'circuit_open');
      this.healthChecker?.recordOp(false);
      throw new SessionStorageError(undefined, { operation: op, reason: 'circuit_open' });
    }

    try {
      const result = await run();
      breaker.recordSuccess();
      return result;
    } catch (error) {
      // Only infrastructure (storage) failures trip the breaker: business
      // errors (not_found, invalid, revoked, concurrency, ...) are expected
      // outcomes of bad input and must never open the circuit.
      if (error instanceof SessionStorageError) {
        breaker.recordFailure();
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Create                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Creates a session and returns the raw token exactly once.
   *
   * Idempotent creation: when `input.idempotencyKey` is provided (and
   * config.enableCreateIdempotency is on), the idempotencyKey IS the token.
   * A retry with the same key returns the existing session with
   * `replayed: true` instead of creating a duplicate.
   */
  create(input: SessionCreateInput): Promise<CreatedSession> {
    return this.guard('create', async () => {
      validateUserId(input.userId);

      let token: string;
      let jti: string;
      let replayed = false;

      if (input.idempotencyKey !== undefined) {
        if (!this.config.enableCreateIdempotency) {
          throw new SessionConfigurationError('idempotencyKey requires enableCreateIdempotency.');
        }
        validateIdempotencyToken(input.idempotencyKey);
        token = input.idempotencyKey;
        jti = this.deps.token.hash(token);
      } else if (input.jti !== undefined) {
        // Advanced: caller manages token lifecycle. The provided jti must be
        // a valid session id; validate() with the caller's token resolves to
        // it when tokenToJti(callerToken) === jti.
        if (!this.deps.token.validateFormat(input.jti)) {
          throw new SessionConfigurationError('Caller-supplied jti must be a valid session id.');
        }
        token = input.jti;
        jti = input.jti;
      } else {
        token = this.deps.token.generate();
        jti = this.deps.token.hash(token);
      }

      if (input.metadata !== undefined) {
        let serialized: string;
        try {
          serialized = JSON.stringify(input.metadata);
        } catch {
          throw new SessionInvalidError({ reason: 'metadata_cyclic' });
        }
        const size = Buffer.byteLength(serialized);
        if (size > this.config.limits.maxMetadataSize) {
          throw new SessionInvalidError({
            reason: 'metadata_too_large',
            size,
            max: this.config.limits.maxMetadataSize,
          });
        }
      }

      const now = this.now();
      const securityVersion = this.config.securityVersion.enabled
        ? await this.repository.getSecurityVersion(input.userId)
        : null;

      const record: SessionRecord = {
        jti,
        userId: input.userId,
        createdAt: now,
        lastAccessedAt: now,
        absoluteExpiresAt: now + this.config.ttl,
        idleExpiresAt:
          this.config.idleTimeout !== null
            ? Math.min(now + this.config.idleTimeout, now + this.config.ttl)
            : null,
        status: 'active',
        version: 1,
        securityVersion,
        deviceId: this.config.storeDeviceId ? (input.deviceId ?? null) : null,
        ipAddress: this.config.storeIpAddress ? (input.ipAddress ?? null) : null,
        userAgent: this.config.storeUserAgent ? (input.userAgent ?? null) : null,
        metadata: input.metadata ?? null,
        rotatedFrom: null,
        rotatedTo: null,
        consumedAt: null,
        rotationNonceHash: null,
      };

      const ttl = Math.max(1, record.absoluteExpiresAt - now);
      const result = await this.repository.create(record, ttl);

      if (result.status === 'replayed') {
        const existing = await this.repository.get(input.userId, result.jti);
        if (!existing) {
          // Claim exists but the record vanished (TTL race); create afresh.
          const retry: SessionCreateInput = { userId: input.userId };
          if (input.deviceId !== undefined) retry.deviceId = input.deviceId;
          if (input.ipAddress !== undefined) retry.ipAddress = input.ipAddress;
          if (input.userAgent !== undefined) retry.userAgent = input.userAgent;
          if (input.metadata !== undefined) retry.metadata = input.metadata;
          if (input.jti !== undefined) retry.jti = input.jti;
          return this.create(retry);
        }
        return { token, session: existing, replayed: true };
      }

      const indexed = await this.repository.writeJtiIndex(jti, input.userId, ttl);
      if (!indexed) this.metrics.jtiIndexWriteFailure();
      return { token, session: record };
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Validate                                                                 */
  /* ------------------------------------------------------------------------ */

  /**
   * Validates a session token. Single Redis round trip when userId is known.
   * Never throws for invalid sessions; throws only for infrastructure
   * failures (fail closed) and configuration errors.
   */
  validate(token: string, options: ValidateOptions = {}): Promise<SessionValidationResult> {
    return this.guard(
      'validate',
      async (): Promise<SessionValidationResult> => {
        if (!this.isAcceptableToken(token)) {
          return { valid: false, reason: 'invalid' };
        }

        const jti = this.deps.token.hash(token);
        const userId = await this.resolveUserId(jti, options.userId);
        if (userId === null) {
          return { valid: false, reason: 'not_found' };
        }

        const result = await this.repository.validateRead(userId, jti);

        if (!result.found) {
          return { valid: false, reason: 'not_found' };
        }

        if ('code' in result) {
          if (result.code === -1) {
            return { valid: false, reason: result.status === 'revoked' ? 'revoked' : 'invalid' };
          }
          if (result.code === -2) return { valid: false, reason: 'expired' };
          if (result.code === -3) return { valid: false, reason: 'idle_timeout' };
          if (result.code === -4) return { valid: false, reason: 'revoked' };
        }

        // Found and passed script checks. App-side checks on the payload.
        let session: SessionRecord;
        try {
          session = deserializeSession(result.raw, this.repository.keyProvider ?? undefined);
          if (this.config.encryption.enabled) {
            assertHeaderMatches(parseEncryptedHeader(result.raw), session);
            // Security version (plain path is checked inside the script).
            if (
              result.currentSecurityVersion !== null &&
              session.securityVersion !== result.currentSecurityVersion
            ) {
              return { valid: false, reason: 'revoked' };
            }
          }
        } catch (error) {
          if (error instanceof SessionSerializationError) {
            await this.bestEffortCleanup(userId, jti);
            return { valid: false, reason: 'invalid' };
          }
          throw error;
        }

        // Binding policy.
        const binding = this.checkBinding(session, options);
        if (binding && this.config.bindingPolicy === 'strict') {
          return { valid: false, reason: 'binding_mismatch' };
        }

        // External revocation store (JWT jti denylists etc.).
        if (this.config.checkRevocationStore && this.deps.revocationStore) {
          const revoked = await this.deps.revocationStore.isRevoked(jti);
          if (revoked) return { valid: false, reason: 'revoked' };
        }

        return binding ? { valid: true, session, binding } : { valid: true, session };
      },
      (result) => (result.valid ? 'ok' : 'invalid'),
    );
  }

  /* ------------------------------------------------------------------------ */
  /* Touch                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Refreshes activity. Throttled by touchInterval (in-script + in-memory
   * optimizations). Never resurrects an idle-expired session.
   */
  touch(token: string, options: TouchOptions = {}): Promise<TouchOutcome> {
    return this.guard('touch', async () => {
      if (!this.isAcceptableToken(token)) return 'not_found';
      const jti = this.deps.token.hash(token);
      const userId = await this.resolveUserId(jti, options.userId);
      if (userId === null) return 'not_found';

      if (!options.force) {
        const last = this.throttle.get(jti);
        if (last !== undefined && this.now() - last < this.config.touchInterval) {
          return 'skipped_throttled';
        }
      }

      const outcome = await this.repository.touch(userId, jti, options.force ?? false);

      if (outcome === 'touched') {
        if (this.throttle.size >= MAX_THROTTLE_ENTRIES) this.throttle.clear();
        this.throttle.set(jti, this.now());
      }
      return outcome;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Rotate                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Single-use atomic rotation with retry-safe idempotency (rotationNonce).
   */
  rotate(token: string, options: RotateOptions = {}): Promise<RotatedSession> {
    return this.guard('rotate', async () => {
      if (!this.isAcceptableToken(token)) {
        throw new SessionNotFoundError({ reason: 'invalid_token' });
      }

      const oldJti = this.deps.token.hash(token);
      const userId = await this.resolveUserId(oldJti, options.userId);
      if (userId === null) {
        throw new SessionNotFoundError({ reason: 'jti_index_miss' });
      }

      const rotationNonceHash = options.rotationNonce
        ? this.deps.token.hash(options.rotationNonce)
        : undefined;

      const now = this.now();
      const successorToken = this.deps.token.generate();
      const successorJti = this.deps.token.hash(successorToken);

      const successor: SessionRecord = {
        jti: successorJti,
        userId,
        createdAt: now,
        lastAccessedAt: now,
        absoluteExpiresAt: now + this.config.ttl,
        idleExpiresAt:
          this.config.idleTimeout !== null
            ? Math.min(now + this.config.idleTimeout, now + this.config.ttl)
            : null,
        status: 'active',
        version: 1,
        securityVersion: null,
        deviceId: null,
        ipAddress: null,
        userAgent: null,
        metadata: null,
        rotatedFrom: oldJti,
        rotatedTo: null,
        consumedAt: null,
        rotationNonceHash: null,
      };

      const result = await this.repository.rotate({
        userId,
        oldJti,
        successor,
        ...(options.expectedVersion !== undefined
          ? { expectedVersion: options.expectedVersion }
          : {}),
        ...(rotationNonceHash !== undefined ? { rotationNonceHash } : {}),
        retainTombstone: this.config.retainConsumedTombstones,
      });

      if (result.code === 1 || result.code === 2) {
        const replayed = result.code === 2;
        const session = replayed
          ? await this.repository.get(userId, result.successorJti!)
          : successor;

        if (!session) {
          throw new SessionRotationError({ reason: 'successor_unavailable', replayed });
        }

        // The old index entry is intentionally kept: it is derived state
        // with its own TTL, and keeping it lets retry-safe rotation replays
        // resolve the consumed jti without a userId for the tombstone
        // window. Validation of a consumed session fails regardless.
        const indexed = await this.repository.writeJtiIndex(
          session.jti,
          userId,
          Math.max(1, session.absoluteExpiresAt - this.now()),
        );
        if (!indexed) this.metrics.jtiIndexWriteFailure();

        // On replay the successor's raw token is unrecoverable (only its
        // hash is stored): the caller must treat the outcome as ambiguous
        // and re-authenticate rather than reusing the old token.
        return replayed ? { session, replayed } : { token: successorToken, session, replayed };
      }

      throw rotationError(result.code, result.status);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Update                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Patch update of non-security fields (device/ip/ua/metadata) with
   * optimistic concurrency.
   */
  update(
    token: string,
    patch: SessionUpdatePatch,
    options: UpdateOptions = {},
  ): Promise<SessionRecord> {
    return this.guard('update', async () => {
      if (!this.isAcceptableToken(token)) {
        throw new SessionNotFoundError({ reason: 'invalid_token' });
      }
      const jti = this.deps.token.hash(token);
      const userId = await this.resolveUserId(jti, options.userId);
      if (userId === null) {
        throw new SessionNotFoundError({ reason: 'jti_index_miss' });
      }

      validatePatch(patch, this.config.limits.maxMetadataSize);

      const record = await this.repository.update(userId, jti, patch, options.expectedVersion);
      if (!record) {
        throw new SessionNotFoundError({});
      }
      return record;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Destroy / revoke                                                         */
  /* ------------------------------------------------------------------------ */

  /** Physically deletes a session (idempotent). */
  destroy(token: string, options: { userId?: string } = {}): Promise<boolean> {
    return this.guard('destroy', async () => {
      if (!this.isAcceptableToken(token)) return false;
      const jti = this.deps.token.hash(token);
      const userId = await this.resolveUserId(jti, options.userId);
      if (userId === null) return false;
      const deleted = await this.repository.destroy(userId, jti);
      if (deleted) await this.repository.deleteJtiIndex(jti);
      return deleted;
    });
  }

  /**
   * Logically revokes a session (keeps a bounded tombstone).
   * Returns 'revoked' | 'already_revoked' | 'not_found'.
   */
  revoke(token: string, options: { userId?: string } = {}): Promise<string> {
    return this.guard('revoke', async () => {
      if (!this.isAcceptableToken(token)) return 'not_found';
      const jti = this.deps.token.hash(token);
      const userId = await this.resolveUserId(jti, options.userId);
      if (userId === null) return 'not_found';
      const outcome = await this.repository.revoke(userId, jti, this.config.ttl);
      await this.repository.deleteJtiIndex(jti);
      return outcome;
    });
  }

  /** Revokes every session of a user (bounded, fail-closed on partial). */
  async revokeAll(userId: string): Promise<number> {
    return this.guard('revoke_all', async () => {
      validateUserId(userId);
      const jtis = await this.repository.listJtis(
        userId,
        this.config.limits.maxSessionsPerUserHardCap,
      );

      let revoked = 0;
      await mapWithConcurrency(jtis, this.config.limits.maxFanOutConcurrency, async (jti) => {
        await this.repository.revoke(userId, jti, this.config.ttl);
        revoked += 1;
      });

      return revoked;
    });
  }

  /** Deletes every session of a user (physical, bounded). */
  async deleteByUser(userId: string): Promise<string[]> {
    return this.guard('delete_by_user', async () => {
      validateUserId(userId);
      const jtis = await this.repository.listJtis(
        userId,
        this.config.limits.maxSessionsPerUserHardCap,
      );
      const deleted = await this.repository.deleteByUser(userId);
      await this.repository.deleteJtiIndexMany(jtis);
      return deleted;
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Listing                                                                  */
  /* ------------------------------------------------------------------------ */

  /** Lists a user's sessions (oldest first). */
  findByUser(userId: string, options: ListOptions = {}): Promise<SessionRecord[]> {
    return this.guard('find_by_user', async () => {
      validateUserId(userId);
      const includeInactive = options.includeInactive ?? false;
      const sessions = await this.repository.listByUser(userId, {
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.offset !== undefined ? { offset: options.offset } : {}),
      });
      if (includeInactive) return sessions;
      return sessions.filter((s) => s.status === 'active');
    });
  }

  /** Alias of {@link findByUser} for listing. */
  list(userId: string, options: ListOptions = {}): Promise<SessionRecord[]> {
    return this.findByUser(userId, options);
  }

  /* ------------------------------------------------------------------------ */
  /* Security version                                                         */
  /* ------------------------------------------------------------------------ */

  /**
   * Sets (or bumps) the user's security version, invalidating every session
   * captured at an older version. Use after password/MFA changes.
   */
  setSecurityVersion(userId: string, version?: number): Promise<number> {
    return this.guard('set_security_version', async () => {
      validateUserId(userId);
      const next =
        version !== undefined
          ? version
          : ((await this.repository.getSecurityVersion(userId)) ?? 0) + 1;
      await this.repository.setSecurityVersion(userId, next);
      return next;
    });
  }

  getSecurityVersion(userId: string): Promise<number | null> {
    return this.guard('set_security_version', async () => {
      validateUserId(userId);
      return this.repository.getSecurityVersion(userId);
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Health                                                                   */
  /* ------------------------------------------------------------------------ */

  /** Dependency health (PING latency + recent error rate). */
  async health(): Promise<ReturnType<SessionHealthChecker['check']>> {
    if (!this.deps.health) {
      throw new SessionConfigurationError('Session health checker is not configured.');
    }
    return this.deps.health.check();
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Resolves the userId for a jti: explicit when provided (fast path), via
   * the JTI index otherwise. Returns null when the index has no entry.
   */
  private async resolveUserId(jti: string, explicitUserId?: string): Promise<string | null> {
    if (explicitUserId !== undefined && explicitUserId !== '') {
      return explicitUserId;
    }
    if (!this.config.jtiIndex.enabled) {
      throw new SessionConfigurationError(
        'Operation requires userId (jtiIndex is disabled and no userId was provided).',
      );
    }
    return this.repository.readJtiIndex(jti);
  }

  /**
   * Accepts tokens in the strict issued format (base64url of the configured
   * entropy) and caller-supplied idempotency keys (bounded printable ASCII),
   * which are used as tokens for idempotent creation. Rejects everything
   * else (DoS guard: bounded length, bounded alphabet).
   */
  private isAcceptableToken(token: string): boolean {
    if (this.deps.token.validateFormat(token)) return true;
    return (
      token.length >= IDEMPOTENCY_MIN_LENGTH &&
      token.length <= IDEMPOTENCY_MAX_LENGTH &&
      PRINTABLE_ASCII.test(token)
    );
  }

  private checkBinding(session: SessionRecord, options: ValidateOptions): BindingMismatch | null {
    if (this.config.bindingPolicy === 'disabled') return null;

    const mismatch: BindingMismatch = {
      ipAddress:
        session.ipAddress !== null &&
        options.ipAddress !== undefined &&
        session.ipAddress !== options.ipAddress,
      userAgent:
        session.userAgent !== null &&
        options.userAgent !== undefined &&
        session.userAgent !== options.userAgent,
      deviceId:
        session.deviceId !== null &&
        options.deviceId !== undefined &&
        session.deviceId !== options.deviceId,
    };

    if (!mismatch.ipAddress && !mismatch.userAgent && !mismatch.deviceId) return null;
    return mismatch;
  }

  private async bestEffortCleanup(userId: string, jti: string): Promise<void> {
    try {
      await this.repository.destroy(userId, jti);
      await this.repository.deleteJtiIndex(jti);
    } catch {
      // Best-effort: a failed cleanup must not mask the invalid result.
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function rotationError(code: number, status?: string): SessionError {
  switch (code) {
    case 0:
      return new SessionNotFoundError({});
    case -1:
      return new SessionRevokedError({ status });
    case -2:
      return new SessionExpiredError({});
    case -3:
      return new SessionConcurrencyError({ reason: 'version_conflict' });
    case -4:
      return new SessionRotationError({ reason: 'successor_collision' });
    case 5:
    case 6:
      return new SessionSerializationError({ reason: 'envelope_mode_mismatch' });
    default:
      return new SessionStorageError(undefined, { code });
  }
}

function validateUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 512) {
    throw new SessionConfigurationError('userId must be a non-empty string of at most 512 chars.');
  }
}

function validateIdempotencyToken(token: string): void {
  if (
    token.length < IDEMPOTENCY_MIN_LENGTH ||
    token.length > IDEMPOTENCY_MAX_LENGTH ||
    !PRINTABLE_ASCII.test(token)
  ) {
    throw new SessionConfigurationError(
      `idempotencyKey must be ${IDEMPOTENCY_MIN_LENGTH}-${IDEMPOTENCY_MAX_LENGTH} printable ASCII chars.`,
    );
  }
}

function validatePatch(patch: SessionUpdatePatch, maxMetadataSize: number): void {
  if (patch.deviceId !== undefined && patch.deviceId !== null && patch.deviceId.length > 1024) {
    throw new SessionInvalidError({ reason: 'device_id_too_long' });
  }
  if (patch.ipAddress !== undefined && patch.ipAddress !== null && patch.ipAddress.length > 64) {
    throw new SessionInvalidError({ reason: 'ip_address_too_long' });
  }
  if (
    patch.userAgent !== undefined &&
    patch.userAgent !== null &&
    patch.userAgent.length > 1024
  ) {
    throw new SessionInvalidError({ reason: 'user_agent_too_long' });
  }
  if (patch.metadata !== undefined && patch.metadata !== null) {
    let serialized: string;
    try {
      serialized = JSON.stringify(patch.metadata);
    } catch {
      throw new SessionInvalidError({ reason: 'metadata_cyclic' });
    }
    const size = Buffer.byteLength(serialized);
    if (size > maxMetadataSize) {
      throw new SessionInvalidError({ reason: 'metadata_too_large', size, max: maxMetadataSize });
    }
  }
}

function parseEncryptedHeader(raw: string): EncryptedSessionEnvelope {
  const parsed = JSON.parse(raw) as EncryptedSessionEnvelope;
  if (parsed.v !== 2) throw new SessionSerializationError({ reason: 'envelope_mode_mismatch' });
  return parsed;
}
