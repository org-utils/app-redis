// Core exports
export { RedisClientWrapper as RedisClient } from './client.js';
export { Cache } from './cache.js';
export { PubSub } from './pubsub.js';
export { DistributedLock } from './lock.js';
export { HealthChecker } from './health.js';

// Re-export logger types for convenience

import { createLogger } from 'api-loggers';

export type { Logger, LoggerOptions } from 'api-loggers';


// Error exports
export { RedisError } from './errors.js';

// Types
export type {
  RedisConfig,
  CacheOptions,
  LockOptions,
  LockInfo,
  DistributedLockOptions,
  HealthStatus,
  PubSubStats,
  PubSubMessage,
  ClusterInfo,
  ConnectionStatus,
  Redis
} from './types.js';

// Zod schema
export { RedisConfigSchema } from './types.js';

// Re-export for convenience
export type { RedisConfig as RedisConfiguration } from './types.js';

// Default export
import { RedisClientWrapper as RedisClient } from './client.js';
import { Cache } from './cache.js';
import { PubSub } from './pubsub.js';
import { DistributedLock } from './lock.js';
import { HealthChecker } from './health.js';

export default {
  RedisClient,
  Cache,
  PubSub,
  DistributedLock,
  HealthChecker,
  createLogger,
};
export { createLogger };
