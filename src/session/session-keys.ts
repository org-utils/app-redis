import { SessionConfigurationError } from './session-errors.js';

/* -------------------------------------------------------------------------- */
/* Redis key design for Redis Cluster.                                         */
/*                                                                             */
/*   session record : {ns}:session:{userId}:session:{jti}                      */
/*   user index     : {ns}:user-sessions:{userId}          (ZSET)              */
/*   security ver   : {ns}:security-version:{userId}      (string)             */
/*   jti index (opt): {ns}:jti-index:{jti}               (cross-slot, global)  */
/*   revoked (opt)  : {ns}:revoked:{jti}                 (cross-slot, single)  */
/*                                                                             */
/* The literal text `{userId}` is the Redis Cluster hash tag: every key of     */
/* one user shares one slot, enabling atomic Lua scripts per user. No global   */
/* hash tag is used, so sessions are spread across slots.                      */
/*                                                                             */
/* userId values are percent-encoded before embedding: values containing       */
/* `{`, `}`, `:`, `*`, `?`, `[`, `]` etc. would otherwise break hash tags,     */
/* glob patterns and key parsing. The encoding is deterministic and            */
/* collision-free.                                                             */
/* -------------------------------------------------------------------------- */

/** Characters kept verbatim in the encoded user id. */
const SAFE = /^[A-Za-z0-9._-]$/;

/**
 * Deterministically encodes a userId for safe embedding in Redis keys.
 *
 * Every byte not in [A-Za-z0-9._-] is hex-encoded as %XX (UTF-8 aware),
 * so `{`, `}`, `:` and glob metacharacters can never appear. The encoding
 * is injective: distinct userIds always produce distinct encodings.
 */
export function encodeUserId(userId: string): string {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 512) {
    throw new SessionConfigurationError('userId must be a non-empty string of at most 512 chars.');
  }

  let out = '';
  for (let i = 0; i < userId.length; i++) {
    const ch = userId[i]!;
    if (SAFE.test(ch)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, 'utf8')) {
        out += `%${byte.toString(16).padStart(2, '0')}`;
      }
    }
  }
  return out;
}

/**
 * Deterministic, Cluster-safe key strategy.
 *
 * Every key derived here is stable for the lifetime of the process and
 * identical across horizontally scaled instances (no randomness).
 */
export class SessionKeyStrategy {
  private readonly namespace: string;

  /**
   * @param namespace - Key namespace, e.g. `'authcore'`.
   */
  constructor(namespace: string) {
    const trimmed = namespace.trim();
    if (!trimmed || trimmed.length > 64 || /[\s{}/:*?[\]]/.test(trimmed)) {
      throw new SessionConfigurationError(
        'namespace must be 1-64 chars without whitespace or glob/hash-tag metacharacters.',
      );
    }
    this.namespace = trimmed;
  }

  private ns(part: string): string {
    return `${this.namespace}:${part}`;
  }

  /**
   * Key of a single session record. Hash-tagged by userId, so all of one
   * user's session keys share a slot.
   */
  sessionKey(userId: string, jti: string): string {
    return this.ns(`session:{${encodeUserId(userId)}}:session:${jti}`);
  }

  /** Key of the user's session index (ZSET, member = jti, score = createdAt). */
  userIndexKey(userId: string): string {
    return this.ns(`user-sessions:{${encodeUserId(userId)}}`);
  }

  /** Key of the user's security version counter. Same user slot. */
  securityVersionKey(userId: string): string {
    return this.ns(`security-version:{${encodeUserId(userId)}}`);
  }

  /**
   * Short-lived idempotent-creation claim key (user slot). Bounded TTL is
   * set by the create script; a claim only ever suppresses a duplicate.
   */
  createClaimKey(userId: string, jti: string): string {
    return this.ns(`create-claim:{${encodeUserId(userId)}}:${jti}`);
  }

  /**
   * Key of the optional global JTI -> userId index.
   * Deliberately NOT hash-tagged: it is cross-slot from the session record
   * and treated as derived state (see docs/architecture).
   */
  jtiIndexKey(jti: string): string {
    return this.ns(`jti-index:${jti}`);
  }

  /** Key of a revocation entry (single-key, cluster-safe, no tag needed). */
  revokedKey(jti: string): string {
    return this.ns(`revoked:${jti}`);
  }

  /**
   * Session key prefix for a user, used by Lua eviction to construct keys
   * from jtis. The `{userId}` hash tag guarantees same-slot construction.
   */
  sessionKeyPrefix(userId: string): string {
    return this.ns(`session:{${encodeUserId(userId)}}:session:`);
  }

  /** Index key prefix for namespace-scoped administration. */
  namespacePrefix(): string {
    return `${this.namespace}:`;
  }
}
