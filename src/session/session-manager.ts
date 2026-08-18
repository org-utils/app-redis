import type { RedisClientWrapper } from '../client.js';
import { SessionConfigurationError } from './session-errors.js';
import type { RevocationStore } from './session-types.js';
import { SessionCircuitBreaker } from './session-circuit-breaker.js';
import { parseSessionConfig } from './session-config.js';
import type { PartialSessionConfig, SessionConfig } from './session-config.js';
import { SessionCookieManager } from './session-cookie.js';
import { SessionHealthChecker } from './session-health.js';
import type { SessionKeyProvider } from './session-encryption.js';
import { SessionKeyStrategy } from './session-keys.js';
import { SessionMetrics } from './session-metrics.js';
import type { SessionMetricsAdapter } from './session-metrics.js';
import { SessionRepository } from './session-repository.js';
import { SessionScriptRegistry } from './session-scripts.js';
import { SessionService } from './session-service.js';
import { SessionTokenManager } from './session-token.js';

/* -------------------------------------------------------------------------- */
/* SessionManager: composition root for the session subsystem.                 */
/*                                                                             */
/* Creates the token manager, key strategy, script registry, repository,       */
/* metrics/breaker/health, cookie manager and the service. The client (and     */
/* any encryption key provider) is owned by the application.                   */
/* -------------------------------------------------------------------------- */

export type SessionManagerOptions = {
  /** Redis client (standalone, sentinel or cluster - all supported). */
  client: RedisClientWrapper;
  /** Session configuration (defaults applied; see SessionConfigSchema). */
  config?: PartialSessionConfig;
  /**
   * Encryption key provider. REQUIRED when config.encryption.enabled is
   * true (fail at construction rather than at first write). The provider
   * should be backed by a KMS/vault in production.
   */
  encryptionKeyProvider?: SessionKeyProvider;
  /** External revocation store (JWT jti denylists etc.). */
  revocationStore?: RevocationStore;
  /** Metrics adapter (no-op without it). */
  metricsAdapter?: SessionMetricsAdapter;
  /** Optional circuit breaker (enabled via config.circuitBreaker.enabled). */
  circuitBreaker?: SessionCircuitBreaker;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class SessionManager {
  readonly config: SessionConfig;
  readonly service: SessionService;
  readonly repository: SessionRepository;
  readonly metrics: SessionMetrics;
  readonly circuitBreaker: SessionCircuitBreaker | null;
  readonly health: SessionHealthChecker;
  readonly cookies: SessionCookieManager;
  readonly token: SessionTokenManager;
  readonly keys: SessionKeyStrategy;

  private readonly scripts: SessionScriptRegistry;
  private readonly client: RedisClientWrapper;

  constructor(options: SessionManagerOptions) {
    const config = parseSessionConfig(options.config);

    if (config.encryption.enabled && !options.encryptionKeyProvider) {
      throw new SessionConfigurationError(
        'encryptionKeyProvider is required when config.encryption.enabled is true.',
      );
    }
    if (!config.enabled) {
      // Constructing an enabled-by-default subsystem would surprise; the
      // manager is inert until config.enabled is explicitly set.
      throw new SessionConfigurationError(
        'Session subsystem is not enabled: set config.enabled = true to opt in.',
      );
    }

    this.client = options.client;
    this.config = config;
    this.token = new SessionTokenManager(config.tokenBytes);
    this.keys = new SessionKeyStrategy(config.namespace);
    this.scripts = new SessionScriptRegistry(options.client);
    this.repository = new SessionRepository({
      client: options.client,
      keys: this.keys,
      config,
      scripts: this.scripts,
      keyProvider: options.encryptionKeyProvider ?? null,
    });

    this.metrics = new SessionMetrics(options.metricsAdapter, options.client.mode);

    this.circuitBreaker =
      options.circuitBreaker ??
      (config.circuitBreaker.enabled
        ? new SessionCircuitBreaker(config.circuitBreaker, {
            onTransition: (state) => this.metrics.breakerState(state),
          })
        : null);

    this.health = new SessionHealthChecker(options.client, config.health, {
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    this.cookies = new SessionCookieManager(config.cookie);

    this.service = new SessionService({
      config,
      client: options.client,
      repository: this.repository,
      token: this.token,
      keys: this.keys,
      ...(options.revocationStore !== undefined
        ? { revocationStore: options.revocationStore }
        : {}),
      metrics: this.metrics,
      ...(this.circuitBreaker !== null ? { circuitBreaker: this.circuitBreaker } : {}),
      health: this.health,
      ...(options.now !== undefined ? { now: options.now } : {}),
    });

    // Preload scripts in the background; the EVALSHA + NOSCRIPT fallback
    // keeps working until (and after) the preload finishes.
    void this.scripts.preload();
  }

  /** Preloads Lua scripts now (awaits SCRIPT LOAD on all nodes). */
  async init(): Promise<void> {
    await this.scripts.preload();
  }

  /** No-op for symmetry: the client is owned by the application. */
  close(): void {
    this.scripts.invalidate();
  }
}

/**
 * Creates a session manager. Synchronous: use `await manager.init()` when
 * eager script preloading matters (first call latency).
 *
 * @throws {SessionConfigurationError} when the config is invalid, encryption
 *   is enabled without a key provider, or sessions are not explicitly enabled.
 */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  return new SessionManager(options);
}
