import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import { SessionConfigurationError, SessionSerializationError } from './session-errors.js';
import type { EncryptedSessionEnvelope } from './session-types.js';

/* -------------------------------------------------------------------------- */
/* Optional AES-256-GCM encryption at rest.                                    */
/*                                                                             */
/* Threat model:                                                               */
/*   Protected against: a compromised Redis instance / Redis disk / backup     */
/*   exposure. Without the key, session payloads (metadata, device, IP, UA,    */
/*   timestamps) cannot be read or tampered with undetected.                   */
/*   NOT protected against: a compromised application process or Redis        */
/*   client (the key lives in the process), or denial of service (deleting     */
/*   keys).                                                                    */
/*                                                                             */
/* Construction:                                                               */
/*   - AES-256-GCM, 12-byte random IV per encryption, 16-byte auth tag.        */
/*   - IV is generated with crypto.randomBytes for every operation; reuse      */
/*     with the same key is cryptographically improbable.                      */
/*   - Key versioning: the envelope stores keyVersion; decryption supports     */
/*     older versions via the injected provider; writes use the current key.   */
/*                                                                             */
/* Keys are NEVER stored in Redis or in session configuration; they come       */
/* exclusively from a SessionKeyProvider (KMS-backed adapters are the          */
/* intended usage).                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Key management abstraction. Applications provide their own implementation
 * (KMS, secret store, env-based rotation), or a simple in-memory map of
 * versions to 32-byte keys for single-process deployments.
 */
export interface SessionKeyProvider {
  /**
   * Returns the encryption key used for all WRITES (new sessions, updates,
   * re-encryption on touch). Called on every encryption.
   *
   * The version labels which key produced the ciphertext: it is stored in
   * the session envelope (`k` field) so the corresponding key can be looked
   * up later on read. Always return the current key here — never an
   * arbitrary one.
   *
   * The key may be a 32-byte Buffer or a string (see {@link toKeyBuffer} for
   * the accepted encodings). Whatever form is returned here must also be
   * resolvable via {@link getKey} for the same version.
   */
  getCurrentKey(): { keyVersion: number; key: Buffer | string };

  /**
   * Returns the key for a specific version, or null when that version is no
   * longer available. Called on every READ (decryption).
   *
   * Every session records the version it was encrypted with; this lookup
   * resolves it. Returning null makes sessions encrypted with that version
   * undecryptable — they surface as {@link SessionSerializationError}.
   *
   * This is what enables safe key rotation: when the current key changes,
   * old keys must stay available here so previously written sessions keep
   * decrypting. Only drop a version once every session using it has expired
   * or been re-encrypted with the current key.
   */
  getKey(keyVersion: number): Buffer | string | null;
}

/**
 * Normalizes a key to a Buffer for use with AES-256-GCM.
 *
 * Buffers are returned as-is. Strings are decoded in priority order:
 *  - 64 hex characters        -> hex
 *  - base64 / base64url text that decodes to exactly 32 bytes -> base64
 *  - anything else            -> utf8 (a 32-character passphrase)
 *
 * The decoded key must be 32 bytes (AES-256) for Node's crypto to accept
 * it; {@link StaticSessionKeyProvider} validates this at construction.
 */
export function toKeyBuffer(key: Buffer | string): Buffer {
  if (Buffer.isBuffer(key)) return key;
  const trimmed = key.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    const decoded = Buffer.from(
      trimmed.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    if (decoded.length === 32) return decoded;
  }
  return Buffer.from(key, 'utf8');
}

/** A simple key provider for single-process deployments (env/CLI injection). */
export class StaticSessionKeyProvider implements SessionKeyProvider {
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(keys: ReadonlyMap<number, Buffer | string>, private readonly currentVersion: number) {
    if (keys.size === 0) {
      throw new SessionConfigurationError('At least one encryption key is required.');
    }
    if (!keys.has(currentVersion)) {
      throw new SessionConfigurationError('currentVersion must be present in the key map.');
    }
    const normalized = new Map<number, Buffer>();
    for (const [version, raw] of keys) {
      const key = toKeyBuffer(raw);
      if (key.length !== 32) {
        throw new SessionConfigurationError(
          `Encryption key version ${version} must be exactly 32 bytes (AES-256).`,
        );
      }
      normalized.set(version, key);
    }
    this.keys = normalized;
  }

  getCurrentKey(): { keyVersion: number; key: Buffer } {
    return { keyVersion: this.currentVersion, key: this.keys.get(this.currentVersion)! };
  }

  getKey(keyVersion: number): Buffer | null {
    return this.keys.get(keyVersion) ?? null;
  }
}

/**
 * Creates a {@link StaticSessionKeyProvider} with one freshly generated
 * 32-byte key. Convenience for local development and tests; production
 * deployments should derive keys from a KMS/vault instead.
 *
 * @param keyVersion - Version label for the generated key (default 1).
 */
export function createRandomSessionKeyProvider(keyVersion = 1): StaticSessionKeyProvider {
  return new StaticSessionKeyProvider(new Map([[keyVersion, randomBytes(32)]]), keyVersion);
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts a plaintext payload with AES-256-GCM using the current key.
 * Returns a fresh random IV + auth tag per call.
 */
export function encryptPayload(
  plaintext: Buffer,
  provider: SessionKeyProvider,
): Pick<EncryptedSessionEnvelope, 'k' | 'i' | 't' | 'c'> {
  const { keyVersion, key } = provider.getCurrentKey();
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv('aes-256-gcm', toKeyBuffer(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    k: keyVersion,
    i: iv.toString('base64url'),
    t: authTag.toString('base64url'),
    c: ciphertext.toString('base64url'),
  };
}

/**
 * Decrypts an envelope, verifying the GCM auth tag.
 *
 * @throws {SessionSerializationError} when the key version is unknown, the
 *   IV/auth tag/ciphertext are malformed, or authentication fails (tampered
 *   or corrupt data).
 */
export function decryptPayload(
  envelope: Pick<EncryptedSessionEnvelope, 'k' | 'i' | 't' | 'c'>,
  provider: SessionKeyProvider,
): Buffer {
  const raw = provider.getKey(envelope.k);

  if (!raw) {
    throw new SessionSerializationError({
      reason: 'unknown_key_version',
      keyVersion: envelope.k,
    });
  }

  const key = toKeyBuffer(raw);

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;

  try {
    iv = Buffer.from(envelope.i, 'base64url');
    tag = Buffer.from(envelope.t, 'base64url');
    ciphertext = Buffer.from(envelope.c, 'base64url');
  } catch {
    throw new SessionSerializationError({ reason: 'malformed_encrypted_fields' });
  }

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SessionSerializationError({ reason: 'malformed_encrypted_fields' });
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM auth failure = tampered or corrupted data. Treat as invalid.
    throw new SessionSerializationError({ reason: 'authentication_failed' });
  }
}

/** Encrypts a JSON string into an encrypted envelope body. */
export function encryptJson(
  json: string,
  provider: SessionKeyProvider,
): Pick<EncryptedSessionEnvelope, 'k' | 'i' | 't' | 'c'> {
  return encryptPayload(Buffer.from(json, 'utf8'), provider);
}

/** Decrypts an envelope body and parses the JSON inside. */
export function decryptJson<T>(
  envelope: Pick<EncryptedSessionEnvelope, 'k' | 'i' | 't' | 'c'>,
  provider: SessionKeyProvider,
): T {
  const plaintext = decryptPayload(envelope, provider);
  try {
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    throw new SessionSerializationError({ reason: 'malformed_plaintext' });
  }
}
