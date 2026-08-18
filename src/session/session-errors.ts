import { RedisError } from '../errors.js';

/* -------------------------------------------------------------------------- */
/* Typed, safe session errors.                                                 */
/*                                                                             */
/* Rules:                                                                      */
/*  - Never embed raw session tokens, cookies, passwords, encryption keys,     */
/*    or full session payloads in messages.                                    */
/*  - JTI/userId are only included in `details` (structured metadata) after    */
/*    redaction, never as plain strings in `message`.                          */
/*  - Authentication layers map these errors to HTTP semantics:                */
/*      SessionStorageError      -> 503 (infrastructure unavailable)           */
/*      SessionNotFoundError     -> 401                                        */
/*      SessionExpiredError      -> 401                                        */
/*      SessionRevokedError      -> 401                                        */
/*      CircuitBreakerOpenError  -> 503                                        */
/* -------------------------------------------------------------------------- */

/**
 * Base class for every session subsystem error.
 * Extends {@link RedisError} so existing Redis error handling keeps working.
 */
export class SessionError extends RedisError {
  constructor(message: string, code = 'SESSION_ERROR', details?: Record<string, unknown>) {
    super(message, code, details);
    this.name = 'SessionError';
  }
}

/** The session does not exist (or no longer exists). */
export class SessionNotFoundError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session not found.', 'SESSION_NOT_FOUND', details);
    this.name = 'SessionNotFoundError';
  }
}

/** The session expired (absolute or idle timeout), or was created in the past. */
export class SessionExpiredError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session has expired.', 'SESSION_EXPIRED', details);
    this.name = 'SessionExpiredError';
  }
}

/** The session was revoked or consumed by a rotation (replay detected). */
export class SessionRevokedError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session is no longer valid.', 'SESSION_REVOKED', details);
    this.name = 'SessionRevokedError';
  }
}

/** The session record exists but is invalid (corrupt, tampered, mismatched). */
export class SessionInvalidError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session is invalid.', 'SESSION_INVALID', details);
    this.name = 'SessionInvalidError';
  }
}

/** A security-sensitive session transition (rotation) failed. */
export class SessionRotationError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session rotation failed.', 'SESSION_ROTATION_FAILED', details);
    this.name = 'SessionRotationError';
  }
}

/** Reuse of an already-consumed session token was detected. */
export class SessionReplayError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session reuse detected.', 'SESSION_REPLAY', details);
    this.name = 'SessionReplayError';
  }
}

/**
 * Redis (or the session storage backend) is unavailable.
 *
 * Authentication MUST fail closed on this error: never treat it as an
 * invalid session, and never fall back to assuming the session is valid.
 */
export class SessionStorageError extends SessionError {
  constructor(message = 'Session storage unavailable.', details?: Record<string, unknown>) {
    super(message, 'SESSION_STORAGE_UNAVAILABLE', details);
    this.name = 'SessionStorageError';
  }
}

/** Stored session data could not be deserialized/decrypted. */
export class SessionSerializationError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Stored session data is malformed.', 'SESSION_SERIALIZATION_ERROR', details);
    this.name = 'SessionSerializationError';
  }
}

/** Session configuration is invalid (fails at manager construction). */
export class SessionConfigurationError extends SessionError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'SESSION_CONFIGURATION_ERROR', details);
    this.name = 'SessionConfigurationError';
  }
}

/** Optimistic-concurrency conflict on a session update. */
export class SessionConcurrencyError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Session was modified concurrently.', 'SESSION_CONCURRENCY', details);
    this.name = 'SessionConcurrencyError';
  }
}

/** A revocation could not be persisted (fail closed, do not swallow). */
export class RevocationError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super('Revocation could not be persisted.', 'REVOCATION_ERROR', details);
    this.name = 'RevocationError';
  }
}

/** A batch revocation partially failed; check `failures` for details. */
export class RevocationBatchError extends SessionError {
  /** Safe identifiers of the entries whose pipeline command failed. */
  readonly failures: Array<{ jti: string; error: unknown }>;

  constructor(failures: Array<{ jti: string; error: unknown }>) {
    super(
      `Revocation batch failed for ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'}.`,
      'REVOCATION_BATCH_ERROR',
      { failureCount: failures.length },
    );
    this.name = 'RevocationBatchError';
    this.failures = failures;
  }

  /** Compatibility alias: the affected jtis. */
  get ids(): string[] {
    return this.failures.map((f) => f.jti);
  }
}

/** The circuit breaker is open; requests fail closed without touching Redis. */
export class CircuitBreakerOpenError extends SessionError {
  constructor(details?: Record<string, unknown>) {
    super(
      'Authentication infrastructure is temporarily unavailable.',
      'CIRCUIT_OPEN',
      details,
    );
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Redacts an identifier for safe inclusion in logs/errors/metrics labels.
 *
 * Only the length and a short opaque suffix are revealed; never the full
 * value. Use for jti/userId/deviceId/ipAddress in structured details.
 *
 * @example
 * redactIdentifier('dG9rZW5oYXNo...') // => 'token#c3V'
 */
export function redactIdentifier(value: string | null | undefined): string {
  if (!value) return 'none';
  if (value.length <= 6) return `#${'*'.repeat(value.length)}`;
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}
