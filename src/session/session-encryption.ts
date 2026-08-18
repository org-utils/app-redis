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
  /** Returns the current encryption key and its version. */
  getCurrentKey(): { keyVersion: number; key: Buffer };

  /**
   * Returns the key for a specific version, or null when that version is no
   * longer available (sessions encrypted with it become invalid).
   */
  getKey(keyVersion: number): Buffer | null;
}

/** A simple key provider for single-process deployments (env/CLI injection). */
export class StaticSessionKeyProvider implements SessionKeyProvider {
  private readonly keys: ReadonlyMap<number, Buffer>;

  constructor(keys: ReadonlyMap<number, Buffer>, private readonly currentVersion: number) {
    if (keys.size === 0) {
      throw new SessionConfigurationError('At least one encryption key is required.');
    }
    if (!keys.has(currentVersion)) {
      throw new SessionConfigurationError('currentVersion must be present in the key map.');
    }
    for (const [version, key] of keys) {
      if (key.length !== 32) {
        throw new SessionConfigurationError(
          `Encryption key version ${version} must be exactly 32 bytes (AES-256).`,
        );
      }
    }
    this.keys = new Map(keys);
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

  const cipher = createCipheriv('aes-256-gcm', key, iv);
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
  const key = provider.getKey(envelope.k);

  if (!key) {
    throw new SessionSerializationError({
      reason: 'unknown_key_version',
      keyVersion: envelope.k,
    });
  }

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
