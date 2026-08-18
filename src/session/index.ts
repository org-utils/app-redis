export { RedisRevocationStore } from './revocation-store.js';
export type { RedisRevocationStoreOptions } from './revocation-store.js';

export { RevocationBatchError, RevocationError } from './session-errors.js';

export { createSessionManager, SessionManager } from './session-manager.js';
export type { SessionManagerOptions } from './session-manager.js';

export { SessionService } from './session-service.js';
export type { SessionServiceDeps } from './session-service.js';

export { SessionRepository } from './session-repository.js';
export type { SessionScriptRegistryOptions } from './session-scripts.js';
export { SessionScriptRegistry, SCRIPT_NAMES } from './session-scripts.js';
export type { ScriptName } from './session-scripts.js';

export { SessionKeyStrategy, encodeUserId } from './session-keys.js';
export { SessionTokenManager } from './session-token.js';
export {
  StaticSessionKeyProvider,
  createRandomSessionKeyProvider,
  toKeyBuffer,
} from './session-encryption.js';
export {
  serializeSession,
  serializeEncryptedSession,
  deserializeSession,
  validateSessionRecord,
  envelopeKind,
  encryptedHeaderOf,
} from './session-serializer.js';
export {
  parseSessionConfig,
  redactSessionConfig,
  SessionConfigSchema,
  TTL,
  IDLE_TIMEOUT,
  TOUCH_INTERVAL,
} from './session-config.js';
export type {
  SessionConfig,
  SessionConfigInput,
  PartialSessionConfig,
} from './session-config.js';
export {
  SessionError,
  SessionNotFoundError,
  SessionExpiredError,
  SessionRevokedError,
  SessionInvalidError,
  SessionRotationError,
  SessionReplayError,
  SessionStorageError,
  SessionSerializationError,
  SessionConfigurationError,
  SessionConcurrencyError,
  CircuitBreakerOpenError,
  redactIdentifier,
} from './session-errors.js';
export type {
  SessionRecord,
  SessionCreateInput,
  SessionUpdatePatch,
  CreatedSession,
  RotatedSession,
  SessionValidationResult,
  SessionInvalidReason,
  TouchOutcome,
  SessionEnvelope,
} from './session-types.js';

export { SessionMetrics, type SessionMetricsAdapter } from './session-metrics.js';
export { SessionCircuitBreaker } from './session-circuit-breaker.js';
export { SessionHealthChecker } from './session-health.js';
export {
  SessionCookieManager,
  type SerializeCookieOptions,
  type SerializedCookie,
  type SerializedCookieAttributes,
} from './session-cookie.js';
