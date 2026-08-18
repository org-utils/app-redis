/* -------------------------------------------------------------------------- */
/* Session metrics: minimal, dependency-free observability.                    */
/*                                                                             */
/* An adapter is injected by the application (Prometheus, StatsD, OpenTelemetry*/
/* - whichever the app already uses). Without an adapter every call is a       */
/* no-op; metrics never throw and never affect the hot path.                   */
/*                                                                             */
/* No session tokens or raw identifiers ever reach a metric label.             */
/* -------------------------------------------------------------------------- */

/** Application-provided metrics sink. Implementations must be non-throwing. */
export interface SessionMetricsAdapter {
  /** Increments a counter by delta (default 1). */
  incCounter(name: string, delta?: number, attributes?: Record<string, string | number>): void;
  /** Records a duration sample (milliseconds). */
  recordHistogram(name: string, value: number, attributes?: Record<string, string | number>): void;
  /** Sets a gauge to a value. */
  setGauge(name: string, value: number, attributes?: Record<string, string | number>): void;
}

export type SessionOperation =
  | 'create'
  | 'validate'
  | 'touch'
  | 'rotate'
  | 'update'
  | 'destroy'
  | 'revoke'
  | 'revoke_all'
  | 'delete_by_user'
  | 'list'
  | 'find_by_user'
  | 'set_security_version'
  | 'health';

const OPERATIONS: readonly SessionOperation[] = [
  'create',
  'validate',
  'touch',
  'rotate',
  'update',
  'destroy',
  'revoke',
  'revoke_all',
  'delete_by_user',
  'list',
  'find_by_user',
  'set_security_version',
  'health',
];

/**
 * Internal session metrics facade. Safe no-op without an adapter.
 */
export class SessionMetrics {
  private readonly adapter: SessionMetricsAdapter | null;
  private readonly topology: string | null;

  constructor(adapter?: SessionMetricsAdapter | null, topology?: string) {
    this.adapter = adapter ?? null;
    this.topology = topology ?? null;
  }

  /** Adds the constant topology label to an attribute set. */
  private withTopology(
    attributes: Record<string, string | number>,
  ): Record<string, string | number> {
    if (this.topology !== null) attributes.topology = this.topology;
    return attributes;
  }

  /** Counts a completed session operation, with its outcome. */
  operation(op: SessionOperation, outcome: 'ok' | 'error' | 'invalid', code?: string): void {
    if (!this.adapter) return;
    try {
      const attributes: Record<string, string | number> = { outcome };
      if (code) attributes.code = code;
      this.adapter.incCounter(`session.${op}.total`, 1, this.withTopology(attributes));
    } catch {
      // Metrics must never break authentication.
    }
  }

  /** Records operation latency in milliseconds. */
  latency(op: SessionOperation, ms: number): void {
    if (!this.adapter) return;
    try {
      this.adapter.recordHistogram(
        `session.${op}.duration_ms`,
        ms,
        this.topology !== null ? { topology: this.topology } : undefined,
      );
    } catch {
      // Metrics must never break authentication.
    }
  }

  /** Records the circuit breaker state transition. */
  breakerState(state: 'closed' | 'open' | 'half_open'): void {
    if (!this.adapter) return;
    try {
      this.adapter.setGauge(
        'session.circuit_breaker.state',
        state === 'open' ? 2 : state === 'half_open' ? 1 : 0,
        this.topology !== null ? { topology: this.topology } : undefined,
      );
      this.adapter.incCounter(`session.circuit_breaker.${state}`, 1, this.withTopology({}));
    } catch {
      // Metrics must never break authentication.
    }
  }

  /** Records a fail-closed revocation-store failure (a security-relevant miss). */
  revocationMiss(): void {
    if (!this.adapter) return;
    try {
      this.adapter.incCounter(
        'session.revocation_store.fail_closed',
        1,
        this.topology !== null ? { topology: this.topology } : undefined,
      );
    } catch {
      // Metrics must never break authentication.
    }
  }

  /** Records encryption failures (key rotation issues, corruption). */
  encryptionError(reason: string): void {
    if (!this.adapter) return;
    try {
      this.adapter.incCounter(
        'session.encryption.errors',
        1,
        this.withTopology({ reason }),
      );
    } catch {
      // Metrics must never break authentication.
    }
  }

  /** Records a failed best-effort jti index write (derived-state degradation). */
  jtiIndexWriteFailure(): void {
    if (!this.adapter) return;
    try {
      this.adapter.incCounter(
        'session.jti_index.write_failures',
        1,
        this.topology !== null ? { topology: this.topology } : undefined,
      );
    } catch {
      // Metrics must never break authentication.
    }
  }
}

export const SESSION_OPERATIONS: readonly SessionOperation[] = OPERATIONS;