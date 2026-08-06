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

const ClusterConfig = BaseRedisConfig.extend({
  mode: z.literal('cluster'),
  host: z.string().optional(),
  port: z.number().min(1).max(65535).optional(),
  clusterNodes: z.array(z.object({
    host: z.string(),
    port: z.number().min(1).max(65535),
  })),
});

// Union of all configs
export const RedisConfigSchema = z.discriminatedUnion('mode', [
  StandaloneConfig,
  SentinelConfig,
  ClusterConfig,
]);
export type RedisConfig = RedisOptions & z.infer<typeof RedisConfigSchema> ;

// ============ Cache Types ============
export interface CacheOptions {
  ttl?: number;
  compress?: boolean;
  namespace?: string;
}

export interface CacheStats {
  namespace: string;
  connectionStatus: any;
}

// ============ Lock Types ============
export interface LockOptions {
  ttl?: number;
  retryCount?: number;
  retryDelay?: number;
}

export interface LockInfo {
  locked: boolean;
  ttl?: number;
  lockId?: string;
}

export interface DistributedLockOptions {
  ttl?: number;
  retryCount?: number;
  retryDelay?: number;
}

// ============ Health Types ============
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

// ============ Pub/Sub Types ============
export interface PubSubStats {
  subscriptions: number;
  patternSubscriptions: number;
  connected: boolean;
}

export interface PubSubMessage<T = any> {
  channel: string;
  message: T;
}

// ============ Cluster Types ============
export interface ClusterInfo {
  mode: 'cluster' | 'standalone';
  status: 'ready' | 'connecting' | 'error';
  nodeCount?: number;
  slotCount?: number;
  nodes?: Array<{
    host: string;
    port: number;
    role?: string;
  }>;
  host?: string;
  port?: number;
  error?: string;
}

// ============ Connection Types ============
export interface ConnectionStatus {
  state: 'disconnected' | 'connecting' | 'connected' | 'error' | 'closed';
  connected: boolean;
  ready: boolean;
  lastError?: Error;
  reconnectAttempts: number;
  uptime: number;
}

// ============ Event Types ============
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

export type PubSubEventMap = {
  message: { channel: string; message: string };
  pmessage: { pattern: string; channel: string; message: string };
  subscribe: { channel: string; count: number };
  unsubscribe: { channel: string; count: number };
  psubscribe: { pattern: string; count: number };
  punsubscribe: { pattern: string; count: number };
  error: Error;
};

export type CacheEventMap = {
  hit: { key: string; ttl: number };
  miss: { key: string };
  set: { key: string; ttl: number; size: number };
  delete: { key: string };
  expire: { key: string; ttl: number };
  refresh: { key: string };
  error: { key: string; error: Error };
};
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
