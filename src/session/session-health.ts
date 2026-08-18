import type { RedisClientWrapper } from '../client.js';
import type { SessionHealthConfig } from './session-config.js';

/* -------------------------------------------------------------------------- */
/* Session dependency health: PING latency plus a sliding-window error rate    */
/* fed by the service's recent operations.                                     */
/*                                                                             */
/* healthy=false means the session subsystem should be treated as degraded     */
/* (load balancers may shed, dashboards should page). It does NOT affect       */
/* per-request semantics: requests still fail closed individually.            */
/* -------------------------------------------------------------------------- */

export interface SessionHealthStatus {
  /** True when PING latency and the recent error rate are within thresholds. */
  healthy: boolean;
  /** PING round trip in milliseconds, or null when the probe itself failed. */
  latencyMs: number | null;
  /** Recent operation error rate (0..1) from the sliding window. */
  errorRate: number;
  /** True when Redis is reachable at all (PING succeeded). */
  reachable: boolean;
  /** Unix ms of the last probe. */
  checkedAt: number;
}

/**
 * Periodic PING probe + sliding-window error rate for the session dependency.
 *
 * Error-rate sampling is fed by {@link recordOp}; a PING probe runs on every
 * {@link check}. Both signals must be healthy for the overall status to be
 * healthy.
 */
export class SessionHealthChecker {
  private readonly client: RedisClientWrapper;
  private readonly config: SessionHealthConfig;
  private readonly now: () => number;
  private readonly results: boolean[] = [];

  constructor(
    client: RedisClientWrapper,
    config: SessionHealthConfig,
    options: { now?: () => number } = {},
  ) {
    this.client = client;
    this.config = config;
    this.now = options.now ?? (() => Date.now());
  }

  /** Feeds one operation outcome into the sliding window. */
  recordOp(success: boolean): void {
    this.results.push(success);
    const max = this.config.errorWindowSize;
    if (this.results.length > max) {
      this.results.splice(0, this.results.length - max);
    }
  }

  private errorRate(): number {
    if (this.results.length === 0) return 0;
    let failures = 0;
    for (const ok of this.results) {
      if (!ok) failures += 1;
    }
    return failures / this.results.length;
  }

  /**
   * Runs a PING probe and returns the current health status.
   * Never throws: probe failures surface as `reachable: false`.
   */
  async check(): Promise<SessionHealthStatus> {
    const checkedAt = this.now();
    const started = performance.now();
    let reachable = true;
    let latencyMs: number | null = null;

    try {
      const pong = await this.client.raw.ping();
      reachable = pong === 'PONG' || pong === true || pong === 'pong';
      latencyMs = Math.round(performance.now() - started);
    } catch {
      reachable = false;
      latencyMs = null;
    }

    const errorRate = this.errorRate();
    const healthy =
      reachable &&
      (latencyMs === null || latencyMs <= this.config.latencyThresholdMs) &&
      errorRate <= this.config.errorRateThreshold;

    return { healthy, latencyMs, errorRate, reachable, checkedAt };
  }
}