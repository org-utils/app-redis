import { z } from 'zod';

import { SessionConfigurationError } from './session-errors.js';
import { SessionKeyProvider } from './session-encryption.js';
import { RevocationStore } from './session-types.js';

/* -------------------------------------------------------------------------- */
/* Session configuration (Zod is the source of truth).                         */
/*                                                                             */
/* Secrets (encryption keys, Redis credentials) NEVER live in this config.     */
/* Encryption keys are injected via a SessionKeyProvider at construction.      */
/* -------------------------------------------------------------------------- */
const TTL = 7 * 24 * 60 * 60;
const IDLE_TIMEOUT = 24 * 60 * 60;
const TOUCH_INTERVAL = 5 * 60;
export const SessionStatusSchema = z.enum(['active', 'consumed', 'revoked']);

/** How strictly session binding metadata (IP/UA/device) is enforced. */
export const SessionBindingPolicySchema = z.enum(['disabled', 'advisory', 'strict']);

export const SessionCircuitBreakerConfigSchema = z
  .object({
    /** Enable the fail-closed circuit breaker. Default: false. */
    enabled: z.boolean().default(false),
    /** Consecutive failures needed to open the circuit. */
    failureThreshold: z.number().int().min(1).default(10),
    /** Milliseconds the circuit stays open before half-open probes. */
    resetTimeoutMs: z.number().int().min(1000).default(30_000),
    /** Maximum concurrent probe requests while half-open. */
    halfOpenMaxRequests: z.number().int().min(1).default(5),
  })
  .prefault({});

export type SessionCircuitBreakerConfig = z.infer<
  typeof SessionCircuitBreakerConfigSchema
>;

export const SessionEncryptionConfigSchema = z.object({
  /**
   * Enable AES-256-GCM encryption at rest. Default: false.
   *
   * Evaluate first whether transport TLS, ACLs, private networking and
   * infrastructure controls already cover your threat model. Encryption
   * protects session data against a compromised Redis instance or its
   * disk; it does NOT protect against a compromised application process.
   */
  enabled: z.boolean().default(false),
  /**
   * Re-encrypt with the current key version on touch/update (lazy key
   * rotation). Default: true.
   */
  reEncryptOnWrite: z.boolean().default(true),
});

export type SessionEncryptionConfig = z.infer<typeof SessionEncryptionConfigSchema>;

export const SessionMetricsConfigSchema = z.object({
  /**
   * Collect internal session metrics through the injected metrics adapter.
   * When no adapter is provided, metrics are a safe no-op regardless.
   */
  enabled: z.boolean().default(true),
});

export type SessionMetricsConfig = z.infer<typeof SessionMetricsConfigSchema>;

export const SessionHealthConfigSchema = z.object({
  /** PING latency above this (ms) marks the dependency degraded. */
  latencyThresholdMs: z.number().int().min(1).default(200),
  /** Recent operation error rate above this marks the dependency degraded. */
  errorRateThreshold: z.number().min(0).max(1).default(0.1),
  /** Number of recent operations sampled for the error rate. */
  errorWindowSize: z.number().int().min(1).default(100),
});

export type SessionHealthConfig = z.infer<typeof SessionHealthConfigSchema>;

export const SessionCookieConfigSchema = z
  .object({
    /** Cookie name. Default: 'sid'. */
    name: z.string().min(1).max(128).default('sid'),
    /** Cookie Path attribute. Default: '/'. */
    path: z.string().min(1).default('/'),
    /** Cookie Domain attribute (empty = host-only cookie). */
    domain: z.string().optional(),
    /** HttpOnly attribute. Default: true. */
    httpOnly: z.boolean().default(true),
    /** Secure attribute. Default: true. */
    secure: z.boolean().default(true),
    /** SameSite attribute. Default: 'lax'. */
    sameSite: z.enum(['strict', 'lax', 'none']).default('lax'),
    /** Max-Age in seconds (falls back to the session TTL when unset). */
    maxAge: z.number().int().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    // SameSite=None is rejected by browsers unless Secure is set.
    if (data.sameSite === 'none' && !data.secure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SameSite=None requires secure: true',
        path: ['sameSite'],
      });
    }
  });

export type SessionCookieConfig = z.infer<typeof SessionCookieConfigSchema>;

/** Limits protecting Redis memory, Lua and pipelines. */
export const SessionLimitsConfigSchema = z.object({
  /** Maximum serialized metadata size in bytes (reject larger writes). */
  maxMetadataSize: z.number().int().min(0).default(4096),
  /** Maximum sessions fetched per list page. */
  maxListPageSize: z.number().int().min(1).default(100),
  /** Maximum session keys touched by one Lua script invocation. */
  maxBatchSize: z.number().int().min(1).max(500).default(100),
  /** Maximum concurrent cross-slot pipelines (revokeAll, jti cleanup). */
  maxFanOutConcurrency: z.number().int().min(1).max(64).default(8),
  /** Maximum sessions evicted by a single enforce-limit script call. */
  maxEvictionsPerCall: z.number().int().min(1).max(5000).default(1000),
  /** Maximum session deletions per user-request path (revokeAll/destroy-all). */
  maxSessionsPerUserHardCap: z.number().int().min(0).default(10_000),
});

export type SessionLimitsConfig = z.infer<typeof SessionLimitsConfigSchema>;

export const SessionConfigSchema = z
  .object({
    /**
     * Master switch. Sessions are NOT enabled implicitly; an application
     * must explicitly opt in. Default: false.
     */
    enabled: z.boolean().default(false),

    /** Key namespace for all session keys. Default: 'authcore'. */
    namespace: z.string().min(1).max(64).default('authcore'),

    /**
     * Raw session token entropy in bytes (32 = 256 bits). Minimum 16
     * (128 bits). Default: 32.
     */
    tokenBytes: z.number().int().min(16).max(64).default(32),

    /**
     * Absolute session lifetime in seconds (the hard maximum). Redis TTL is
     * derived from this boundary; touch/rolling NEVER extends past it.
     * Default: 7 days.
     */
    ttl: z.number().int().min(1).default(TTL),

    /**
     * Idle timeout in seconds. When null, sessions never expire through
     * inactivity. Default: 1 day.
     */
    idleTimeout: z.number().int().min(1).nullable().default(IDLE_TIMEOUT),

    /**
     * Rolling sessions: valid activity extends the idle boundary (never the
     * absolute boundary). Only meaningful when idleTimeout is set.
     * Default: true.
     */
    rolling: z.boolean().default(true),

    /**
     * Touch throttling in seconds: touch() performs no write when the last
     * activity is more recent than this interval. Default: 300.
     */
    touchInterval: z.number().int().min(0).default(TOUCH_INTERVAL),

    /**
     * Maximum concurrent sessions per user. 0 disables the limit.
     * Default: 20.
     *
     * Enforcement is atomic per create (same-slot Lua): the create that
     * pushes the count over the limit evicts the oldest excess sessions in
     * the same script, so concurrent logins cannot both observe spare
     * capacity. For extremely large per-user session counts, eviction is
     * bounded per script call and converges over subsequent creates.
     */
    maxSessionsPerUser: z.number().int().min(0).default(20),

    /** Store the device id on creation (advisory binding). Default: false. */
    storeDeviceId: z.boolean().default(false),
    /** Store the IP address on creation (advisory binding). Default: false. */
    storeIpAddress: z.boolean().default(false),
    /** Store the user agent on creation (advisory binding). Default: false. */
    storeUserAgent: z.boolean().default(false),

    /**
     * Session binding policy. 'disabled' (default) ignores binding fields;
     * 'advisory' reports mismatches on validation; 'strict' rejects with
     * reason 'binding_mismatch'. IP addresses change (NAT, mobile), user
     * agents are spoofable, device ids may be absent — do not enable strict
     * binding lightly.
     */
    bindingPolicy: SessionBindingPolicySchema.default('disabled'),

    /**
     * Security versioning. When enabled, validate() requires the session's
     * securityVersion to match the current version stored at
     * `{ns}:security-version:{userId}`. Use setSecurityVersion(userId, v)
     * after password changes / MFA resets to invalidate all older sessions.
     */
    securityVersion: z
      .object({
        enabled: z.boolean().default(false),
      })
      .prefault({}),

    /**
     * Optional global JTI -> userId lookup index.
     *
     * Default: false. Prefer passing userId to validate()/get()/rotate() —
     * the authentication layer already knows it, and the index adds a write,
     * a read, a second consistency boundary and a second key family. The
     * index is NEVER authoritative: the session record is. It has its own
     * TTL, self-heals on read, and a missing entry is not proof of absence
     * (see docs/architecture for exact semantics).
     */
    jtiIndex: z
      .object({
        enabled: z.boolean().default(false),
      })
      .prefault({}),

    /**
     * Check the revocation store during validate(). Off by default:
     * in-record revocation (status revoked/consumed) already covers rotation
     * reuse and session-level revoke; the revocation store is for external
     * JTI revocations (e.g. JWT jti denylists) and adds a second read.
     */
    checkRevocationStore: z.boolean().default(false),

    /** Optional AES-256-GCM encryption at rest. Default: disabled. */
    encryption: SessionEncryptionConfigSchema.prefault({}),

    /** Optional fail-closed circuit breaker. Default: disabled. */
    circuitBreaker: SessionCircuitBreakerConfigSchema,

    /** Metrics collection. Default: enabled (no-op without an adapter). */
    metrics: SessionMetricsConfigSchema.prefault({}),

    /** Health check thresholds. */
    health: SessionHealthConfigSchema.prefault({}),

    /** Cookie defaults for the framework-independent cookie manager. */
    cookie: SessionCookieConfigSchema.prefault({}),

    /** Operational limits (memory, Lua, pipeline bounds). */
    limits: SessionLimitsConfigSchema.prefault({}),

    /**
     * Idempotent creation: when SessionCreateInput.idempotencyKey is set,
     * store a short-lived claim so retries return the original session.
     * Default: false.
     */
    enableCreateIdempotency: z.boolean().default(false),

    /**
     * Retain a short-lived consumed tombstone after rotation instead of
     * deleting the old record, enabling replay detection. The tombstone is
     * bounded by the remaining absolute lifetime. Default: true.
     */
    retainConsumedTombstones: z.boolean().default(true),
  })
  .superRefine((data, ctx) => {
    if (data.idleTimeout !== null && data.idleTimeout > data.ttl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'idleTimeout must not exceed ttl (absolute lifetime)',
        path: ['idleTimeout'],
      });
    }
    if (data.touchInterval > data.ttl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'touchInterval must not exceed ttl',
        path: ['touchInterval'],
      });
    }
  });

export type SessionConfig = z.infer<typeof SessionConfigSchema>;

export type SessionConfigInput = z.input<typeof SessionConfigSchema>;

/** Raw unparsed config (partial, defaults applied). */
export type PartialSessionConfig = Partial<SessionConfigInput>;

/**
 * Parses and validates session configuration.
 *
 * @throws {SessionConfigurationError} with a safe message on invalid config.
 */
export function parseSessionConfig(input: PartialSessionConfig = {}): SessionConfig {
  try {
    return SessionConfigSchema.parse(input) as SessionConfig;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      const where = first?.path.length ? ` at "${first.path.join('.')}"` : '';
      throw new SessionConfigurationError(
        `Invalid session configuration${where}: ${first?.message ?? 'unknown error'}`,
      );
    }
    throw error;
  }
}

/**
 * Returns a redacted copy of the config suitable for logging.
 * Strips nothing by default (no secrets are allowed in config), but the
 * serializer is explicit so future secret-bearing fields cannot leak.
 */
export function redactSessionConfig(config: SessionConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    namespace: config.namespace,
    tokenBytes: config.tokenBytes,
    ttl: config.ttl,
    idleTimeout: config.idleTimeout,
    rolling: config.rolling,
    touchInterval: config.touchInterval,
    maxSessionsPerUser: config.maxSessionsPerUser,
    bindingPolicy: config.bindingPolicy,
    securityVersion: config.securityVersion.enabled,
    jtiIndex: config.jtiIndex.enabled,
    checkRevocationStore: config.checkRevocationStore,
    encryption: { enabled: config.encryption.enabled },
    circuitBreaker: { enabled: config.circuitBreaker.enabled },
    cookie: { name: config.cookie.name, secure: config.cookie.secure },
  };
}
