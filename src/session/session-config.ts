import { z } from 'zod';

import { SessionConfigurationError } from './session-errors.js';
import { SessionKeyProvider } from './session-encryption.js';
import { RevocationStore } from './session-types.js';

/* -------------------------------------------------------------------------- */
/* Session configuration.                                                      */
/*                                                                             */
/* The public types below (SessionConfig + nested configs) are documented      */
/* interfaces: they are what editors show in intellisense. The Zod schemas     */
/* are the runtime validator; a compile-time shape guard (see bottom) keeps    */
/* the interfaces and schemas in sync.                                         */
/*                                                                             */
/* Secrets (encryption keys, Redis credentials) NEVER live in this config.     */
/* Encryption keys are injected via a SessionKeyProvider at construction.      */
/* -------------------------------------------------------------------------- */

/** Default absolute session lifetime: 7 days. */
export const TTL = 7 * 24 * 60 * 60;
/** Default idle timeout: 24 hours. */
export const IDLE_TIMEOUT = 24 * 60 * 60;
/** Default touch throttle interval: 5 minutes. */
export const TOUCH_INTERVAL = 5 * 60;
export const SessionStatusSchema = z.enum(['active', 'consumed', 'revoked']);

/** How strictly session binding metadata (IP/UA/device) is enforced. */
export const SessionBindingPolicySchema = z.enum(['disabled', 'advisory', 'strict']);

/** Optional fail-closed circuit breaker around session operations. */
export interface SessionCircuitBreakerConfig {
  /** Enable the fail-closed circuit breaker. Default: false. */
  enabled: boolean;
  /** Consecutive failures needed to open the circuit. */
  failureThreshold: number;
  /** Milliseconds the circuit stays open before half-open probes. */
  resetTimeoutMs: number;
  /** Maximum concurrent probe requests while half-open. */
  halfOpenMaxRequests: number;
}

export const SessionCircuitBreakerConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    failureThreshold: z.number().int().min(1).default(10),
    resetTimeoutMs: z.number().int().min(1000).default(30_000),
    halfOpenMaxRequests: z.number().int().min(1).default(5),
  })
  .prefault({});

/** Optional AES-256-GCM encryption of session data at rest. */
export interface SessionEncryptionConfig {
  /**
   * Enable AES-256-GCM encryption at rest. Default: false.
   *
   * Evaluate first whether transport TLS, ACLs, private networking and
   * infrastructure controls already cover your threat model. Encryption
   * protects session data against a compromised Redis instance or its
   * disk; it does NOT protect against a compromised application process.
   */
  enabled: boolean;
  /**
   * Re-encrypt with the current key version on touch/update (lazy key
   * rotation). Default: true.
   */
  reEncryptOnWrite: boolean;
}

export const SessionEncryptionConfigSchema = z.object({
  enabled: z.boolean().default(false),
  reEncryptOnWrite: z.boolean().default(true),
});

/** Metrics collection for session operations. */
export interface SessionMetricsConfig {
  /**
   * Collect internal session metrics through the injected metrics adapter.
   * When no adapter is provided, metrics are a safe no-op regardless.
   */
  enabled: boolean;
}

export const SessionMetricsConfigSchema = z.object({
  enabled: z.boolean().default(true),
});

/** Health check thresholds for the session dependency. */
export interface SessionHealthConfig {
  /** PING latency above this (ms) marks the dependency degraded. */
  latencyThresholdMs: number;
  /** Recent operation error rate above this marks the dependency degraded. */
  errorRateThreshold: number;
  /** Number of recent operations sampled for the error rate. */
  errorWindowSize: number;
}

export const SessionHealthConfigSchema = z.object({
  latencyThresholdMs: z.number().int().min(1).default(200),
  errorRateThreshold: z.number().min(0).max(1).default(0.1),
  errorWindowSize: z.number().int().min(1).default(100),
});

/** Cookie defaults for the framework-independent cookie manager. */
export interface SessionCookieConfig {
  /** Cookie name. Default: 'sid'. */
  name: string;
  /** Cookie Path attribute. Default: '/'. */
  path: string;
  /** Cookie Domain attribute (empty = host-only cookie). */
  domain?: string;
  /** HttpOnly attribute. Default: true. */
  httpOnly: boolean;
  /** Secure attribute. Default: true. */
  secure: boolean;
  /** SameSite attribute. Default: 'lax'. */
  sameSite: 'strict' | 'lax' | 'none';
  /** Max-Age in seconds (falls back to the session TTL when unset). */
  maxAge?: number;
}

export const SessionCookieConfigSchema = z
  .object({
    name: z.string().min(1).max(128).default('sid'),
    path: z.string().min(1).default('/'),
    domain: z.string().optional(),
    httpOnly: z.boolean().default(true),
    secure: z.boolean().default(true),
    sameSite: z.enum(['strict', 'lax', 'none']).default('lax'),
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

/** Limits protecting Redis memory, Lua and pipelines. */
export interface SessionLimitsConfig {
  /** Maximum serialized metadata size in bytes (reject larger writes). */
  maxMetadataSize: number;
  /** Maximum sessions fetched per list page. */
  maxListPageSize: number;
  /** Maximum session keys touched by one Lua script invocation. */
  maxBatchSize: number;
  /** Maximum concurrent cross-slot pipelines (revokeAll, jti cleanup). */
  maxFanOutConcurrency: number;
  /** Maximum sessions evicted by a single enforce-limit script call. */
  maxEvictionsPerCall: number;
  /** Maximum session deletions per user-request path (revokeAll/destroy-all). */
  maxSessionsPerUserHardCap: number;
}

export const SessionLimitsConfigSchema = z.object({
  maxMetadataSize: z.number().int().min(0).default(4096),
  maxListPageSize: z.number().int().min(1).default(100),
  maxBatchSize: z.number().int().min(1).max(500).default(100),
  maxFanOutConcurrency: z.number().int().min(1).max(64).default(8),
  maxEvictionsPerCall: z.number().int().min(1).max(5000).default(1000),
  maxSessionsPerUserHardCap: z.number().int().min(0).default(10_000),
});

/** Full parsed session configuration (defaults applied by the schema). */
export interface SessionConfig {
  /**
   * Master switch. Sessions are NOT enabled implicitly; an application
   * must explicitly opt in. Default: false.
   */
  enabled: boolean;
  /** Key namespace for all session keys. Default: 'authcore'. */
  namespace: string;
  /**
   * Raw session token entropy in bytes (32 = 256 bits). Minimum 16
   * (128 bits). Default: 32.
   */
  tokenBytes: number;
  /**
   * Absolute session lifetime in seconds (the hard maximum). Redis TTL is
   * derived from this boundary; touch/rolling NEVER extends past it.
   * Default: 7 days.
   */
  ttl: number;
  /**
   * Idle timeout in seconds. When null, sessions never expire through
   * inactivity. Default: 1 day.
   */
  idleTimeout: number | null;
  /**
   * Rolling sessions: valid activity extends the idle boundary (never the
   * absolute boundary). Only meaningful when idleTimeout is set.
   * Default: true.
   */
  rolling: boolean;
  /**
   * Touch throttling in seconds: touch() performs no write when the last
   * activity is more recent than this interval. Default: 300.
   */
  touchInterval: number;
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
  maxSessionsPerUser: number;
  /** Store the device id on creation (advisory binding). Default: false. */
  storeDeviceId: boolean;
  /** Store the IP address on creation (advisory binding). Default: false. */
  storeIpAddress: boolean;
  /** Store the user agent on creation (advisory binding). Default: false. */
  storeUserAgent: boolean;
  /**
   * Session binding policy. 'disabled' (default) ignores binding fields;
   * 'advisory' reports mismatches on validation; 'strict' rejects with
   * reason 'binding_mismatch'. IP addresses change (NAT, mobile), user
   * agents are spoofable, device ids may be absent — do not enable strict
   * binding lightly.
   */
  bindingPolicy: 'disabled' | 'advisory' | 'strict';
  /**
   * Security versioning. When enabled, validate() requires the session's
   * securityVersion to match the current version stored at
   * `{ns}:security-version:{userId}`. Use setSecurityVersion(userId, v)
   * after password changes / MFA resets to invalidate all older sessions.
   */
  securityVersion: { enabled: boolean };
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
  jtiIndex: { enabled: boolean };
  /**
   * Check the revocation store during validate(). Off by default:
   * in-record revocation (status revoked/consumed) already covers rotation
   * reuse and session-level revoke; the revocation store is for external
   * JTI revocations (e.g. JWT jti denylists) and adds a second read.
   */
  checkRevocationStore: boolean;
  /** Optional AES-256-GCM encryption at rest. Default: disabled. */
  encryption: SessionEncryptionConfig;
  /** Optional fail-closed circuit breaker. Default: disabled. */
  circuitBreaker: SessionCircuitBreakerConfig;
  /** Metrics collection. Default: enabled (no-op without an adapter). */
  metrics: SessionMetricsConfig;
  /** Health check thresholds. */
  health: SessionHealthConfig;
  /** Cookie defaults for the framework-independent cookie manager. */
  cookie: SessionCookieConfig;
  /** Operational limits (memory, Lua, pipeline bounds). */
  limits: SessionLimitsConfig;
  /**
   * Idempotent creation: when SessionCreateInput.idempotencyKey is set,
   * store a short-lived claim so retries return the original session.
   * Default: false.
   */
  enableCreateIdempotency: boolean;
  /**
   * Retain a short-lived consumed tombstone after rotation instead of
   * deleting the old record, enabling replay detection. The tombstone is
   * bounded by the remaining absolute lifetime. Default: true.
   */
  retainConsumedTombstones: boolean;
}

export const SessionConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    namespace: z.string().min(1).max(64).default('authcore'),
    tokenBytes: z.number().int().min(16).max(64).default(32),
    ttl: z.number().int().min(1).default(TTL),
    idleTimeout: z.number().int().min(1).nullable().default(IDLE_TIMEOUT),
    rolling: z.boolean().default(true),
    touchInterval: z.number().int().min(0).default(TOUCH_INTERVAL),
    maxSessionsPerUser: z.number().int().min(0).default(20),
    storeDeviceId: z.boolean().default(false),
    storeIpAddress: z.boolean().default(false),
    storeUserAgent: z.boolean().default(false),
    bindingPolicy: SessionBindingPolicySchema.default('disabled'),
    securityVersion: z
      .object({
        enabled: z.boolean().default(false),
      })
      .prefault({}),
    jtiIndex: z
      .object({
        enabled: z.boolean().default(false),
      })
      .prefault({}),
    checkRevocationStore: z.boolean().default(false),
    encryption: SessionEncryptionConfigSchema.prefault({}),
    circuitBreaker: SessionCircuitBreakerConfigSchema,
    metrics: SessionMetricsConfigSchema.prefault({}),
    health: SessionHealthConfigSchema.prefault({}),
    cookie: SessionCookieConfigSchema.prefault({}),
    limits: SessionLimitsConfigSchema.prefault({}),
    enableCreateIdempotency: z.boolean().default(false),
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

/**
 * Compile-time guard: the schema and the documented interfaces must agree
 * in both directions, so the types can never drift from the validator.
 */
type _SchemaMatchesConfig =
  [SessionConfig] extends [z.infer<typeof SessionConfigSchema>]
    ? [z.infer<typeof SessionConfigSchema>] extends [SessionConfig]
      ? true
      : never
    : never;

/** Recursively makes every config field optional (matches the schema's input shape). */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/** Raw unparsed config input (all fields optional, nested included). */
export type SessionConfigInput = DeepPartial<SessionConfig>;

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
