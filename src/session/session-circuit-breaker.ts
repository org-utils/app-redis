import { CircuitBreakerOpenError } from './session-errors.js';
import type { SessionCircuitBreakerConfig } from './session-config.js';

/* -------------------------------------------------------------------------- */
/* Fail-closed circuit breaker for session storage calls.                      */
/*                                                                             */
/* When Redis degrades, authentication MUST fail fast with CircuitBreakerOpenError*/
/* (mapped to 503 by the application) instead of piling requests onto a dying  */
/* connection. Default: disabled (no breaker, no overhead).                    */
/*                                                                             */
/* States:                                                                     */
/*   closed     - normal operation. Failures count towards failureThreshold.   */
/*   open       - all calls fail fast for resetTimeoutMs.                      */
/*   half_open  - probe requests allowed (halfOpenMaxRequests). First success  */
/*                closes; first failure reopens.                               */
/*                                                                             */
/* The breaker is process-local by design: in multi-instance deployments each  */
/* instance keeps its own state, which is the correct trade-off (failures are  */
/* usually local to a connection/instance).                                    */
/*                                                                             */
/* All state transitions happen synchronously; in Node's single-threaded event */
/* loop this is race-free (no await can interleave within one mutation).       */
/* -------------------------------------------------------------------------- */

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

interface CircuitState {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number;
  halfOpenInFlight: number;
  halfOpenSucceeded: number;
}

/**
 * Fail-closed circuit breaker around session storage operations.
 *
 * `run()` executes a function while the circuit is closed or a half-open
 * probe is allowed, and throws {@link CircuitBreakerOpenError} when open.
 * Callers may instead use {@link tryAcquire} / {@link recordSuccess} /
 * {@link recordFailure} explicitly.
 */
export class SessionCircuitBreaker {
  private readonly config: SessionCircuitBreakerConfig;
  private readonly circuit: CircuitState;
  private readonly now: () => number;
  private readonly onTransition: ((state: CircuitBreakerState) => void) | null;

  constructor(
    config: SessionCircuitBreakerConfig,
    options: {
      now?: () => number;
      onTransition?: (state: CircuitBreakerState) => void;
    } = {},
  ) {
    this.config = config;
    this.now = options.now ?? (() => Date.now());
    this.onTransition = options.onTransition ?? null;
    this.circuit = {
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: 0,
      halfOpenInFlight: 0,
      halfOpenSucceeded: 0,
    };
  }

  get state(): CircuitBreakerState {
    return this.circuit.state;
  }

  /**
   * Runs an operation under circuit protection. Records success/failure
   * based on the promise outcome.
   *
   * @throws {CircuitBreakerOpenError} when the circuit is open.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.tryAcquire()) {
      throw new CircuitBreakerOpenError();
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Attempts to acquire a call slot synchronously. Returns false (fail
   * closed) when the circuit is open and not yet ready for probes.
   */
  tryAcquire(): boolean {
    this.rollHalfOpen();

    if (this.circuit.state === 'closed') return true;

    if (this.circuit.state === 'half_open') {
      if (this.circuit.halfOpenInFlight >= this.config.halfOpenMaxRequests) {
        return false;
      }
      this.circuit.halfOpenInFlight += 1;
      return true;
    }

    return false;
  }

  /** Records a successful operation (closes a half-open circuit). */
  recordSuccess(): void {
    if (this.circuit.state === 'closed') {
      this.circuit.consecutiveFailures = 0;
      return;
    }
    if (this.circuit.state !== 'half_open') return;

    this.circuit.halfOpenInFlight = Math.max(0, this.circuit.halfOpenInFlight - 1);
    this.circuit.halfOpenSucceeded += 1;
    if (this.circuit.halfOpenInFlight === 0 && this.circuit.halfOpenSucceeded >= 1) {
      this.transitionTo('closed');
    }
  }

  /** Records a failed operation (may open the circuit). */
  recordFailure(): void {
    if (this.circuit.state === 'closed') {
      this.circuit.consecutiveFailures += 1;
      if (this.circuit.consecutiveFailures >= this.config.failureThreshold) {
        this.transitionTo('open');
      }
      return;
    }

    if (this.circuit.state === 'half_open') {
      this.circuit.halfOpenInFlight = Math.max(0, this.circuit.halfOpenInFlight - 1);
      this.transitionTo('open');
    }
  }

  /** Evaluates whether the open timer has elapsed, rolling to half-open. */
  private rollHalfOpen(): void {
    if (
      this.circuit.state === 'open' &&
      this.now() - this.circuit.openedAt >= this.config.resetTimeoutMs
    ) {
      this.circuit.state = 'half_open';
      this.circuit.halfOpenInFlight = 0;
      this.circuit.halfOpenSucceeded = 0;
      this.onTransition?.('half_open');
    }
  }

  private transitionTo(state: CircuitBreakerState): void {
    if (this.circuit.state === state) return;

    this.circuit.state = state;
    if (state === 'open') {
      this.circuit.openedAt = this.now();
      this.circuit.halfOpenInFlight = 0;
      this.circuit.halfOpenSucceeded = 0;
    }
    if (state === 'half_open') {
      this.circuit.halfOpenInFlight = 0;
      this.circuit.halfOpenSucceeded = 0;
    }
    if (state === 'closed') {
      this.circuit.consecutiveFailures = 0;
      this.circuit.halfOpenInFlight = 0;
      this.circuit.halfOpenSucceeded = 0;
    }

    this.onTransition?.(state);
  }

  /** Resets the breaker to closed (admin/repair). */
  reset(): void {
    this.transitionTo('closed');
  }
}