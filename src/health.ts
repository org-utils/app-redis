import { RedisClientWrapper } from './client.js';
import { Logger } from '@dev_config/logger';


export interface HealthStatus {
  healthy: boolean;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
  timestamp: Date;
  details: {
    ping: boolean;
    connections?: number;
    memory?: string;
  };
}

export class HealthChecker {
  private client: RedisClientWrapper;
  private logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private callbacks: ((status: HealthStatus) => void)[] = [];
  private lastStatus: HealthStatus | null = null;

  constructor(client: RedisClientWrapper, logger: Logger) {
    this.client = client;
    this.logger = logger.child({ component: 'HealthChecker' });
  }

  start(interval: number = 10000): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.timer = setInterval(() => {
      this.check().catch((error) => {
        this.logger.error('Health check failed:', error);
      });
    }, interval);

    this.logger.info(`Health checker started (interval: ${interval}ms)`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.logger.info('Health checker stopped');
    }
  }

  async check(): Promise<HealthStatus> {
    const start = Date.now();
    const details: HealthStatus['details'] = {
      ping: false,
    };

    try {
      const ping = await this.client.ping();
      details.ping = ping;

      // Try to get some info
      try {
        const info = await this.client.raw.info();
        const connections = info.match(/connected_clients:(\d+)/)?.[1];
        const memory = info.match(/used_memory_human:([^\n]+)/)?.[1];

        if (connections) details.connections = parseInt(connections, 10);
        if (memory) details.memory = memory.trim();
      } catch {
        // Info not available in cluster mode
      }
    } catch (error) {
      this.logger.error('Health check error:', error as Record<string, any>);
      details.ping = false;
    }

    const latency = Date.now() - start;
    const healthy = details.ping;

    const status: HealthStatus = {
      healthy,
      status: healthy ? 'healthy' : 'unhealthy',
      latency,
      timestamp: new Date(),
      details,
    };

    this.lastStatus = status;
    this.notifyCallbacks(status);
    return status;
  }

  getStatus(): HealthStatus | null {
    return this.lastStatus;
  }

  onChange(callback: (status: HealthStatus) => void): void {
    this.callbacks.push(callback);
  }

  private notifyCallbacks(status: HealthStatus): void {
    for (const callback of this.callbacks) {
      try {
        callback(status);
      } catch (error) {
        this.logger.error('Callback error:', error as Record<string, any>);
      }
    }
  }

  async waitForHealthy(timeout: number = 30000): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const status = await this.check();
      if (status.healthy) return true;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return false;
  }
}
