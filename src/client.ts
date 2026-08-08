import Redis, { Cluster, Redis as RedisClient, RedisOptions } from 'ioredis';

import { RedisError } from './errors.js';
import type { RedisConfig } from './types.js';
import { defaultLogger, type LoggerLike } from './logger.js';
export interface RedisClientOptions { config: RedisConfig; logger?: LoggerLike; }



export class RedisClientWrapper {
  private client: RedisClient | Cluster;
  private config: RedisConfig;
  // private logger: Logger;
  private isReady: boolean = false;
  private readonly logger: LoggerLike;

  // constructor(config: RedisConfig, logger: Logger) {
  //   this.config = config;
  //   this.logger = logger.child({ component: 'RedisClient' });
  //   this.client = this.createClient();
  //   this.setupEventHandlers();
  // }
  constructor(config: RedisConfig, logger: LoggerLike = defaultLogger) {
    this.config = config;

    this.logger = logger.child({
      component: "RedisClient",
    });

    this.client = this.createClient();
    this.setupEventHandlers();
  }

  private createClient(): RedisClient | Cluster {
    const baseOptions = {
      retryStrategy: (times: number) => {
        if (this.config?.maxRetries != null && times > this.config?.maxRetries) return null;
        return Math.min(times * (this.config?.retryDelay ?? 1000), 5000);
      },
      connectTimeout: this.config.connectionTimeout,
      maxRetriesPerRequest: this.config.maxRetries,
      enableReadyCheck: true,
      enableOfflineQueue: true,
      lazyConnect: false,

    };

    switch (this.config.mode) {
      case 'cluster':
        if (!this.config.clusterNodes?.length) {
          throw new RedisError('Cluster nodes required for cluster mode');
        }
        return new Redis.Cluster(
          this.config.clusterNodes.map(n => ({ host: n.host, port: n.port })),
          {
            ...baseOptions,
            scaleReads: 'master',
            redisOptions: this.buildRedisOptions(),
          }
        );

      case 'sentinel':
        if (!this.config.sentinelNodes?.length || !this.config.sentinelMasterName) {
          throw new RedisError('Sentinel nodes and master name required');
        }
        return new RedisClient({
          ...baseOptions,
          sentinel: true,
          sentinelNodes: this.config.sentinelNodes,
          name: this.config.sentinelMasterName,
          ...this.buildRedisOptions(),
        });

      default:
        if (this.config.url) {
          return new RedisClient(this.config.url, {
            ...baseOptions,
            ...this.buildRedisOptions()
          });
        }
        return new RedisClient({
          ...baseOptions,
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          ...this.buildRedisOptions(),
        });
    }
  }

  private buildRedisOptions() {
    const options: any = {
      password: this.config.password,
      username: this.config.username,
    };

    if (this.config.tls) {
      options.tls = this.config.tlsOptions || { rejectUnauthorized: true };
    }

    return options;
  }

  private setupEventHandlers() {
    this.client.on('connect', () => {
      this.logger.info('Redis connected');
    });

    this.client.on('ready', () => {
      this.isReady = true;
      this.logger.info('Redis ready');
    });

    this.client.on('error', (error) => {
      this.logger.error('Redis error:', error);
    });

    this.client.on('close', () => {
      this.isReady = false;
      this.logger.warn('Redis connection closed');
    });

    this.client.on('reconnecting', () => {
      this.logger.info('Redis reconnecting...');
    });
  }

  public getRawClient<T extends RedisClient | Cluster>(): T {
    return this.client as T;
  }
  get raw(): RedisClient | Cluster {
    return this.getRawClient();
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
    this.isReady = false;
  }

  // Type guard for cluster
  private isClusterClient(client: RedisClient | Cluster): client is Cluster {
    return client instanceof Cluster;
  }

  // Command delegation with performance tracking
  private async exec<T>(
    command: string,
    args: any[],
    operation: () => Promise<T>
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await operation();
      const duration = Date.now() - start;

      if (this.config?.slowCommandThreshold != null && duration > this.config?.slowCommandThreshold) {
        this.logger.warn(`Slow command: ${command} took ${duration}ms`, {
          command,
          args: args.slice(0, 5),
          duration
        });
      }

      return result;
    } catch (error) {
      this.logger.error(`Command failed: ${command}`, { command, error });
      throw error;
    }
  }

  // Basic Redis commands
  async get(key: string): Promise<string | null> {
    return this.exec('GET', [key], () => this.client.get(key));
  }

  async set(key: string, value: string | Buffer, ttl?: number): Promise<'OK' | null> {
    return this.exec('SET', [key, value, ttl ? 'EX' : null, ttl], () =>
      ttl ? this.client.set(key, value, 'EX', ttl) : this.client.set(key, value)
    );
  }
  async setexnx(key: string, value: string | Buffer, ttl?: number): Promise<'OK' | null> {
    return this.exec('SET', [key, value, 'NX', ttl ? 'EX' : null, ttl], () =>
      ttl ? this.client.set(key, value,  'EX', ttl, 'NX') : this.client.set(key, value, 'NX')
    );
  }

  // Or expose the methods needed by fastify-rate-limit
  defineCommand(...args: Parameters<RedisClient['defineCommand']>) {
    return this.client.defineCommand(...args);
  }
  async setnx(key: string, value: string | Buffer, ttl?: number): Promise<number> {
    return this.exec('SETNX', [key, value], () =>
      this.client.setnx(key, value).then(result => {
        if (result === 1 && ttl) {
          return this.client.expire(key, ttl).then(() => 1);
        }
        return result;
      })
    );
  }

  async del(...keys: string[]): Promise<number> {
    return this.exec('DEL', keys, () => this.client.del(...keys));
  }

  async exists(key: string): Promise<number> {
    return this.exec('EXISTS', [key], () => this.client.exists(key));
  }

  async expire(key: string, ttl: number): Promise<number> {
    return this.exec('EXPIRE', [key, ttl], () => this.client.expire(key, ttl));
  }

  async ttl(key: string): Promise<number> {
    return this.exec('TTL', [key], () => this.client.ttl(key));
  }

  async incr(key: string): Promise<number> {
    return this.exec('INCR', [key], () => this.client.incr(key));
  }

  async decr(key: string): Promise<number> {
    return this.exec('DECR', [key], () => this.client.decr(key));
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    return this.exec('MGET', keys, () => this.client.mget(...keys));
  }

  async mset(...pairs: [string, string | Buffer][]): Promise<'OK'> {
    const flat = pairs.flat();
    return this.exec('MSET', flat, () => this.client.mset(flat));
  }

  // Hash operations
  async hget(key: string, field: string): Promise<string | null> {
    return this.exec('HGET', [key, field], () => this.client.hget(key, field));
  }

  async hset(key: string, field: string, value: string | Buffer): Promise<number> {
    return this.exec('HSET', [key, field, value], () => this.client.hset(key, field, value));
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.exec('HGETALL', [key], () => this.client.hgetall(key));
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    return this.exec('HDEL', [key, ...fields], () => this.client.hdel(key, ...fields));
  }

  // Set operations
  async sadd(key: string, ...members: string[]): Promise<number> {
    return this.exec('SADD', [key, ...members], () => this.client.sadd(key, ...members));
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return this.exec('SREM', [key, ...members], () => this.client.srem(key, ...members));
  }

  async smembers(key: string): Promise<string[]> {
    return this.exec('SMEMBERS', [key], () => this.client.smembers(key));
  }

  async sismember(key: string, member: string): Promise<number> {
    return this.exec('SISMEMBER', [key, member], () => this.client.sismember(key, member));
  }

  // Sorted set operations
  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.exec('ZADD', [key, score, member], () => this.client.zadd(key, score, member));
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.exec('ZRANGE', [key, start, stop], () => this.client.zrange(key, start, stop));
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return this.exec('ZREM', [key, ...members], () => this.client.zrem(key, ...members));
  }

  // Pipeline for batch operations
  pipeline() {
    return this.client.pipeline();
  }

  // Scan with proper cursor handling
  async *scanIterator(pattern: string, count: number = 100): AsyncIterable<string> {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        count
      );
      cursor = nextCursor;
      for (const key of keys) {
        yield key;
      }
    } while (cursor !== '0');
  }

  // ============ CLUSTER-SPECIFIC METHODS ============

  // Check if we're in cluster mode
  isCluster(): boolean {
    return this.isClusterClient(this.client);
  }

  // Get cluster nodes (cluster mode only)
  getClusterNodes(): any[] {
    if (this.isClusterClient(this.client)) {
      return this.client.nodes();
    }
    return [];
  }

  // Get all nodes with their slots (cluster mode only)
  getClusterSlots(): any {
    if (this.isClusterClient(this.client)) {
      return (this.client as any).slots;
    }
    return null;
  }

  // Calculate Redis hash slot (works in all modes)
  calculateSlot(key: string): number {
    // Redis hash slot calculation algorithm
    // https://redis.io/docs/reference/cluster-spec/
    let slot = 0;

    // Check for hash tags
    const start = key.indexOf('{');
    if (start !== -1) {
      const end = key.indexOf('}', start + 1);
      if (end !== -1 && start + 1 < end) {
        key = key.substring(start + 1, end);
      }
    }

    // CRC16 hash calculation (simplified)
    // In production, use a proper CRC16 implementation
    for (let i = 0; i < key.length; i++) {
      slot = (slot + key.charCodeAt(i)) % 16384;
    }
    return slot;
  }

  // Get node for a specific key (cluster mode only)
  async getNodeForKey(key: string): Promise<any> {
    if (!this.isClusterClient(this.client)) {
      return null;
    }

    try {
      const slot = this.calculateSlot(key);
      // Use the cluster's internal slot mapping
      // The cluster keeps a map of slots to nodes internally
      const clusterClient = this.client as any;

      // Get all nodes
      const nodes = clusterClient.nodes();
      if (!nodes || nodes.length === 0) return null;

      // Find the node that handles this slot
      // The slot mapping is available in the cluster's internal state
      // We need to check which node serves this slot
      for (const node of nodes) {
        // Check if this node serves the slot
        // Each node has information about which slots it serves
        if (node.slots) {
          for (const [startSlot, endSlot] of node.slots) {
            if (slot >= startSlot && slot <= endSlot) {
              return node;
            }
          }
        }
      }

      // If we can't find the specific node, try using the cluster's built-in slot lookup
      // This is available in ioredis cluster
      const node = clusterClient.getSlot(slot);
      return node || null;
    } catch (error) {
      this.logger.warn('Failed to get node for key', { key, error });
      return null;
    }
  }

  // Get all nodes with their slot ranges
  getSlotRanges(): Map<number, string[]> {
    if (!this.isClusterClient(this.client)) {
      return new Map();
    }

    const slotRanges = new Map<number, string[]>();
    const clusterClient = this.client as any;

    try {
      const nodes = clusterClient.nodes();
      for (const node of nodes) {
        const host = node.options?.host || 'unknown';
        const port = node.options?.port || 'unknown';
        const nodeId = `${host}:${port}`;

        if (node.slots) {
          for (const [startSlot, endSlot] of node.slots) {
            for (let slot = startSlot; slot <= endSlot; slot++) {
              if (!slotRanges.has(slot)) {
                slotRanges.set(slot, []);
              }
              slotRanges.get(slot)!.push(nodeId);
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn('Failed to get slot ranges', { error });
    }

    return slotRanges;
  }

  // Check if a key's slot is served by this cluster
  async isKeyServed(key: string): Promise<boolean> {
    if (!this.isClusterClient(this.client)) {
      return true;
    }

    try {
      const node = await this.getNodeForKey(key);
      return node !== null && node !== undefined;
    } catch {
      return false;
    }
  }

  // Execute command on specific node (cluster mode)
  async executeOnNode<T>(
    key: string,
    command: string,
    ...args: any[]
  ): Promise<T> {
    if (this.isClusterClient(this.client)) {
      try {
        const slot = this.calculateSlot(key);
        const clusterClient = this.client as any;
        const node = clusterClient.getSlot(slot);
        if (node && typeof node[command] === 'function') {
          return await node[command](...args);
        }
      } catch (error) {
        this.logger.warn('Failed to execute on specific node, falling back', { error });
      }
    }
    // Fallback to regular execution
    return (this.client as any)[command](...args);
  }

  // Cluster-aware mget - groups keys by slot for efficiency
  async mgetClusterAware(keys: string[]): Promise<(string | null)[]> {
    if (!this.isClusterClient(this.client)) {
      return this.mget(...keys);
    }

    // Group keys by slot
    const groups = new Map<number, string[]>();
    for (const key of keys) {
      const slot = this.calculateSlot(key);
      if (!groups.has(slot)) {
        groups.set(slot, []);
      }
      groups.get(slot)!.push(key);
    }

    // Execute mget for each group on the appropriate node
    const results = new Map<string, string | null>();
    const clusterClient = this.client as any;

    await Promise.all(
      Array.from(groups.entries()).map(async ([slot, slotKeys]) => {
        try {
          const node = clusterClient.getSlot(slot);
          if (node && typeof node.mget === 'function') {
            const values = await node.mget(...slotKeys);
            slotKeys.forEach((key, index) => {
              results.set(key, values[index] || null);
            });
          } else {
            // Fallback
            const values = await this.client.mget(...slotKeys);
            slotKeys.forEach((key, index) => {
              results.set(key, values[index] || null);
            });
          }
        } catch (error) {
          this.logger.error('Failed to execute mget on node', { slot, error });
          // Fallback for this group
          const values = await this.client.mget(...slotKeys);
          slotKeys.forEach((key, index) => {
            results.set(key, values[index] || null);
          });
        }
      })
    );

    return keys.map(key => results.get(key) || null);
  }

  // Delete by pattern with cluster awareness
  async deletePattern(pattern: string): Promise<number> {
    let deleted = 0;
    for await (const key of this.scanIterator(pattern)) {
      const result = await this.del(key);
      deleted += result;
    }
    return deleted;
  }

  // Get cluster information
  getClusterInfo(): any {
    if (this.isClusterClient(this.client)) {
      try {
        const clusterClient = this.client as any;
        const nodes = clusterClient.nodes();
        const slotRanges = this.getSlotRanges();

        return {
          mode: 'cluster',
          status: this.isReady ? 'ready' : 'connecting',
          nodeCount: nodes.length,
          slotCount: slotRanges.size,
          nodes: nodes.map((node: any) => ({
            host: node.options?.host || 'unknown',
            port: node.options?.port || 'unknown',
            role: node.options?.role || 'unknown',
          })),
        };
      } catch (error) {
        return {
          mode: 'cluster',
          status: 'error',
          error: String(error),
        };
      }
    }
    return {
      mode: 'standalone',
      host: this.config.host,
      port: this.config.port,
      status: this.isReady ? 'ready' : 'connecting',
    };
  }

  // Info command - works in all modes
  async info(section?: string): Promise<string> {
    if (section) {
      return this.exec('INFO', [section], () => this.client.info(section));
    }
    return this.exec('INFO', [], () => this.client.info());
  }

  // Select database - only works in standalone mode
  async select(database: number): Promise<'OK'> {
    if (this.isClusterClient(this.client)) {
      throw new RedisError('SELECT not supported in cluster mode', 'CLUSTER_MODE');
    }
    return (this.client as RedisClient).select(database);
  }
}
