import { SessionSerializationError } from './session-errors.js';
import { decryptJson, encryptJson } from './session-encryption.js';
import type { SessionKeyProvider } from './session-encryption.js';
import type {
  EncryptedSessionEnvelope,
  PlainSessionEnvelope,
  SessionEnvelope,
  SessionRecord,
  SessionStatus,
} from './session-types.js';

/* -------------------------------------------------------------------------- */
/* Versioned, runtime-validated session serialization.                         */
/*                                                                             */
/*   v:1  plain JSON envelope   { v: 1, s: <SessionRecord> }                   */
/*   v:2  encrypted envelope    { v: 2, e: 1, k, i, t, c, st, ver, la, ... }   */
/*                                                                             */
/* JSON.parse() output is NEVER blindly cast to SessionRecord; every field     */
/* is validated at runtime. Corrupt or malformed data surfaces as              */
/* SessionSerializationError (never a crash) and callers treat it as           */
/* invalid storage and clean it up safely.                                     */
/* -------------------------------------------------------------------------- */

export type EnvelopeKind = 'plain' | 'encrypted' | 'unknown';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNullish(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isSecondsTimestamp(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function isOptionalSecondsTimestamp(v: unknown): boolean {
  return isNullish(v) || isSecondsTimestamp(v);
}

function isStatus(v: unknown): v is SessionStatus {
  return v === 'active' || v === 'consumed' || v === 'revoked';
}

function isOptionalString(v: unknown, maxLength = 1024): boolean {
  return isNullish(v) || (typeof v === 'string' && v.length <= maxLength);
}

const MAX_METADATA_DEPTH = 5;
const MAX_METADATA_KEYS = 128;

function isPlainMetadata(v: unknown, depth = 0): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) {
    if (depth >= MAX_METADATA_DEPTH) return false;
    return v.every((item) => isPlainMetadata(item, depth + 1));
  }
  if (typeof v === 'object') {
    if (depth >= MAX_METADATA_DEPTH) return false;
    const keys = Object.keys(v);
    if (keys.length > MAX_METADATA_KEYS) return false;
    return keys.every((key) => key.length <= 128 && isPlainMetadata((v as Record<string, unknown>)[key], depth + 1));
  }
  return false;
}

/**
 * Runtime validation of an arbitrary parsed value against the SessionRecord
 * shape. Returns the validated record or throws SessionSerializationError
 * with a machine-readable reason. Never casts blindly.
 */
export function validateSessionRecord(value: unknown): SessionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SessionSerializationError({ reason: 'not_an_object' });
  }

  const r = value as Record<string, unknown>;

  const jti = r.jti;
  if (!isString(jti) || jti.length < 20 || jti.length > 100 || !BASE64URL.test(jti)) {
    throw new SessionSerializationError({ reason: 'invalid_jti' });
  }

  const userId = r.userId;
  if (!isString(userId) || userId.length === 0 || userId.length > 512) {
    throw new SessionSerializationError({ reason: 'invalid_user_id' });
  }

  const createdAt = r.createdAt;
  const lastAccessedAt = r.lastAccessedAt;
  const absoluteExpiresAt = r.absoluteExpiresAt;

  if (!isSecondsTimestamp(createdAt)) throw new SessionSerializationError({ reason: 'invalid_created_at' });
  if (!isSecondsTimestamp(lastAccessedAt)) throw new SessionSerializationError({ reason: 'invalid_last_accessed_at' });
  if (!isSecondsTimestamp(absoluteExpiresAt)) throw new SessionSerializationError({ reason: 'invalid_absolute_expiry' });

  const idleExpiresAt = r.idleExpiresAt;
  if (!isOptionalSecondsTimestamp(idleExpiresAt)) {
    throw new SessionSerializationError({ reason: 'invalid_idle_expiry' });
  }

  const status = r.status;
  if (!isStatus(status)) throw new SessionSerializationError({ reason: 'invalid_status' });

  const version = r.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) {
    throw new SessionSerializationError({ reason: 'invalid_version' });
  }

  const securityVersion = r.securityVersion;
  if (!isNullish(securityVersion) && (typeof securityVersion !== 'number' || !Number.isSafeInteger(securityVersion) || securityVersion < 0)) {
    throw new SessionSerializationError({ reason: 'invalid_security_version' });
  }
  const validatedSecurityVersion = (securityVersion as number | null | undefined) ?? null;

  if (!isOptionalString(r.deviceId)) throw new SessionSerializationError({ reason: 'invalid_device_id' });
  if (!isOptionalString(r.ipAddress)) throw new SessionSerializationError({ reason: 'invalid_ip_address' });
  if (!isOptionalString(r.userAgent)) throw new SessionSerializationError({ reason: 'invalid_user_agent' });

  const metadata = r.metadata;
  if (!isNullish(metadata) && !isPlainMetadata(metadata)) {
    throw new SessionSerializationError({ reason: 'invalid_metadata' });
  }

  if (!isNullish(r.rotatedFrom) && !isString(r.rotatedFrom)) {
    throw new SessionSerializationError({ reason: 'invalid_rotated_from' });
  }
  if (!isNullish(r.rotatedTo) && !isString(r.rotatedTo)) {
    throw new SessionSerializationError({ reason: 'invalid_rotated_to' });
  }
  if (!isNullish(r.consumedAt) && !isSecondsTimestamp(r.consumedAt)) {
    throw new SessionSerializationError({ reason: 'invalid_consumed_at' });
  }
  if (!isNullish(r.rotationNonceHash) && !isString(r.rotationNonceHash)) {
    throw new SessionSerializationError({ reason: 'invalid_rotation_nonce_hash' });
  }

  return {
    jti,
    userId,
    createdAt,
    lastAccessedAt,
    absoluteExpiresAt,
    idleExpiresAt: (idleExpiresAt as number | null | undefined) ?? null,
    status,
    version,
    securityVersion: validatedSecurityVersion,
    deviceId: (r.deviceId as string | null | undefined) ?? null,
    ipAddress: (r.ipAddress as string | null | undefined) ?? null,
    userAgent: (r.userAgent as string | null | undefined) ?? null,
    metadata: (metadata as Record<string, unknown> | null | undefined) ?? null,
    rotatedFrom: (r.rotatedFrom as string | null | undefined) ?? null,
    rotatedTo: (r.rotatedTo as string | null | undefined) ?? null,
    consumedAt: (r.consumedAt as number | null | undefined) ?? null,
    rotationNonceHash: (r.rotationNonceHash as string | null | undefined) ?? null,
  };
}

/**
 * Serializes a record into the plain v1 envelope.
 */
export function serializeSession(record: SessionRecord): string {
  return JSON.stringify({ v: 1, s: record } satisfies PlainSessionEnvelope);
}

/**
 * Serializes a record into the encrypted v2 envelope, mirroring the
 * script-readable plaintext header from the record.
 */
export function serializeEncryptedSession(record: SessionRecord, provider: SessionKeyProvider): string {
  const body = encryptJson(JSON.stringify(record), provider);
  const envelope: EncryptedSessionEnvelope = {
    v: 2,
    e: 1,
    ...body,
    st: record.status,
    ver: record.version,
    la: record.lastAccessedAt,
    idle: record.idleExpiresAt,
    exp: record.absoluteExpiresAt,
    rn: record.rotationNonceHash,
    rj: record.rotatedTo,
  };
  return JSON.stringify(envelope);
}

/** Cheap kind detection without full parsing (for script mode selection). */
export function envelopeKind(raw: string): EnvelopeKind {
  try {
    const parsed = JSON.parse(raw) as SessionEnvelope;
    if (parsed && typeof parsed === 'object' && parsed.v === 1) return 'plain';
    if (parsed && typeof parsed === 'object' && parsed.v === 2 && parsed.e === 1) return 'encrypted';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Deserializes a stored envelope into a validated SessionRecord.
 *
 * @throws {SessionSerializationError} for unknown schema versions, malformed
 *   JSON, malformed records, and encryption failures (auth tag, unknown key
 *   version). The caller decides how to handle the corrupt record (invalidate
 *   + clean up); this never crashes the process.
 */
export function deserializeSession(raw: string, keyProvider?: SessionKeyProvider): SessionRecord {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionSerializationError({ reason: 'invalid_json' });
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new SessionSerializationError({ reason: 'not_an_object' });
  }

  const envelope = parsed as SessionEnvelope;

  if (envelope.v === 1) {
    return validateSessionRecord((envelope as PlainSessionEnvelope).s);
  }

  if (envelope.v === 2) {
    if (!keyProvider) {
      throw new SessionSerializationError({ reason: 'encrypted_without_provider' });
    }
    const body = envelope as EncryptedSessionEnvelope;
    if (body.e !== 1) {
      throw new SessionSerializationError({ reason: 'unknown_encryption_version' });
    }
    return validateSessionRecord(decryptJson<unknown>(body, keyProvider));
  }

  throw new SessionSerializationError({ reason: 'unsupported_schema_version' });
}

/**
 * Builds the plaintext header mirrors for an encrypted envelope from a
 * record. Used by the repository when re-encrypting on touch/rotate/update.
 */
export function encryptedHeaderOf(record: SessionRecord): Pick<
  EncryptedSessionEnvelope,
  'st' | 'ver' | 'la' | 'idle' | 'exp' | 'rn' | 'rj'
> {
  return {
    st: record.status,
    ver: record.version,
    la: record.lastAccessedAt,
    idle: record.idleExpiresAt,
    exp: record.absoluteExpiresAt,
    rn: record.rotationNonceHash,
    rj: record.rotatedTo,
  };
}

/**
 * Verifies that a decrypted v2 record agrees with the envelope's plaintext
 * header mirrors. The ciphertext is authoritative; a disagreement means the
 * envelope was built from stale or inconsistent state and MUST fail closed.
 *
 * @throws {SessionSerializationError} on any mismatch.
 */
export function assertHeaderMatches(
  envelope: EncryptedSessionEnvelope,
  record: SessionRecord,
): void {
  const header = encryptedHeaderOf(record);
  const mismatches: string[] = [];

  if (envelope.st !== header.st) mismatches.push('st');
  if (envelope.ver !== header.ver) mismatches.push('ver');
  if (envelope.la !== header.la) mismatches.push('la');
  if (envelope.idle !== header.idle) mismatches.push('idle');
  if (envelope.exp !== header.exp) mismatches.push('exp');
  if (envelope.rn !== header.rn) mismatches.push('rn');
  if (envelope.rj !== header.rj) mismatches.push('rj');

  if (mismatches.length > 0) {
    throw new SessionSerializationError({ reason: 'header_mismatch', fields: mismatches });
  }
}
