import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { SessionConfigurationError, SessionInvalidError } from './session-errors.js';

/* -------------------------------------------------------------------------- */
/* Session token security.                                                     */
/*                                                                             */
/*   token   - cryptographically secure random bytes (>= 128 bits), encoded    */
/*             base64url. Generated with crypto.randomBytes().                 */
/*   jti     - SHA-256(token) in base64url. The ONLY value persisted in        */
/*             Redis / logged / used as a key component.                       */
/*                                                                             */
/* The raw token is never stored, logged, or embedded in keys/errors.          */
/* -------------------------------------------------------------------------- */

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

/** Regex matching the canonical base64url padding-free alphabet. */
function tokenRegex(bytes: number): RegExp {
  return new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`);
}

/**
 * Generates and hashes session tokens.
 *
 * All functions are synchronous; entropy comes from the OS CSPRNG.
 */
export class SessionTokenManager {
  private readonly tokenBytes: number;

  /**
   * @param tokenBytes - Raw entropy in bytes (min 16 = 128 bits). 32 is
   *   recommended (256 bits).
   */
  constructor(tokenBytes = 32) {
    if (!Number.isInteger(tokenBytes) || tokenBytes < 16 || tokenBytes > 64) {
      throw new SessionConfigurationError(
        'tokenBytes must be an integer between 16 (128 bits) and 64 (512 bits).',
      );
    }
    this.tokenBytes = tokenBytes;
  }

  /** Generates a new raw session token (base64url, no padding). */
  generate(): string {
    return randomBytes(this.tokenBytes).toString('base64url');
  }

  /** Generates a caller-supplied rotation nonce of the same strength. */
  generateNonce(): string {
    return randomBytes(this.tokenBytes).toString('base64url');
  }

  /**
   * SHA-256 hashes a raw token into its persisted jti (base64url).
   * The token itself is never stored; only this digest is.
   */
  hash(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('base64url');
  }

  /**
   * Validates that a value looks like a well-formed raw token of the
   * configured length. Used to reject garbage before hashing/lookup.
   */
  validateFormat(token: string): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    if (!BASE64URL_REGEX.test(token)) return false;
    const expected = Math.ceil((this.tokenBytes * 4) / 3);
    // Accept tokens of the configured length only (tokens from older configs
    // are rejected as invalid rather than mislooked-up).
    return token.length === expected;
  }

  /**
   * Constant-time comparison of two strings (uses byte length, then
   * timingSafeEqual). Returns false when lengths differ without leaking
   * the difference.
   */
  safeEquals(a: string, b: string): boolean {
    const aBuf = Buffer.from(a, 'utf8');
    const bBuf = Buffer.from(b, 'utf8');
    if (aBuf.length !== bBuf.length) return false;
    return timingSafeEqual(aBuf, bBuf);
  }

  /**
   * Validates a token and returns its jti, or throws SessionInvalidError
   * for malformed input (so a malformed token is never looked up).
   */
  tokenToJti(token: string): string {
    if (!this.validateFormat(token)) {
      throw new SessionInvalidError({ reason: 'malformed_token' });
    }
    return this.hash(token);
  }
}
