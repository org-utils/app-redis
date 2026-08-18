/* -------------------------------------------------------------------------- */
/* Session domain model.                                                       */
/*                                                                             */
/* A session here represents a server-side authentication session (typically   */
/* a refresh token or a long-lived browser session). It is NOT a JWT.          */
/*                                                                             */
/* Token model:                                                                */
/*   raw token   - 32 random bytes, base64url encoded. NEVER persisted,        */
/*                 logged, or included in Redis keys/values.                   */
/*   jti         - SHA-256(token) in base64url. Used as the Redis key          */
/*                 component and stored in records. A jti can only be          */
/*                 reversed to the token by brute force, so persisting it      */
/*                 is safe.                                                    */
/*   key         - the Redis key: {ns}:session:{userId}:session:{jti}          */
/* -------------------------------------------------------------------------- */

/** Lifecycle state of a session record. */
export type SessionStatus = 'active' | 'consumed' | 'revoked';

/**
 * The persisted session record.
 *
 * Identity fields (jti, userId, createdAt) are immutable: they are set at
 * creation and never touched again. All timestamps are Unix seconds.
 */
export type SessionRecord = {
  /** Session id: SHA-256 hash of the raw session token, base64url encoded. */
  jti: string ;
  /** Owner of the session. Identity field - immutable. */
  userId: string;
  /** Creation time (Unix seconds). Identity field - immutable. */
  createdAt: number;
  /** Last activity timestamp (Unix seconds), used for idle and touch logic. */
  lastAccessedAt: number;
  /**
   * Absolute lifetime boundary (Unix seconds). Activity may extend the idle
   * boundary but NEVER this one. The Redis TTL is derived from this value.
   */
  absoluteExpiresAt: number;
  /**
   * Idle timeout boundary (Unix seconds), or null when idle timeout is
   * disabled. A session with idleExpiresAt <= now is idle-expired and must
   * not be extended by touch.
   */
  idleExpiresAt: number | null;
  /** Lifecycle state: active, consumed (by rotation), or revoked. */
  status: SessionStatus;
  /** Optimistic-concurrency version. Bumped on every security-relevant write. */
  version: number;
  /** Account security version captured at creation, or null when disabled. */
  securityVersion: number | null;
  /** Optional device identifier (advisory binding only). */
  deviceId: string | null;
  /** Optional IP address recorded at last access (advisory binding only). */
  ipAddress: string | null;
  /** Optional user agent (advisory binding only). */
  userAgent: string | null;
  /** Arbitrary application metadata. Bounded by config (maxMetadataSize). */
  metadata: Record<string, unknown> | null;
  /** JTI this session was rotated from (rotation chains, reuse detection). */
  rotatedFrom: string | null;
  /** JTI this session was rotated to (enables retry-safe rotation). */
  rotatedTo: string | null;
  /** When the session was consumed by a rotation (Unix seconds), or null. */
  consumedAt: number | null;
  /** Hash of the rotation nonce that consumed this session (retry safety). */
  rotationNonceHash: string | null;
}

/** Input for session creation. Only caller-controlled fields. */
export type SessionCreateInput = {
  userId: string;
  /** Optional device identifier. Only stored when config.storeDeviceId is true. */
  deviceId?: string;
  /** Optional IP address. Only stored when config.storeIpAddress is true. */
  ipAddress?: string;
  /** Optional user agent. Only stored when config.storeUserAgent is true. */
  userAgent?: string;
  /** Arbitrary metadata (bounded by config.maxMetadataSize). */
  metadata?: Record<string, unknown>;
  /**
   * Idempotency key: when provided, a create that was already applied with
   * the same key returns the existing session instead of creating a duplicate.
   * Requires config.enableCreateIdempotency (stores a short-lived claim).
   */
  idempotencyKey?: string;
}

/**
 * Mutable fields for {@link SessionUpdatePatch}. Every other field is
 * identity or security-critical and can only change through dedicated
 * operations (rotate, revoke, touch).
 */
export type SessionUpdatePatch = {
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Result of a successful creation: the raw token is returned exactly once. */
export type CreatedSession = {
  /** The raw session token. Give this to the client; store it nowhere. */
  token: string;
  /** The persisted session record (contains only the jti, never the token). */
  session: SessionRecord;
  /**
   * True when the create was an idempotent replay (a previous attempt with
   * the same idempotencyKey created the session). The token is the
   * idempotencyKey itself, so it resolves to the same session.
   */
  replayed?: boolean;
}

/** Result of a successful rotation. */
export type RotatedSession = {
  /**
   * The successor raw token. Give this to the client; store it nowhere.
   * Absent on idempotent replays: the successor's token was only ever
   * returned to the original caller, so a retry cannot recover it.
   */
  token?: string;
  /** The successor session record. */
  session: SessionRecord;
  /**
   * True when the rotation was a retry of an already-applied rotation with
   * the same rotation nonce (the response to the first attempt was lost).
   */
  replayed: boolean;
}

/** Machine-readable invalidation reason for a session. */
export type SessionInvalidReason =
  | 'not_found'
  | 'expired'
  | 'idle_timeout'
  | 'absolute_timeout'
  | 'revoked'
  | 'invalid'
  | 'binding_mismatch';

export type SessionValidationResult =
  | { valid: true; session: SessionRecord; binding?: BindingMismatch }
  | { valid: false; reason: SessionInvalidReason; session?: never };

/**
 * Touch outcome codes, mirroring the Lua script result codes.
 *   touched          - a write was performed (idle boundary extended).
 *   skipped_throttled - inside touchInterval; no write performed.
 *   skipped_stale    - request was older than recorded activity; no write.
 *   not_found        - no record (or record gone).
 *   consumed         - session was consumed by rotation / revoked.
 *   expired          - absolute expiry passed; record removed.
 *   idle_expired     - idle timeout passed; record NOT touched (not resurrected).
 */
export type TouchOutcome =
  | 'touched'
  | 'skipped_throttled'
  | 'skipped_stale'
  | 'not_found'
  | 'consumed'
  | 'expired'
  | 'idle_expired';

/** Options for {@link SessionService.touch}. */
export type TouchOptions = {
  /** Force a write regardless of touchInterval (rarely needed). */
  force?: boolean;
  /** When known, avoids the JTI lookup index round trip. */
  userId?: string;
}

/** Options for {@link SessionService.validate}. */
export type ValidateOptions = {
  /**
   * When the caller already knows the user id (the common case in an
   * authentication layer), passing it avoids the JTI lookup index round
   * trip and makes validation a single Redis read.
   */
  userId?: string;
  /** Current IP address, compared against the stored value (binding policy). */
  ipAddress?: string;
  /** Current user agent, compared against the stored value (binding policy). */
  userAgent?: string;
  /** Current device id, compared against the stored value (binding policy). */
  deviceId?: string;
}

/** Options for {@link SessionService.rotate}. */
export type RotateOptions = {
  /**
   * Client-supplied random nonce enabling retry-safe rotation. If the first
   * rotation succeeded but the response was lost, retrying with the same
   * nonce returns the already-created successor instead of a replay error.
   */
  rotationNonce?: string;
  /** Skip the pre-flight GET and let the Lua script be authoritative. */
  userId?: string;
  /** Optimistic concurrency: only rotate when the old record matches. */
  expectedVersion?: number;
}

/** Options for {@link SessionService.update}. */
export type UpdateOptions = {
  /**
   * Optimistic concurrency: when set, the update only applies if the
   * current record version matches. Otherwise throws SessionConcurrencyError.
   */
  expectedVersion?: number;
  /** When known, avoids the JTI lookup index round trip. */
  userId?: string;
}

/** Options for {@link SessionService.list}. */
export type ListOptions = {
  /** Maximum number of sessions to return (bounded pipeline). Default: 100. */
  limit?: number;
  /** Skip the first N sessions (oldest first). */
  offset?: number;
  /** Include consumed/revoked records in the result. Default: false. */
  includeInactive?: boolean;
}

/** Advisory binding mismatch details (binding policy must be configured). */
export type BindingMismatch = {
  ipAddress: boolean;
  userAgent: boolean;
  deviceId: boolean;
}

/* -------------------------------------------------------------------------- */
/* Serialization envelope                                                      */
/* -------------------------------------------------------------------------- */

/** Schema version of the persisted envelope. */
export type SerializedSchemaVersion = 1 | 2;

/**
 * Plain (unencrypted) persisted envelope.
 * `v: 1` - plain JSON session record.
 */
export type PlainSessionEnvelope = {
  v: 1;
  s: SessionRecord;
}

/**
 * Encrypted persisted envelope.
 * `v: 2` - AES-256-GCM ciphertext plus a small plaintext header.
 *
 * The header carries only non-sensitive state used by Lua scripts
 * (lifecycle status, concurrency version, timestamps, rotation nonce hash).
 * The authenticated ciphertext is authoritative for validation: a header
 * that disagrees with the decrypted record fails closed.
 */
export type EncryptedSessionEnvelope = {
  v: 2;
  e: 1;
  /** Encryption key version. */
  k: number;
  /** Base64url initialization vector (12 bytes). */
  i: string;
  /** Base64url GCM auth tag (16 bytes). */
  t: string;
  /** Base64url ciphertext. */
  c: string;
  /** Plaintext lifecycle status mirror (script access). */
  st: SessionStatus;
  /** Plaintext concurrency version mirror (script access). */
  ver: number;
  /** Plaintext last activity mirror (script access). */
  la: number;
  /** Plaintext idle boundary mirror (script access). */
  idle: number | null;
  /** Plaintext absolute boundary mirror (script access). */
  exp: number;
  /** Plaintext rotation nonce hash mirror (script access). */
  rn: string | null;
  /** Plaintext rotated-to JTI mirror (script access). */
  rj: string | null;
}

export type SessionEnvelope = PlainSessionEnvelope | EncryptedSessionEnvelope;




/* ---------------------------------------------------------------------- */
/* Revocation                                                              */
/* ---------------------------------------------------------------------- */

export type RevocationRecord = {
  jti: string;
  /** Unix seconds after which this revocation entry may be garbage collected. */
  expiresAt: number;
  reason?: "logout" | "logout-all" | "password-change" | "admin-revocation" | "reuse-detected" | (string & {});
}

/**
 * Storage-agnostic type for tracking revoked token ids (jti).
 * Implementations MUST auto-expire entries at/after `expiresAt` so the
 * store doesn't grow unbounded (e.g. Redis TTL, or a sweep in-memory).
 */
export type RevocationStore = {
  revoke(record: RevocationRecord): Promise<void>;
  revokeMany(records: RevocationRecord[]): Promise<void>;
  isRevoked(jti: string): Promise<boolean>;
}
