import { type Redis as RedisType, RedisOptions } from 'ioredis';
import { z } from 'zod';

// ============ Configuration Schema ============
// export const RedisConfigSchema = z.object({
//   // Connection
//   host: z.string().default('localhost'),
//   port: z.number().min(1).max(65535).default(6379).optional(),
//   password: z.string().optional(),
//   username: z.string().optional(),
//   database: z.number().min(0).max(15).default(0).optional(),
//   url: z.url().optional(),
//   // Mode: standalone, sentinel, or cluster
//   mode: z.enum(['standalone', 'sentinel', 'cluster']).default('standalone').optional(),

//   // For sentinel mode
//   sentinelNodes: z.array(z.object({
//     host: z.string(),
//     port: z.number().min(1).max(65535),
//   })).optional(),
//   sentinelMasterName: z.string().optional(),

//   // For cluster mode
//   clusterNodes: z.array(z.object({
//     host: z.string(),
//     port: z.number().min(1).max(65535),
//   })).optional(),

//   // TLS
//   tls: z.boolean().default(false).optional(),
//   tlsOptions: z.object({
//     ca: z.string().optional(),
//     cert: z.string().optional(),
//     key: z.string().optional(),
//     rejectUnauthorized: z.boolean().default(true),
//   }).optional(),

//   // Performance
//   maxRetries: z.number().min(1).max(10).default(3).optional(),
//   retryDelay: z.number().min(100).max(5000).default(1000).optional(),
//   connectionTimeout: z.number().min(1000).default(5000).optional(),
//   maxConnections: z.number().min(1).max(100).default(10).optional(),

//   // Cache defaults
//   defaultTTL: z.number().min(0).default(3600).optional(),
//   compressionThreshold: z.number().min(1).default(1024).optional(),

//   // Observability
//   slowCommandThreshold: z.number().min(0).default(1000).optional(),
// }).superRefine((data, ctx) => {
//   // If mode is standalone, clear unrelated fields
//   if (data.mode === 'standalone') {
//     data.sentinelNodes = undefined;
//     data.sentinelMasterName = undefined;
//     data.clusterNodes = undefined;
//     return; // Skip further validation
//   }

//   // If mode is sentinel, validate sentinel fields are present
//   if (data.mode === 'sentinel') {
//     if (!data.sentinelNodes || data.sentinelNodes.length === 0) {
//       ctx.addIssue({
//         code: z.ZodIssueCode.custom,
//         message: 'sentinelNodes is required for sentinel mode',
//         path: ['sentinelNodes'],
//       });
//     }
//     if (!data.sentinelMasterName) {
//       ctx.addIssue({
//         code: z.ZodIssueCode.custom,
//         message: 'sentinelMasterName is required for sentinel mode',
//         path: ['sentinelMasterName'],
//       });
//     }
//     // Clear cluster fields
//     data.clusterNodes = undefined;
//   }

//   // If mode is cluster, validate cluster fields are present
//   if (data.mode === 'cluster') {
//     if (!data.clusterNodes || data.clusterNodes.length === 0) {
//       ctx.addIssue({
//         code: z.ZodIssueCode.custom,
//         message: 'clusterNodes is required for cluster mode',
//         path: ['clusterNodes'],
//       });
//     }
//     // Clear sentinel fields
//     data.sentinelNodes = undefined;
//     data.sentinelMasterName = undefined;
//   }
// });
// Base config that's common to all modes
/**
 * Configuration fields shared by all connection modes.
 */
const BaseRedisConfig = z.object({
  password: z.string().optional(),
  username: z.string().optional(),
  database: z.number().min(0).max(15).default(0).optional(),

  tls: z.boolean().default(false).optional(),
  tlsOptions: z.object({
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
    rejectUnauthorized: z.boolean().default(true),
  }).optional(),
  maxRetries: z.number().min(1).max(10).default(3).optional(),
  retryDelay: z.number().min(100).max(5000).default(1000).optional(),
  connectionTimeout: z.number().min(1000).default(5000).optional(),
  maxConnections: z.number().min(1).max(100).default(10).optional(),
  defaultTTL: z.number().min(0).default(3600).optional(),
  compressionThreshold: z.number().min(1).default(1024).optional(),
  slowCommandThreshold: z.number().min(0).default(1000).optional(),
});

// Mode-specific configs
/**
 * Standalone (single node) connection config.
 * Requires either a `url` or both `host` and `port`.
 */
const StandaloneConfig = BaseRedisConfig.extend({
  mode: z.literal('standalone').default('standalone'),
  host: z.string().default('localhost').optional(),
  port: z.number().min(1).max(65535).default(6379).optional(),
  url: z.url().optional(),
}).superRefine((data, ctx) => {
  // Validate that either URL is provided OR (host AND port are provided)
  const hasUrl = !!data.url;
  const hasHostAndPort = !!(data.host && data.port);

  if (!hasUrl && !hasHostAndPort) {
    ctx.addIssue({
      code: "custom",
      message: 'Either provide a URL or provide both host and port',
      path: ['url'], // Add error on url field
    });
    ctx.addIssue({
      code: "custom",
      message: 'Either provide a URL or provide both host and port',
      path: ['host'],
    });
  }

  // Optional: If both URL and host/port are provided, you can prefer URL
  // or you can allow both and let the consumer decide
});

/**
 * Sentinel connection config. Requires `sentinelNodes` and `sentinelMasterName`.
 */
const SentinelConfig = BaseRedisConfig.extend({
  mode: z.literal('sentinel'),
  host: z.string().optional(),
  port: z.number().min(1).max(65535).optional(),
  sentinelNodes: z.array(z.object({
    host: z.string(),
    port: z.number().min(1).max(65535),
  })),
  sentinelMasterName: z.string(),
});

/**
 * Cluster connection config. Requires `clusterNodes`.
 */
const ClusterConfig = BaseRedisConfig.extend({
  mode: z.literal('cluster'),
  host: z.string().optional(),
  port: z.number().min(1).max(65535).optional(),
  clusterNodes: z.array(z.object({
    host: z.string(),
    port: z.number().min(1).max(65535),
  })),
});


export const RateLimitAlgorithmSchema = z.enum(['fixed', 'sliding']);

export const RateLimitOptionsSchema = z.object({
  limit: z.number().int().positive().default(100),
  duration: z.number().int().positive().default(60),
  algorithm: RateLimitAlgorithmSchema.default('sliding'),
  namespace: z.string().min(1).default('ratelimit'),
});

export const RedisSettingsSchema = z.object({
  rateLimit: RateLimitOptionsSchema.default({
    algorithm: 'sliding',
    duration: 60,
    limit: 100,
    namespace: 'ratelimit',
  }).optional(),
});


// Union of all configs
/**
 * Zod schema validating the connection config for every mode
 * (`standalone`, `sentinel`, `cluster`) with mode-specific requirements.
 *
 * @example
 * ```ts
 * const config = RedisConfigSchema.parse({
 *   mode: 'standalone',
 *   host: 'localhost',
 *   port: 6379,
 * });
 * ```
 */
 export const RedisConfigSchema = z.discriminatedUnion('mode', [
   StandaloneConfig.extend(RedisSettingsSchema.shape),
   SentinelConfig.extend(RedisSettingsSchema.shape),
   ClusterConfig.extend(RedisSettingsSchema.shape),
 ]);

/**
 * Connection configuration for the Redis client — the inferred type of
 * {@link RedisConfigSchema} (plus ioredis options).
 */
export type RedisConfig = RedisOptions & z.infer<typeof RedisConfigSchema> ;

// ============ Cache Types ============
/**
 * Options for a single cache write.
 */
export interface CacheOptions {
  /** TTL in seconds (falls back to the cache's `defaultTTL`). */
  ttl?: number;
  /** Enable/disable gzip compression for this write. Default: `true`. */
  compress?: boolean;
  /** Namespace prefix, stored as `namespace:key`. */
  namespace?: string;
}

/**
 * Statistics about a cache namespace.
 */
export interface CacheStats {
  /** The namespace being reported on. */
  namespace: string;
  /** Connection status of the underlying client. */
  connectionStatus: any;
}

// ============ Lock Types ============
/**
 * Options for a distributed lock.
 */
export interface LockOptions {
  /** Lock TTL in milliseconds. */
  ttl?: number;
  /** Number of acquisition attempts. */
  retryCount?: number;
  /** Base retry delay in ms (grows exponentially). */
  retryDelay?: number;
}

/**
 * Information about a distributed lock.
 */
export interface LockInfo {
  /** Whether the lock is currently held. */
  locked: boolean;
  /** Remaining TTL in seconds. */
  ttl?: number;
  /** Unique owner id of the lock. */
  lockId?: string;
}

/**
 * Options for the distributed lock (alias of {@link LockOptions}).
 */
export interface DistributedLockOptions {
  /** Lock TTL in milliseconds. */
  ttl?: number;
  /** Number of acquisition attempts. */
  retryCount?: number;
  /** Base retry delay in ms (grows exponentially). */
  retryDelay?: number;
}

// ============ Health Types ============
/**
 * Health check result.
 */
export interface HealthStatus {
  /** Overall health: `true` when the server is reachable and responsive. */
  healthy: boolean;
  /** `'healthy'` | `'degraded'` | `'unhealthy'`. */
  status: 'healthy' | 'degraded' | 'unhealthy';
  /** Round-trip latency of the check in ms. */
  latency: number;
  /** When the check ran. */
  timestamp: Date;
  /** Check details. */
  details: {
    /** Whether the `PING` succeeded. */
    ping: boolean;
    /** Active connections (when available). */
    connections?: number;
    /** Memory usage from `INFO memory` (when available). */
    memory?: string;
  };
}

// ============ Pub/Sub Types ============
/**
 * Pub/Sub subscription statistics.
 */
export interface PubSubStats {
  /** Number of active channel subscriptions. */
  subscriptions: number;
  /** Number of active pattern subscriptions. */
  patternSubscriptions: number;
  /** Whether the subscriber connection is open. */
  connected: boolean;
}

/**
 * A pub/sub message, as delivered to pattern subscription handlers.
 */
export interface PubSubMessage<T = any> {
  /** The channel the message arrived on. */
  channel: string;
  /** The message payload (JSON-parsed when possible). */
  message: T;
}

// ============ Cluster Types ============
/**
 * Snapshot of cluster topology and status.
 */
export interface ClusterInfo {
  /** `'cluster'` when backed by Redis Cluster, `'standalone'` otherwise. */
  mode: 'cluster' | 'standalone';
  /** `'ready'` | `'connecting'` | `'error'`. */
  status: 'ready' | 'connecting' | 'error';
  /** Number of nodes (cluster mode). */
  nodeCount?: number;
  /** Number of served hash slots (cluster mode). */
  slotCount?: number;
  /** Per-node details (cluster mode). */
  nodes?: Array<{
    host: string;
    port: number;
    role?: string;
  }>;
  /** Host of a standalone/sentinel client. */
  host?: string;
  /** Port of a standalone/sentinel client. */
  port?: number;
  /** Error message when `status` is `'error'`. */
  error?: string;
}

// ============ Connection Types ============
/**
 * Connection lifecycle status.
 */
export interface ConnectionStatus {
  /** `'disconnected'` | `'connecting'` | `'connected'` | `'error'` | `'closed'`. */
  state: 'disconnected' | 'connecting' | 'connected' | 'error' | 'closed';
  /** Whether the client is currently connected. */
  connected: boolean;
  /** Whether the connection is ready to serve commands. */
  ready: boolean;
  /** Last connection error (when in `'error'` state). */
  lastError?: Error;
  /** Number of reconnect attempts. */
  reconnectAttempts: number;
  /** Uptime in ms. */
  uptime: number;
}

// ============ Event Types ============
/**
 * Event payloads emitted by the Redis client.
 */
export type RedisEventMap = {
  connect: void;
  ready: void;
  close: void;
  reconnecting: { attempt: number; delay: number };
  error: Error;
  end: void;
  status: ConnectionStatus;
  nodeAdded: { node: any };
  nodeRemoved: { node: any };
  nodeError: { node: any; error: Error };
  moved: { key: string; target: any };
  ask: { key: string; target: any };
};

/**
 * Event payloads emitted by the Pub/Sub layer.
 */
export type PubSubEventMap = {
  message: { channel: string; message: string };
  pmessage: { pattern: string; channel: string; message: string };
  subscribe: { channel: string; count: number };
  unsubscribe: { channel: string; count: number };
  psubscribe: { pattern: string; count: number };
  punsubscribe: { pattern: string; count: number };
  error: Error;
};

/**
 * Event payloads emitted by the cache layer.
 */
export type CacheEventMap = {
  hit: { key: string; ttl: number };
  miss: { key: string };
  set: { key: string; ttl: number; size: number };
  delete: { key: string };
  expire: { key: string; ttl: number };
  refresh: { key: string };
  error: { key: string; error: Error };
};

/**
 * Alias for the raw ioredis client type.
 */
export type Redis = RedisType


/*


// ✅ Standalone config (valid)
const standaloneConfig = {
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
  password: 'myPassword',
  maxRetries: 5,
};

const parsedStandalone = RedisConfigSchema.parse(standaloneConfig);
console.log(parsedStandalone);
// {
//   mode: 'standalone',
//   host: 'localhost',
//   port: 6379,
//   password: 'myPassword',
//   maxRetries: 5,
//   // sentinelNodes and clusterNodes don't exist here
// }

// ✅ Sentinel config (valid)
const sentinelConfig = {
  mode: 'sentinel',
  sentinelNodes: [
    { host: 'sentinel1', port: 26379 },
    { host: 'sentinel2', port: 26380 },
    { host: 'sentinel3', port: 26381 },
  ],
  sentinelMasterName: 'mymaster',
  password: 'myPassword',
  maxRetries: 5,
};

const parsedSentinel = RedisConfigSchema.parse(sentinelConfig);

// ✅ Cluster config (valid)
const clusterConfig = {
  mode: 'cluster',
  clusterNodes: [
    { host: 'redis1', port: 7000 },
    { host: 'redis2', port: 7001 },
    { host: 'redis3', port: 7002 },
  ],
  password: 'myPassword',
  maxRetries: 5,
};

const parsedCluster = RedisConfigSchema.parse(clusterConfig);
*/
