import { RedisClientWrapper } from './client.js';
import { Logger } from '@dev_config/logger';

import { EventEmitter } from 'node:events';
import { RedisConfig } from './types.js';

export class PubSub extends EventEmitter {
  private publisher: RedisClientWrapper;
  private subscriber: RedisClientWrapper | null = null;
  private logger: Logger;
  private subscriptions: Map<string, Set<(data: any) => void>> = new Map();
  private patternSubscriptions: Map<string, Set<(data: any) => void>> = new Map();

  constructor(publisher: RedisClientWrapper, logger: Logger) {
    super();
    this.publisher = publisher;
    this.logger = logger.child({ component: 'PubSub' });
  }

  async connectSubscriber(config: RedisConfig): Promise<void> {
    if (this.subscriber) return;

    this.subscriber = new RedisClientWrapper(config, this.logger);
    this.setupSubscriber();
  }

  private setupSubscriber(): void {
    if (!this.subscriber) return;

    const raw = this.subscriber.raw;

    raw.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });

    raw.on('pmessage', (pattern: string, channel: string, message: string) => {
      this.handlePatternMessage(pattern, channel, message);
    });

    raw.on('error', (error) => {
      this.logger.error('Subscriber error:', error);
      this.emit('error', error);
    });
  }

  private handleMessage(channel: string, message: string): void {
    const handlers = this.subscriptions.get(channel);
    if (!handlers) return;

    let parsed: any = message;
    try { parsed = JSON.parse(message); } catch {}

    for (const handler of handlers) {
      try {
        handler(parsed);
      } catch (error) {
        this.logger.error('Handler error:', error as Record<string, any>);
      }
    }
  }

  private handlePatternMessage(pattern: string, channel: string, message: string): void {
    const handlers = this.patternSubscriptions.get(pattern);
    if (!handlers) return;

    let parsed: any = message;
    try { parsed = JSON.parse(message); } catch {}

    for (const handler of handlers) {
      try {
        handler({ channel, message: parsed });
      } catch (error) {
        this.logger.error('Handler error:', error as Record<string, any>);
      }
    }
  }

  async publish<T = any>(channel: string, message: T): Promise<number> {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    return this.publisher.raw.publish(channel, raw);
  }

  async subscribe<T = any>(
    channel: string,
    handler: (data: T) => void
  ): Promise<void> {
    if (!this.subscriber) {
      throw new Error('Subscriber not connected');
    }

    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
      await this.subscriber.raw.subscribe(channel);
    }

    this.subscriptions.get(channel)!.add(handler);
    this.logger.debug('Subscribed to channel', { channel });
  }

  async unsubscribe<T = any>(
    channel: string,
    handler?: (data: T) => void
  ): Promise<void> {
    if (!this.subscriber) return;

    if (handler && this.subscriptions.has(channel)) {
      const handlers = this.subscriptions.get(channel)!;
      handlers.delete(handler);

      if (handlers.size === 0) {
        this.subscriptions.delete(channel);
        await this.subscriber.raw.unsubscribe(channel);
      }
    } else {
      this.subscriptions.delete(channel);
      await this.subscriber.raw.unsubscribe(channel);
    }
  }

  async psubscribe<T = any>(
    pattern: string,
    handler: (data: { channel: string; message: T }) => void
  ): Promise<void> {
    if (!this.subscriber) {
      throw new Error('Subscriber not connected');
    }

    if (!this.patternSubscriptions.has(pattern)) {
      this.patternSubscriptions.set(pattern, new Set());
      await this.subscriber.raw.psubscribe(pattern);
    }

    this.patternSubscriptions.get(pattern)!.add(handler);
  }

  async punsubscribe(
    pattern: string,
    handler?: (data: any) => void
  ): Promise<void> {
    if (!this.subscriber) return;

    if (handler && this.patternSubscriptions.has(pattern)) {
      const handlers = this.patternSubscriptions.get(pattern)!;
      handlers.delete(handler);

      if (handlers.size === 0) {
        this.patternSubscriptions.delete(pattern);
        await this.subscriber.raw.punsubscribe(pattern);
      }
    } else {
      this.patternSubscriptions.delete(pattern);
      await this.subscriber.raw.punsubscribe(pattern);
    }
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.close();
      this.subscriber = null;
    }
    this.subscriptions.clear();
    this.patternSubscriptions.clear();
  }

  getStats() {
    return {
      subscriptions: this.subscriptions.size,
      patternSubscriptions: this.patternSubscriptions.size,
      connected: this.subscriber !== null,
    };
  }
}
