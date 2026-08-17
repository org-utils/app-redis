import { RedisClientWrapper } from './client.js';

import { EventEmitter } from 'node:events';
import { RedisConfig } from './types.js';
import { defaultLogger, LoggerLike } from './logger.js';

/**
 * Redis Pub/Sub with a dedicated publisher and subscriber connection.
 *
 * Messages are JSON-serialized on publish and auto-parsed on delivery.
 * Extends `EventEmitter` and emits `'error'` on subscriber failures.
 *
 * Works in all three modes (standalone, sentinel, cluster).
 *
 * @example
 * ```ts
 * const pubsub = new PubSub(client);
 * await pubsub.connectSubscriber(redisConfig);
 *
 * await pubsub.subscribe('orders:created', (message) => {
 *   console.log(message); // { id: 1 }
 * });
 * await pubsub.publish('orders:created', { id: 1 });
 * ```
 */
export class PubSub extends EventEmitter {
  private publisher: RedisClientWrapper;
  private subscriber: RedisClientWrapper | null = null;
  private logger: LoggerLike;
  private subscriptions: Map<string, Set<(data: any) => void>> = new Map();
  private patternSubscriptions: Map<string, Set<(data: any) => void>> = new Map();

  /**
   * Creates a pub/sub instance. Publishing works immediately; subscribing
   * requires calling {@link connectSubscriber} first.
   *
   * @param publisher - A {@link RedisClientWrapper} used for publishing.
   * @param logger - Optional pino-compatible logger; defaults to `console`.
   *
   * @example
   * ```ts
   * const pubsub = new PubSub(client);
   * ```
   */
  constructor(publisher: RedisClientWrapper, logger: LoggerLike = defaultLogger) {
    super();
    this.publisher = publisher;
    this.logger = logger.child({ component: 'PubSub' });
  }

  /**
   * Opens a dedicated subscriber connection.
   *
   * Idempotent: a second call is a no-op while a subscriber is connected.
   * Subscriber errors are emitted as `'error'` events on the instance.
   *
   * @param config - Redis config for the subscriber connection (any mode).
   *
   * @example
   * ```ts
   * await pubsub.connectSubscriber({ mode: 'standalone', host: 'localhost', port: 6379 });
   * ```
   */
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

  /**
   * Publishes a message to a channel.
   *
   * Non-string values are JSON-serialized.
   *
   * @param channel - The channel name.
   * @param message - The message payload (string or any JSON-serializable value).
   * @returns The number of subscribers that received the message.
   *
   * @example
   * ```ts
   * const receivers = await pubsub.publish('orders:created', { id: 1, total: 99 });
   * ```
   */
  async publish<T = any>(channel: string, message: T): Promise<number> {
    const raw = typeof message === 'string' ? message : JSON.stringify(message);
    return this.publisher.raw.publish(channel, raw);
  }

  /**
   * Subscribes a handler to a channel.
   *
   * Multiple handlers per channel are supported; the channel is subscribed on
   * Redis only once. Delivered payloads are JSON-parsed when possible.
   *
   * @param channel - The channel name.
   * @param handler - Callback receiving the (parsed) message.
   * @throws `Error` if the subscriber connection is not open.
   *
   * @example
   * ```ts
   * await pubsub.subscribe('orders:created', (order) => {
   *   console.log(order.id);
   * });
   * ```
   */
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

  /**
   * Removes a handler (or all handlers) from a channel.
   *
   * The Redis subscription is dropped once the last handler for the channel is
   * removed. Without a handler, the whole channel is unsubscribed.
   *
   * @param channel - The channel name.
   * @param handler - Optional specific handler to remove; when omitted all
   *   handlers for the channel are removed.
   *
   * @example
   * ```ts
   * await pubsub.unsubscribe('orders:created', myHandler);
   * await pubsub.unsubscribe('orders:created'); // remove everything
   * ```
   */
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

  /**
   * Subscribes a handler to all channels matching a glob pattern.
   *
   * Pattern handlers receive `{ channel, message }` (message JSON-parsed).
   *
   * @param pattern - Glob pattern, e.g. `'orders:*'`.
   * @param handler - Callback receiving `{ channel, message }`.
   * @throws `Error` if the subscriber connection is not open.
   *
   * @example
   * ```ts
   * await pubsub.psubscribe('orders:*', ({ channel, message }) => {
   *   console.log(channel, message);
   * });
   * ```
   */
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

  /**
   * Removes a handler (or all handlers) from a pattern subscription.
   *
   * @param pattern - The glob pattern.
   * @param handler - Optional specific handler to remove; when omitted all
   *   handlers for the pattern are removed.
   *
   * @example
   * ```ts
   * await pubsub.punsubscribe('orders:*', myHandler);
   * await pubsub.punsubscribe('orders:*');
   * ```
   */
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

  /**
   * Closes the subscriber connection and clears all subscriptions.
   *
   * The publisher client is not closed (it is owned by the caller).
   *
   * @example
   * ```ts
   * await pubsub.close();
   * ```
   */
  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.close();
      this.subscriber = null;
    }
    this.subscriptions.clear();
    this.patternSubscriptions.clear();
  }

  /**
   * Returns subscription statistics.
   *
   * @returns `{ subscriptions, patternSubscriptions, connected }`.
   *
   * @example
   * ```ts
   * const stats = pubsub.getStats();
   * // { subscriptions: 2, patternSubscriptions: 1, connected: true }
   * ```
   */
  getStats() {
    return {
      subscriptions: this.subscriptions.size,
      patternSubscriptions: this.patternSubscriptions.size,
      connected: this.subscriber !== null,
    };
  }
}
