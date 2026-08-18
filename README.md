# app-redis

Production-grade Redis infrastructure for distributed systems: a unified client, cache, rate limiter, distributed lock, pub/sub and health checking — all working in **standalone**, **sentinel** and **cluster** modes.

## Features

- **Unified client** (`RedisClientWrapper`) — one API for standalone / sentinel / cluster; all multi-key operations (`mget`, `mset`, `scanIterator`, ...) are slot-aware and cluster-safe
- **Cache** (`Cache`) — JSON serialization, optional gzip compression, namespaces, TTLs, hash helpers and pattern-based cleanup
- **Rate limiter** (`RateLimiter`) — generic, works for any resource (routes, users, IPs, API keys, databases, ...) with fixed and sliding windows
- **Distributed lock** (`DistributedLock`) — atomic acquire/release, auto-extension, retries
- **Pub/Sub** (`PubSub`) — publish, subscribe, pattern subscriptions
- **Health checker** (`HealthChecker`) — periodic health monitoring with callbacks
- **Session subsystem** (`createSessionManager`) — the production session stack: validation, retry-safe rotation, idle/absolute expiry, eviction ceilings, security versioning, optional AES-256-GCM encryption at rest, fail-closed circuit breaker, metrics and health
- **Revocation store** (`RedisRevocationStore`) — TTL-backed token revocation with batch operations and fail-closed checks
- **Lua scripts** (`eval` / `evalsha`) — atomic server-side logic, Cluster-safe when keys share a hash slot
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

### Lua scripts (atomic server-side logic)

```ts
// EVAL: the first numKeys arguments are KEYS, everything else is ARGV.
// Cluster mode: every key touched inside the script must be declared in
// KEYS and share one hash slot.
const script = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;
await client.set('lock:job', 'owner-1');
await client.eval(script, 1, 'lock:job', 'owner-1'); // 1 (deleted)

// SCRIPT LOAD + EVALSHA: avoid re-sending the script body on every call.
// evalsha falls back to EVAL automatically when the server cache was flushed.
const sha = await client.scriptLoad(script);
await client.evalsha(sha, script, 1, 'lock:job', 'owner-2'); // 0 (not owner)
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

## Revocation store

`RedisRevocationStore` supports refresh-token revocation workflows: short-lived entries (`revoked:{jti}`) so rotated/logged-out tokens are rejected for their remaining lifetime. It is framework-independent, works identically on standalone, Sentinel and Cluster, never stores raw tokens — only ids (`jti`) — and is the same store the session subsystem consults when `checkRevocationStore: true`.

```ts
import { RedisRevocationStore } from 'app-redis/session';
```

### RedisRevocationStore

Each revoked jti is stored as `{prefix}{jti} -> reason` with a Redis TTL equal to the token's remaining lifetime, so expired entries are reclaimed automatically — no sweep job required. Every operation is single-key (or a slot-grouped pipeline for batches), so no hash tags are needed on any topology.

```ts
const revocations = new RedisRevocationStore({
  client,
  keyPrefix: 'authcore:revoked:',
});

const expiry = Math.floor(Date.now() / 1000) + 86400;

// Revoke (single or batch)
await revocations.revoke({ jti: 'a1b2c3d4', reason: 'logout', expiresAt: expiry });
await revocations.revokeMany([
  { jti: 'b2', reason: 'logout-all', expiresAt: expiry },
  { jti: 'c3', reason: 'password-change', expiresAt: expiry },
]);

// Check (single or batch)
await revocations.isRevoked('a1b2c3d4');              // boolean
const revoked = await revocations.isRevokedMany(['b2', 'c3', 'd4']); // Set<string>

if (revoked.has('b2')) {
  // reject the token
}
```

Fail-closed semantics: if a batched command fails (Redis error, timeout, ...), `revokeMany` / `isRevokedMany` throw `RevocationBatchError` carrying the exact jtis that failed — a check can never silently treat a token as "not revoked" when its status is unknown.

## Session subsystem

The production session stack (`createSessionManager`): validation with
fail-closed semantics, rotation with retry-safe idempotency, throttled
touches, idle + absolute expiry, per-user eviction ceilings, security
versioning, optional AES-256-GCM encryption at rest, an optional jti index
for userId-free lookup, a fail-closed circuit breaker, metrics and health
— all Cluster-safe by construction. It supersedes the historical
`RedisSessionStore` (removed; see the migration note below).

See `SESSION.md` (spec) and `docs/architecture.md` (decisions,
deviations, exact semantics) before adopting it. Highlights:

```ts
import { createSessionManager } from 'app-redis/session';

const manager = createSessionManager({
  client,
  config: {
    enabled: true,              // explicit opt-in
    namespace: 'authcore',
    maxSessionsPerUser: 20,
    securityVersion: { enabled: true },
  },
});
await manager.init();           // preloads the Lua scripts

const { token, session } = await manager.service.create({ userId: 'user-42' });

// Validate: single round trip when userId is known. Never throws for
// invalid sessions; throws (SessionStorageError) only on infra failure.
const result = await manager.service.validate(token, { userId: 'user-42' });
if (result.valid) { /* session is live */ }

// Rotate with a retry-safe nonce (idempotent retries).
const rotated = await manager.service.rotate(token, { userId: 'user-42', rotationNonce: 'uuid' });

await manager.service.touch(token, { userId: 'user-42' });
await manager.service.revoke(token, { userId: 'user-42' });       // tombstone
await manager.service.revokeAll('user-42');                       // logout all devices
await manager.service.setSecurityVersion('user-42', 2);           // invalidates old sessions
```

- **Never stores the raw token** — only `jti = SHA-256(token)`.
- **Validation results** are discriminated: `{ valid: true, session }` or
  `{ valid: false, reason: 'invalid' | 'not_found' | 'expired' |
  'idle_timeout' | 'revoked' | 'binding_mismatch' }`.
- **Fail closed**: infra errors are `SessionStorageError` (503), never
  "invalid"; a broken revocation-store read is a 503, not a 401. The
  circuit breaker trips only on storage failures — bad tokens, consumed
  sessions and concurrent-update conflicts can never open it.
- **Idempotent creation**: `enableCreateIdempotency: true` + an
  `idempotencyKey` on `create()` makes retries return the original
  session (`replayed: true`) instead of duplicating it; the claim is
  TTL-bounded, so replay windows cannot grow forever.
- **Encryption at rest**: `encryption: { enabled: true }` +
  `encryptionKeyProvider` (AES-256-GCM, key-versioned).
- **Revocation store**: `RedisRevocationStore` plugs in via the
  `revocationStore` option for external jti denylists.
- **Manager surface**: `manager.service` (ops), `manager.metrics`,
  `manager.health`, `manager.circuitBreaker`, `manager.cookies`,
  `manager.token`, `manager.keys` — plus `manager.config`.
- **Cookie helpers**: `manager.cookies.serialize(token)` returns the
  `Set-Cookie` string; `serializeWithAttributes(token)` additionally
  returns the structured cookie object
  (`{ header, name, value, attributes: { path, domain?, httpOnly, secure,
  sameSite, maxAge? } }`, types exported from both entry points).

### Session configuration

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Explicit opt-in; the manager refuses to construct otherwise |
| `namespace` | — | Key prefix (e.g. `authcore`) |
| `ttl` | `2592000` (30d) | Absolute session lifetime in seconds |
| `idleTimeout` | `86400` (24h) | Rolling idle timeout in seconds (`null` disables) |
| `rolling` | `true` | `touch` extends the idle boundary |
| `touchInterval` | `300` | Minimum seconds between touch writes (throttling) |
| `maxSessionsPerUser` | `20` | Eviction ceiling, enforced atomically inside the create script |
| `securityVersion` | off | Global per-user version; a bump invalidates older sessions |
| `encryption` | off | AES-256-GCM envelopes (`enabled` + `encryptionKeyProvider`) |
| `jtiIndex` | off | `jti -> userId` map so validate/touch/rotate work without `userId` |
| `checkRevocationStore` | `false` | Consult the revocation store during validation |
| `bindingPolicy` | `disabled` | `strict` rejects on IP/UA/device mismatch, `advisory` reports it |
| `circuitBreaker` | off | `failureThreshold` 10, `resetTimeoutMs` 30_000, `halfOpenMaxRequests` 5 |
| `enableCreateIdempotency` | `false` | Idempotent `create()` via `idempotencyKey` |
| `retainConsumedTombstones` | `true` | Keep consumed records (TTL-bounded) for replay detection |

### Session errors

All session errors extend `SessionError` (itself a `RedisError`):
`SessionNotFoundError`, `SessionExpiredError`, `SessionInvalidError`,
`SessionRevokedError`, `SessionRotationError`, `SessionConcurrencyError`,
`SessionStorageError` (503 — the only one that trips the circuit breaker),
`SessionSerializationError`, `SessionConfigurationError`,
`SessionBindingError`. Public error messages
never contain raw tokens or identifiers.

- Tested end-to-end against standalone, Sentinel and Cluster — the
  Sentinel topology (`test/infra/`) includes a **live failover drill**
  (`sentinel-failover-probe.mjs`): sessions created before a master
  outage stay valid on the promoted replica. The real-Redis suites skip
  cleanly when Redis is unreachable.

### Migration from `RedisSessionStore` (removed)

`RedisSessionStore` and its types (`SessionStore`, `LegacySessionRecord`,
`CreateSessionInput`, `UpdateSessionInput`) are **removed**. The data and
token models are incompatible, so old sessions cannot be read through the
new API:

- The legacy store keyed sessions by a caller-supplied `jti` and stored
  raw JSON; the subsystem persists token-derived jtis (`SHA-256(token)`)
  in versioned envelopes and validates **tokens**, not jtis.
- **Existing sessions must be re-established** (users re-authenticate).
  For a smooth cutover, validate old tokens through a time-boxed
  app-side shim (legacy jti lookup in your own data → mint a new session
  via `create()`) and remove the shim once the old tokens age out.
- Do not run both against the same Redis namespace — records and indexes
  share the same key layout but use different formats.

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
| Lua scripts (`eval` / `evalsha` / `scriptLoad`) | ✅ | ✅ | ✅ (keys declared in `KEYS`, one slot) |
| `RedisRevocationStore` | ✅ | ✅ | ✅ batch ops slot-grouped |
| `createSessionManager` | ✅ | ✅ | ✅ hash-tagged Lua scripts, slot-grouped fan-out |
| `select(database)` | ✅ | ✅ | ❌ (Redis limitation) |
| Hash-tag keys `{tag}:...` | ✅ | ✅ | ✅ same slot |

## Development

```bash
npm install
npm run build       # tsc + asset copy (Lua scripts land in dist/session/scripts)
npm run typecheck   # src + test + scripts (tsconfig.test.json)
npm test            # vitest
npm run test:watch
```

The test suite covers the client, cache and rate limiter (including cluster-mode behavior) using in-memory fakes — no Redis server required. The session suites are gated: they run against real Redis (`localhost:6379`, or `REDIS_MODE=cluster` / `REDIS_MODE=sentinel` with the compose topologies in `test/infra/`) and skip cleanly when it is unreachable.