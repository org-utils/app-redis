# app-redis

Production-grade Redis infrastructure for distributed systems: a unified client, cache, rate limiter, distributed lock, pub/sub and health checking — all working in **standalone**, **sentinel** and **cluster** modes.

## Features

- **Unified client** (`RedisClientWrapper`) — one API for standalone / sentinel / cluster; all multi-key operations (`mget`, `mset`, `scanIterator`, ...) are slot-aware and cluster-safe
- **Cache** (`Cache`) — JSON serialization, optional gzip compression, namespaces, TTLs, hash helpers and pattern-based cleanup
- **Rate limiter** (`RateLimiter`) — generic, works for any resource (routes, users, IPs, API keys, databases, ...) with fixed and sliding windows
- **Distributed lock** (`DistributedLock`) — atomic acquire/release, auto-extension, retries
- **Pub/Sub** (`PubSub`) — publish, subscribe, pattern subscriptions
- **Health checker** (`HealthChecker`) — periodic health monitoring with callbacks
- **Observability** — pino-compatible logging and slow-command warnings

## Installation

```bash
npm install app-redis ioredis zod
```

## Quick start

```ts
import { RedisClient, Cache, RateLimiter } from 'app-redis';

// 1. Create the client
const client = new RedisClient({
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
});

// 2. Cache
const cache = new Cache(client, { defaultTTL: 3600, compressionThreshold: 1024 });
await cache.set('user:1', { name: 'alice' });
const user = await cache.get('user:1');

// 3. Rate limiting
const limiter = new RateLimiter(client, { limit: 100, duration: 60 });
const result = await limiter.consume('/api/login', 'ip-10.0.0.1');
if (!result.allowed) {
  // HTTP 429, set Retry-After: result.retryAfter
}

// 4. Shut down gracefully
await client.close();
```

## Connection modes

All features behave identically in every mode. Choose the mode via the `mode` config field.

### Standalone

```ts
const client = new RedisClient({
  mode: 'standalone',
  host: 'localhost',
  port: 6379,
  password: 'secret',
  database: 0,
});
```

Or with a URL:

```ts
const client = new RedisClient({ mode: 'standalone', url: 'redis://:secret@localhost:6379/0' });
```

### Sentinel

```ts
const client = new RedisClient({
  mode: 'sentinel',
  sentinelNodes: [
    { host: 'sentinel1', port: 26379 },
    { host: 'sentinel2', port: 26380 },
  ],
  sentinelMasterName: 'mymaster',
  password: 'secret',
});
```

### Cluster

```ts
const client = new RedisClient({
  mode: 'cluster',
  clusterNodes: [
    { host: 'redis1', port: 7000 },
    { host: 'redis2', port: 7001 },
    { host: 'redis3', port: 7002 },
  ],
  password: 'secret',
});
```

### Common configuration

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `maxRetries` | number | `3` | Max reconnect attempts |
| `retryDelay` | number | `1000` | Base reconnect delay (ms) |
| `connectionTimeout` | number | `5000` | Connect timeout (ms) |
| `defaultTTL` | number | `3600` | Default cache TTL (seconds) |
| `compressionThreshold` | number | `1024` | Cache compression threshold (bytes) |
| `slowCommandThreshold` | number | `1000` | Log commands slower than this (ms) |
| `tls` | boolean | `false` | Enable TLS (`tlsOptions` for CA/cert/key) |

Configs are validated with Zod (`RedisConfigSchema`).

## RedisClient

Full reference is in the generated `.d.ts` (JSDoc with params + examples). Highlights:

### Strings & keys

```ts
await client.set('name', 'alice');              // SET
await client.set('session', 'x', 3600);         // SET ... EX
await client.setexnx('job:1', 'w', 60);         // SET ... EX NX (only if missing)
await client.setnx('lock:1', 'owner', 30);      // SETNX + EXPIRE, returns 1|0
await client.get('name');                       // 'alice' | null
await client.getdel('queue:job');               // GETDEL
await client.exists('name');                    // 1 | 0
await client.del('a', 'b');                     // number deleted
await client.expire('session', 3600);           // set TTL
await client.ttl('session');                    // seconds left
await client.incr('visits');                    // counters
await client.decr('stock:sku-1');
```

### Batch operations (cluster-safe)

```ts
await client.mset(['user:1', 'alice'], ['user:2', 'bob']); // grouped by hash slot
const [a, b] = await client.mget('user:1', 'user:2');      // routed per slot
```

### Hashes, sets, sorted sets

```ts
await client.hset('user:1', 'name', 'alice');
await client.hget('user:1', 'name');
await client.hgetall('user:1');
await client.hdel('user:1', 'age');

await client.sadd('tags:1', 'redis', 'typescript');
await client.smembers('tags:1');
await client.sismember('tags:1', 'redis');
await client.srem('tags:1', 'redis');

await client.zadd('leaderboard', 100, 'p1');
await client.zrange('leaderboard', 0, 9);
await client.zrem('leaderboard', 'p1');
```

### Scanning & pipelines

```ts
// Scans every node in cluster mode
for await (const key of client.scanIterator('session:*')) {
  console.log(key);
}
await client.deletePattern('temp:*'); // delete by glob, cluster-safe

// Pipelines (cluster mode: keys must share a hash slot)
const pipeline = client.pipeline();
pipeline.set('a', '1');
pipeline.incr('b');
const results = await pipeline.exec();
```

### Cluster helpers

```ts
client.isCluster();                  // boolean
client.getClusterNodes();            // raw node clients
client.getClusterSlots();            // raw slot map
client.getSlotRanges();              // Map<slot, host:port[]>
client.calculateSlot('{user}:a');    // CRC16 slot, honors hash tags
await client.getNodeForKey('user:1');// node serving a key
await client.isKeyServed('user:1');  // slot is served
await client.executeOnNode('user:1', 'get', 'user:1'); // run on owning node
await client.mgetClusterAware([...]); // slot-grouped multi-get
client.getClusterInfo();             // topology snapshot
```

### Lifecycle & low-level

```ts
await client.ping();            // boolean
await client.close();           // graceful QUIT
client.raw;                     // raw ioredis client
client.defineCommand(name, def);// custom commands (e.g. fastify-rate-limit)
await client.info('memory');    // INFO output
await client.select(1);         // standalone only
```

### Convenience accessors

`RedisClient` lazily creates and shares one instance of each sub-component. Access them as properties — no manual wiring needed:

```ts
client.cache;        // shared Cache (created on first access)
client.pubsub;       // shared PubSub
client.lock;         // shared DistributedLock
client.rateLimiter;  // shared RateLimiter

await client.cache.set('user:1', { name: 'alice' });
const ok = await client.lock.acquire('order:42');
const { allowed } = await client.rateLimiter.consume('/api', 'ip-1', { limit: 5, duration: 60 });
```

The corresponding setters replace the shared instance with a custom one (e.g. one built with different defaults):

```ts
client.cache = new Cache(client, config, logger);
client.rateLimiter = new RateLimiter(client, { limit: 50, duration: 10 });
```

## Cache

### Basic usage

```ts
const cache = new Cache(client, { defaultTTL: 3600, compressionThreshold: 1024 });

await cache.set('user:1', { name: 'alice' }, { ttl: 300 });
const user = await cache.get('user:1');

await cache.delete('user:1');
await cache.exists('user:1');
await cache.expire('user:1', 60);
await cache.ttl('user:1');
```

- Values are JSON-serialized; strings/numbers/buffers are stored as-is.
- Values larger than `compressionThreshold` bytes are gzip-compressed transparently.
- `compress: false` disables compression for a single write.

### Namespaces

```ts
await cache.set('token', 'abc', { namespace: 'auth' });
await cache.get('token', 'auth');          // 'abc'
await cache.get('token');                  // null

await cache.clearNamespace('sessions');    // delete every 'sessions:*' key
await cache.keys('session:*');             // list keys (cluster-safe)
await cache.deletePattern('temp:*');       // delete by pattern
```

### Atomic & batch operations

```ts
await cache.setNX('job:1', 'worker-1', { ttl: 60 });   // only if missing
await cache.setEXNX('lock:1', 'txn', { ttl: 30 });     // atomic with TTL

await cache.increment('stats:visits');                 // 1, 2, 3, ...
await cache.decrement('stock:sku-1');

await cache.mset({ 'user:1': alice, 'user:2': bob }, { ttl: 300 }); // slot-grouped
const [a, b] = await cache.mget(['user:1', 'user:2']);
```

### Hash helpers

```ts
await cache.hset('user:1', 'age', 30);
await cache.hget('user:1', 'age');       // 30
await cache.hgetall('user:1');           // { age: 30, ... }
```

## RateLimiter

Generic rate limiting for **any** resource — routes, API endpoints, users, IPs, API keys, database writes, email sends, webhooks...

```ts
const limiter = new RateLimiter(client, { limit: 100, duration: 60 });

const result = await limiter.consume('/api/login', 'ip-10.0.0.1');
```

### Result

```ts
interface RateLimitResult {
  allowed: boolean;    // request may proceed
  limit: number;       // configured max
  used: number;        // requests in current window
  remaining: number;   // left in the window
  resetAt: number;     // epoch ms when the window resets
  retryAfter: number;  // seconds to wait (0 when allowed)
}
```

### Usage in an HTTP handler

```ts
const result = await limiter.consume('/api/orders', request.ip, { limit: 5, duration: 60 });
if (!result.allowed) {
  response.setHeader('Retry-After', String(result.retryAfter));
  return response.status(429).json({ error: 'Too many requests' });
}
```

### Peek & reset

```ts
const state = await limiter.check('/api/search', 'user-1'); // no capacity consumed
await limiter.reset('/api/export', 'user-7');               // grant full capacity again
```

### Algorithms

| Algorithm | Key type | Characteristics |
| --- | --- | --- |
| `sliding` (default) | sorted set + atomic Lua | smoothest; precise rolling window |
| `fixed` | counter (`INCR`/`EXPIRE`) | cheapest; window resets at fixed boundaries |

```ts
const fixed = new RateLimiter(client, { limit: 10, duration: 1, algorithm: 'fixed' });
const perRoute = await fixed.consume('/api', 'user-1', { limit: 3, duration: 10 }); // per-call override
```

Keys are `ratelimit:{resource}:{identifier}` — each resource/identifier pair is tracked independently, so routes and callers never interfere. If Redis is unavailable the limiter **fails open** (allows requests) so an outage cannot take down the whole app.

## DistributedLock

```ts
const lock = new DistributedLock(client, { ttl: 30000, retryCount: 3, retryDelay: 200 });

await lock.acquire('order:42');        // boolean
await lock.release('order:42');        // owner-checked Lua delete
await lock.releaseForce('order:42');   // delete without ownership check
await lock.withLock('order:42', async () => {
  // exclusive section; TTL is auto-extended, lock released afterwards
});
await lock.extend('order:42', 60000);  // renew TTL while owned
await lock.isLocked('order:42');
await lock.getLockInfo('order:42');    // { locked, ttl, lockId }
await lock.getLockOwner('order:42');   // lock id | null
await lock.getLockTTL('order:42');     // seconds left
await lock.cleanupAll();               // delete every lock:* key (tests/emergency)
```

## PubSub

```ts
const pubsub = new PubSub(client);
await pubsub.connectSubscriber(redisConfig); // dedicated subscriber connection

await pubsub.subscribe('orders:created', (message) => {
  console.log(message); // message payload (JSON-parsed)
});
await pubsub.publish('orders:created', { id: 1 }); // JSON-serialized

await pubsub.unsubscribe('orders:created', handler); // one handler
await pubsub.unsubscribe('orders:created');          // whole channel
await pubsub.psubscribe('orders:*', ({ channel, message }) => {
  // pattern handlers receive { channel, message }
});
await pubsub.punsubscribe('orders:*');
await pubsub.close();       // closes subscriber only
pubsub.getStats();          // { subscriptions, patternSubscriptions, connected }
```

## HealthChecker

```ts
const health = new HealthChecker(client);
health.start(10000); // check every 10s
health.onChange((status) => console.log(status));

const status = await health.check(); // ping + latency
health.getStatus();                  // last result (null before first check)
await health.waitForHealthy(30000);  // boolean
health.stop();
```

## Errors

```ts
import { RedisError } from 'app-redis';

try {
  await client.select(1);
} catch (error) {
  if (error instanceof RedisError && error.code === 'CLUSTER_MODE') {
    // SELECT is not available in cluster mode
  }
}
```

## Logging

Every component accepts a pino-compatible logger (`trace/debug/info/warn/error/fatal` + `child`). Defaults to `console`.

```ts
import { createLogger } from 'pino';
const logger = createLogger();
const client = new RedisClient(config, logger);
```

## Mode compatibility

| Operation | Standalone | Sentinel | Cluster |
| --- | --- | --- | --- |
| Single-key commands (get/set/hash/set/zset/incr/...) | ✅ | ✅ | ✅ |
| `mget` / `mset` / `mgetClusterAware` | ✅ | ✅ | ✅ slot-grouped |
| `scanIterator` / `deletePattern` / `keys` | ✅ | ✅ | ✅ all nodes scanned |
| Pipelines | ✅ | ✅ | ✅ (same-slot keys per pipeline) |
| `select(database)` | ✅ | ✅ | ❌ (Redis limitation) |
| Hash-tag keys `{tag}:...` | ✅ | ✅ | ✅ same slot |

## Development

```bash
npm install
npm run build       # tsc
npm test            # vitest
npm run test:watch
```

The test suite covers the client, cache and rate limiter (including cluster-mode behavior) using in-memory fakes — no Redis server required.