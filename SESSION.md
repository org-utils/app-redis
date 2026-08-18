You are a principal distributed-systems engineer, security architect, Redis/ioredis expert, and TypeScript library architect.

Your task is to design and implement a PRODUCTION-GRADE Redis-backed session and token-revocation subsystem for an existing authentication/core package.

This is NOT an MVP, demo, toy implementation, framework helper, or simplified example.

The implementation must be suitable for a production authentication platform handling millions of sessions across horizontally scaled application instances.

IMPORTANT:
Do not blindly follow this specification if any requirement is technically unsafe, internally inconsistent, inefficient, or incorrect.

Review the architecture critically before implementation. If a proposed design creates race conditions, security gaps, Redis Cluster incompatibilities, memory problems, hot slots, partial-failure problems, or unnecessary complexity, change the design and explain the reason in the implementation documentation.

Do not optimize for agreeing with this prompt.
Optimize for correctness, security, distributed-systems semantics, operational safety, and maintainability.

======================================================================
1. TARGET ENVIRONMENT
======================================================================

Support:

- Node.js 22+
- TypeScript strict mode
- ESM
- ioredis
- Redis Standalone
- Redis Sentinel
- Redis Cluster
- Horizontal application scaling
- Multiple application instances
- Millions of sessions
- Redis failover/reconnect
- Cluster resharding
- Cluster MOVED/ASK handling through ioredis
- Framework-independent usage

The existing package already provides Redis infrastructure.

Assume existing abstractions similar to:

RedisClientWrapper
Cache
RedisConfig
RedisLikeClient

DO NOT create a second Redis client inside the session subsystem.

Build the session subsystem on top of the existing Redis infrastructure.

Before implementing sessions, audit the existing Redis infrastructure and fix any infrastructure defect that prevents the session subsystem from being correct.

======================================================================
2. PRIMARY ARCHITECTURE
======================================================================

Use a layered architecture:

SessionManager
    ↓
SessionService
    ↓
SessionRepository
    ↓
SessionKeyStrategy
SessionTokenManager
SessionSerializer
SessionScriptRegistry
SessionRevocationStore
    ↓
RedisClientWrapper
    ↓
ioredis
    ↓
Standalone / Sentinel / Cluster

The session layer MUST NOT contain topology-specific code such as:

if (redis.isCluster()) { ... }

Topology-specific behavior belongs in the Redis infrastructure layer.

The public session API must behave consistently regardless of Redis topology.

The session subsystem must not expose ioredis internals through its public API.

======================================================================
3. CRITICAL ARCHITECTURAL REVIEW
======================================================================

Before writing code, critically evaluate the proposed data model.

The system may use:

1. Per-session records.
2. Per-user session indexes.
3. Optional JTI lookup indexes.
4. Optional revocation records.

However, do NOT introduce a global JTI → userId index merely because it makes APIs convenient.

A global JTI lookup index creates:

- an additional write
- an additional read
- a second consistency boundary
- partial-failure scenarios
- additional memory
- another key family
- additional cleanup
- potentially uneven cluster behavior

Prefer APIs that accept userId when the authentication layer already knows it.

If lookup by JTI without userId is required, implement it deliberately and document its consistency semantics.

If a global JTI index is retained:

- it must have its own TTL
- it must never be considered authoritative over the actual session record
- stale entries must self-heal
- missing index entries must not be treated as proof that a session does not exist if another authoritative lookup path exists
- raw JTI/token values must not be exposed through logs/errors
- partial failure between session creation and JTI index creation must be explicitly handled

Do not claim that a partial write can only produce a "false negative for a few milliseconds" unless the implementation actually guarantees that. Redis failures, retries, reconnects, and process crashes can produce longer-lived inconsistency.

Prefer correctness over optimistic assumptions.

======================================================================
4. REDIS INFRASTRUCTURE REQUIREMENTS
======================================================================

Audit and, where necessary, fix the Redis infrastructure.

Required:

- Real Redis CRC16 hash-slot implementation.
- Correct Redis hash-tag parsing.
- No character-sum hashing.
- No naive modulo hashing.
- Avoid unnecessary ioredis private APIs.
- Cluster-aware multi-key operations.
- Cluster-aware MGET.
- Cluster-aware pipelines.
- Cluster-aware SCAN.
- Cluster-aware pattern deletion.
- Cluster-aware namespace clearing.
- Atomic SET NX EX.
- INCRBY.
- DECRBY.
- Correct increment/decrement amount handling.
- Controlled concurrency for cross-slot fan-out.
- Correct handling of pipeline command-level errors.
- Clear retry semantics.
- No unsafe automatic retries for non-idempotent operations.

Where ioredis already correctly handles MOVED/ASK internally, do not duplicate that logic unnecessarily.

The infrastructure should expose reusable primitives such as:

executeBySlot(...)
pipelineBySlot(...)
mgetClusterAware(...)
scanCluster(...)
deletePatternClusterAware(...)
clearNamespaceClusterAware(...)

The session subsystem must consume these abstractions instead of reimplementing Redis Cluster behavior.

======================================================================
5. SESSION DOMAIN MODEL
======================================================================

Create strongly typed session models.

A recommended internal model is:

SessionRecord:

- id or jti
- userId
- createdAt
- lastAccessedAt
- expiresAt
- idleExpiresAt
- absoluteExpiresAt
- status
- version
- securityVersion
- deviceId
- ipAddress
- userAgent
- metadata
- rotatedFrom
- consumedAt

Do not store the entire user object.

Store only the minimum required authentication/session context.

Identity fields must not be freely mutable.

Do not allow arbitrary patching of:

- session id/JTI
- userId
- createdAt
- absolute expiration
- security-critical state

Use explicit operations for security-sensitive changes.

======================================================================
6. SESSION TOKEN SECURITY
======================================================================

Session identifiers must be generated using Node.js crypto.

Use:

crypto.randomBytes()

Prefer at least 256 bits of entropy.

Encode using base64url.

Never use:

- timestamps
- incremental IDs
- usernames
- user IDs
- predictable UUID construction
- hashes of predictable information

The raw session token must never be:

- stored in Redis
- logged
- placed in metrics
- placed in tracing attributes
- included in errors
- included in Redis keys

Create:

SessionTokenManager

with:

generate()
hash(token)
validateFormat(token)

Hash session tokens using SHA-256 before persistence or lookup.

Use constant-time comparison where a comparison of secret-derived values is required.

Distinguish clearly between:

- session token
- JTI
- token hash
- Redis key

Do not expose one as another.

======================================================================
7. SESSION KEY DESIGN
======================================================================

Design keys for Redis Cluster.

Preferred per-user model:

{namespace}:session:{userId}:session:{jti}
{namespace}:user-sessions:{userId}

The {userId} component is the Redis Cluster hash tag.

All keys for one user's session operations therefore share a slot.

Do NOT create:

{namespace}:sessions

as a global session index.

Do not place all sessions in one slot.

Do not use a global hash tag that makes the entire application a hot slot.

Use user-level hash tags.

Be careful with userId values containing Redis hash-tag syntax.

SessionKeyStrategy must produce safe, deterministic keys.

Do not blindly embed arbitrary unvalidated values into key formats.

If a global JTI index is required:

{namespace}:jti-index:{jti}

must NOT use the user hash tag.

Document that the JTI index is deliberately cross-slot from the session record.

======================================================================
8. SESSION STORAGE MODEL
======================================================================

Use a Redis String for the individual session record unless there is a strong measured reason to use a Hash.

Store serialized session data.

Example:

SET sessionKey serializedSession EX ttl

Do not perform:

EXISTS
TTL
GET

when one GET is sufficient.

Redis TTL is only storage cleanup.

It is NOT the authoritative application-level session validity mechanism.

Session validity must account for:

- Redis existence
- status
- idle timeout
- absolute timeout
- optional security version
- serialization validity

======================================================================
9. SESSION SERIALIZATION
======================================================================

Create:

SessionSerializer

Requirements:

- explicit schema version
- runtime validation
- malformed-data detection
- compatibility handling
- safe failure
- schema evolution support

Example:

{
  "v": 1,
  ...
}

Do not blindly cast JSON.parse() to SessionRecord.

JSON.parse() output must be validated at runtime.

A corrupt session must not crash the application.

Treat malformed session data as invalid/corrupt storage and clean it safely.

Do not automatically add compression.

Compression should only be introduced if profiling demonstrates that session payload size warrants it.

If encryption is enabled, compression/encryption ordering must be explicitly designed.

======================================================================
10. OPTIONAL SESSION ENCRYPTION
======================================================================

Session encryption is OPTIONAL, not automatically required.

Evaluate whether encryption at rest is actually necessary because Redis may already provide:

- TLS
- authentication
- ACLs
- private networking
- disk encryption
- infrastructure access controls

If application-level encryption is required, implement it correctly.

Use authenticated encryption such as:

AES-256-GCM

or another well-reviewed AEAD construction supported by Node.js.

Encrypted session structure:

EncryptedSession:

- iv
- authTag
- ciphertext
- keyVersion

Use a cryptographically secure random IV for every encryption.

Never reuse an IV with the same encryption key.

Support key rotation using keyVersion.

The serializer must distinguish:

plain serialized sessions
from
encrypted serialized sessions.

Do not log encryption keys, ciphertext, tokens, or plaintext session contents.

Provide key management through dependency injection.

Do NOT hardcode encryption keys.

Do NOT invent an internal key-management system if the application already has a KMS/secrets provider.

Support decrypting older key versions and optionally re-encrypting on write/touch.

Do not claim application-level encryption provides protection against a fully compromised Redis client/application.

Document the actual threat model.

======================================================================
11. SESSION CREATION
======================================================================

Implement:

create(input): Promise<CreatedSession>

Flow:

- validate input
- generate secure token/JTI
- construct session
- serialize
- store session
- set TTL
- add JTI to user index
- optionally create JTI lookup index
- enforce max sessions
- return raw token exactly once

Creation must be idempotent only if the API explicitly provides an idempotency key.

Do not silently overwrite an existing session if a JTI collision occurs.

Cryptographic collisions should be practically impossible, but implementation should still behave safely.

If using a caller-supplied JTI, validate it.

Prefer atomic creation for session + user index because both share the same {userId} hash tag.

Do not include a cross-slot JTI index in the same Lua script.

======================================================================
12. SESSION TTL AND EXPIRATION
======================================================================

Clearly distinguish:

Redis TTL
Idle timeout
Absolute timeout

Example:

Redis TTL = storage cleanup boundary.

idleExpiresAt = inactivity boundary.

absoluteExpiresAt = maximum lifetime.

Validation:

session must satisfy ALL relevant conditions.

Rolling/touch operations may extend idle expiration.

Rolling/touch MUST NEVER extend absolute expiration.

Never allow:

lastAccessedAt > now

because of a stale clock or stale request.

Timestamps should be generated consistently.

If stronger ordering is required, use Redis server time or an atomic Redis script rather than trusting arbitrary application clocks.

Document clock-skew assumptions.

======================================================================
13. SESSION VALIDATION
======================================================================

Implement:

validate(token): Promise<SessionValidationResult>

Normal invalid sessions must return a typed result, not throw.

Example:

valid:
{
  valid: true,
  session
}

invalid:
{
  valid: false,
  reason:
    | "not_found"
    | "expired"
    | "idle_timeout"
    | "absolute_timeout"
    | "revoked"
    | "invalid"
}

Infrastructure failures must NOT be converted into "invalid".

Redis outage must produce a typed storage/infrastructure error.

This distinction is critical:

unauthenticated
!=
authentication infrastructure unavailable

The authentication layer can then apply fail-closed behavior correctly.

Never expose detailed internal reasons to an untrusted browser if doing so creates an account/session enumeration risk.

Provide safe public error mapping.

======================================================================
14. SESSION GET
======================================================================

Implement:

get(token)

Prefer one Redis read.

Flow:

token
→ hash
→ resolve session
→ deserialize
→ validate
→ return

Do not automatically touch the session during get unless the API explicitly requests rolling behavior.

Separate:

read
validate
touch

so callers can reason about Redis cost.

======================================================================
15. SESSION TOUCH
======================================================================

Implement:

touch(token)

Touch must be throttled using:

touchInterval

Do not write to Redis on every request.

Use an atomic Lua script where required.

The script should:

- verify session still exists
- deserialize/inspect required fields
- verify not expired
- compare lastAccessedAt
- only update when touch is actually necessary
- update idle expiration
- preserve absolute expiration
- increment version only if appropriate
- return explicit result codes

Touch must be monotonic.

A stale request must never overwrite newer activity.

Prefer Redis server time or an atomic time strategy where distributed application clocks could cause ordering problems.

======================================================================
16. ROLLING SESSIONS
======================================================================

If rolling = true:

valid activity may extend idle expiration.

Never extend absolute expiration.

Example:

createdAt = T0
absoluteExpiresAt = T0 + 30 days

Requests may extend idleExpiresAt, but never beyond absoluteExpiresAt.

The effective expiry is:

min(idleExpiresAt, absoluteExpiresAt)

where applicable.

======================================================================
17. SESSION UPDATE
======================================================================

Implement:

update(token, patch)

Only permit explicitly supported mutable properties.

Use optimistic concurrency/versioning if concurrent updates are possible.

Do not use:

GET
modify in application
SET

for security-sensitive updates where concurrent writes can lose changes.

Use:

- WATCH/MULTI where same-slot semantics are sufficient
- Lua
- version checks
- atomic commands

Do not accidentally allow stale application state to overwrite newer session state.

======================================================================
18. SESSION ROTATION
======================================================================

Rotation is a security-critical operation.

Implement:

rotate(token)

or:

rotate(jti, userId)

Flow:

old token
→ validate current session
→ generate successor
→ create successor
→ invalidate/consume old session
→ return successor

Rotation must prevent session fixation.

Use a session-local atomic Lua script where possible.

For one user, old and new session keys can share the {userId} slot.

Do NOT merely rename or mutate the old JTI.

Create a genuinely new token/JTI.

Prevent concurrent rotation races.

Two simultaneous rotations must not both succeed against the same one-time-use session if rotation is intended to be single-use.

Use an explicit consumedAt/rotated state.

Possible script return codes:

1 = success
0 = not found
-1 = already consumed
-2 = expired
-3 = version conflict
-4 = successor collision

Use stable machine-readable result codes.

Do not perform a preliminary GET and assume that guarantees safety.

A preliminary GET is informational only.

The final Lua script must perform the authoritative compare-and-update atomically.

The successor and old session must be handled atomically within the same user slot.

======================================================================
19. ROTATION SEMANTICS
======================================================================

Clearly define whether the old session:

- is deleted immediately
OR
- remains as a consumed tombstone for a short period

For replay detection, keeping a short-lived consumed record can be valuable.

If a consumed record is retained:

- it must have a bounded TTL
- it must contain no unnecessary sensitive data
- it must not allow authentication
- replay must return a safe "consumed/revoked" result
- it must not grow indefinitely

Do not retain old session records forever.

======================================================================
20. LOGOUT / DESTROY / REVOKE
======================================================================

Provide:

destroy(token)
revoke(token)

Clearly distinguish:

destroy:
physical deletion.

revoke:
logical revocation, optionally with a short-lived tombstone.

Normal logout should be idempotent.

Repeated logout must not fail.

Do not require an exception for "already deleted" unless explicitly requested.

For security/audit requirements, support short-lived revocation tombstones.

======================================================================
21. USER SESSION INDEX
======================================================================

Use a Redis Sorted Set if the API needs:

- deterministic ordering
- oldest-session eviction
- session timestamps
- max-session enforcement

Example:

{namespace}:user-sessions:{userId}

ZADD score = createdAt member = jti

If only membership is needed, a Set is cheaper.

Choose the data structure based on actual requirements.

If maxSessionsPerUser is required, prefer a Sorted Set.

Do not blindly use SMEMBERS + sort in application code for large users.

Avoid unbounded user indexes.

Ensure stale entries can be removed.

======================================================================
22. MAXIMUM SESSIONS PER USER
======================================================================

Support:

maxSessionsPerUser

Do not enforce it using:

listByUser()
sort()
delete()

under high concurrency without a race analysis.

Concurrent logins can both observe capacity and both create sessions.

Design the invariant carefully.

If strict enforcement is required, use a same-slot Lua script that:

- inserts the new session/index entry
- identifies oldest entries
- removes excess sessions
- returns evicted JTIs

Because all sessions for the user share the same {userId} slot, this can be atomic.

However, avoid loading an unbounded number of members into Lua.

For large values, use bounded eviction logic.

If strict global session limits cannot be guaranteed under the chosen data model, document the exact semantics.

Do not claim strictness if the implementation is eventually consistent.

======================================================================
23. LIST USER SESSIONS
======================================================================

Implement:

listByUser(userId)

Because session records and user index share the same {userId} hash tag, reads for one user are cluster-local.

However, do not create huge pipelines without limits.

For large session counts:

- paginate
- use ZRANGE with ranges
- batch GETs
- use bounded concurrency

If the session count is guaranteed small by maxSessionsPerUser, a bounded pipeline may be sufficient.

When stale entries are detected:

- remove them from the user index
- optionally remove the global JTI index
- do not fail the entire list operation because one session is corrupt

Do not assume Redis Cluster pipeline behavior without verifying the client abstraction.

======================================================================
24. REVOKE ALL / DELETE ALL
======================================================================

Implement:

revokeAll(userId)
deleteByUser(userId)

All session keys for a user are in the same Redis Cluster slot.

This makes a user-level Lua script possible.

Do NOT create a single global transaction spanning arbitrary users.

For one user:

- read/iterate user index
- delete or revoke sessions
- remove index
- return affected JTIs

Be aware of Lua script memory/time limits.

Do not use an unbounded SMEMBERS + loop if a user could have an extremely large number of sessions.

Prefer bounded/paginated administrative operations or enforce a sane maximum.

If a global JTI index exists, cleaning it is cross-slot and therefore not atomic with the user-local operation.

Handle it as a best-effort/idempotent cleanup process.

Never claim global atomicity where none exists.

======================================================================
25. GLOBAL JTI INDEX
======================================================================

Only implement this if the API genuinely requires:

find(jti)
update(jti)
rotate(jti)
delete(jti)

without userId.

If used:

{namespace}:jti-index:{jti} → userId

Use TTL matching or shorter than the session TTL.

The actual session record remains authoritative.

On index lookup:

JTI index
→ userId
→ session key
→ session record

If the session does not exist:

- remove stale index
- return not_found

If the JTI index is missing:

do NOT blindly conclude that the session does not exist if another authoritative lookup mechanism is available.

Document that JTI-only lookup is dependent on index consistency.

Prefer APIs requiring userId whenever the caller already has it.

======================================================================
26. SESSION CLEANUP
======================================================================

Natural Redis expiration removes session records.

User index members may remain.

Do not require a background worker for correctness.

Cleanup may happen:

- lazily during list
- lazily during lookup
- via bounded maintenance jobs
- via administrative cleanup

Never perform unbounded cleanup in a user request.

Do not use KEYS in production.

Use SCAN only through the cluster-aware infrastructure.

======================================================================
27. SECURITY VERSION
======================================================================

Support optional user/session security versioning.

Use cases:

- password change
- MFA reset
- account compromise
- logout all
- security policy change

A session may contain:

securityVersion

The current security version must be stored in Redis or another authoritative low-latency store.

Do not perform a PostgreSQL query on every request.

If security version checking is enabled:

session.securityVersion
must match
current user securityVersion

If mismatch:

session is invalid.

Design this carefully for Redis Cluster.

A user-level security version key can use:

{namespace}:security-version:{userId}

This remains in the user's slot.

======================================================================
28. SESSION BINDING
======================================================================

Support optional:

storeIpAddress
storeUserAgent
storeDeviceId

Do not enable strict IP binding by default.

IP addresses can change.

User-Agent can be spoofed.

Device IDs may be missing or unstable.

If binding validation is implemented, make the policy explicit:

- disabled
- advisory
- strict

Do not silently treat metadata mismatch as authentication failure unless configured.

======================================================================
29. COOKIE SUPPORT
======================================================================

Keep the session manager framework-independent.

Optionally implement:

SessionCookieManager

Support:

- HttpOnly
- Secure
- SameSite
- Domain
- Path
- Max-Age
- Expires

Never log cookie values.

Cookie defaults must be secure.

For production authentication:

HttpOnly = true
Secure = true in HTTPS deployments

SameSite must be configurable.

SameSite=None requires Secure.

Do not couple this implementation to:

- Express
- Fastify
- Hono
- Next.js

It must work with all of them through adapters or simple cookie utilities.

Do not use Next.js API routes as a requirement.

======================================================================
30. FAILURE SEMANTICS
======================================================================

Authentication must fail closed.

If Redis is unavailable:

do NOT assume the session is valid.

But also do NOT convert infrastructure failure into:

invalid session

Return a typed storage/infrastructure error.

Distinguish:

SessionNotFound
SessionExpired
SessionRevoked
SessionInvalid
SessionStorageUnavailable
SessionSerializationError
SessionConfigurationError

Applications can then decide whether to:

- return 401
- return 503
- retry
- trigger failover behavior

Do not silently authenticate users when Redis cannot confirm authentication state.

======================================================================
31. CIRCUIT BREAKER
======================================================================

A circuit breaker may be provided, but do not automatically place one inside the low-level Redis client if ioredis already manages reconnect/failover.

A session-level circuit breaker must NOT cause authentication validation to become fail-open.

If implemented:

CircuitBreakerConfig:

enabled
failureThreshold
resetTimeout
halfOpenMaxRequests

Use the breaker primarily to protect the application from cascading failures.

For authentication reads:

OPEN circuit
→ fail closed
→ return infrastructure unavailable

Never:

OPEN circuit
→ assume session valid

Define:

closed
open
half-open

with concurrency-safe transitions.

Metrics must distinguish:

Redis failure
Circuit open
Session invalid

Do not hide infrastructure failures behind the circuit breaker.

======================================================================
32. OBSERVABILITY
======================================================================

Implement dependency-injected metrics.

Recommended metrics:

session_create_duration
session_validate_duration
session_touch_duration
session_rotate_duration
session_revoke_all_duration

Counters:

session_created_total
session_validation_failed_total
session_touched_total
session_touch_skipped_total
session_rotated_total
session_revoked_total
session_destroyed_total
session_expired_total
session_storage_error_total
session_redis_error_total
session_rotation_replay_total

Gauge:

active_sessions

Be careful with activeSessions.

A global exact count across millions of sessions in a distributed Redis Cluster is expensive and can be misleading.

Do NOT calculate activeSessions using SCAN on every metric collection.

Prefer:

- approximate metrics
- increment/decrement accounting
- periodic reconciliation
- per-node/application metrics
- Redis INFO-based metrics

Clearly document whether a gauge is:

exact
approximate
eventually consistent

Histograms should use bounded cardinality.

Never put:

- raw token
- JTI
- userId
- session ID
- IP address

into metric labels.

Include topology as a low-cardinality label:

standalone
sentinel
cluster

Do not add high-cardinality labels.

======================================================================
33. HEALTH CHECK
======================================================================

Provide a health model such as:

SessionHealthCheck:

status:
healthy
degraded
unhealthy

latency
errorRate
redisStatus
activeSessionCount

But do NOT calculate health from expensive session scans.

Health should be based on cheap Redis connectivity/operation checks.

Differentiate:

liveness
readiness
dependency health

Example:

liveness:
process is alive.

readiness:
Redis dependency is usable for authentication operations.

degraded:
Redis reachable but latency/error thresholds exceeded.

unhealthy:
Redis unavailable.

Do not expose sensitive infrastructure details to public endpoints.

Provide a framework-neutral health provider that applications can expose through their own HTTP health endpoint.

======================================================================
34. SESSION METRICS INTERFACES
======================================================================

Do not hard-code Prometheus/OpenTelemetry/etc.

Use dependency injection.

Define abstractions such as:

Histogram
Counter
Gauge

or an internal metrics interface.

Provide adapters separately if needed.

The session package must remain usable without a metrics library.

======================================================================
35. REVOCATION STORE
======================================================================

Implement a separate:

RedisRevocationStore

Purpose:

store revoked JTI/token identifiers until their natural expiration.

Key:

{namespace}:revoked:{jti}

Value:

reason or compact metadata.

TTL:

remaining token lifetime.

Never store revoked entries forever.

Validate expiresAt before writing.

Use:

SET key value EX ttl

Each revocation is single-key and therefore Cluster-safe.

No hash tag is required.

======================================================================
36. REVOCATION SECURITY
======================================================================

A failed revocation write is a security-significant failure.

If:

revoke(jti)

cannot be persisted:

throw a typed infrastructure error.

Do NOT silently return success.

For revokeMany:

pipeline errors must be inspected individually.

Do not assume:

pipeline.exec() resolving
means
every command succeeded.

Check every command result.

Return/throw a structured batch error containing safe identifiers.

IMPORTANT:
Do not include raw tokens or sensitive data in error messages.

JTI may itself be sensitive depending on how it is generated. Prefer opaque internal identifiers and safe redaction in public errors.

======================================================================
37. REVOCATION CHECK
======================================================================

isRevoked(jti):

Use EXISTS or GET.

For batch checks:

isRevokedMany(jtis)

Use a pipeline where all keys are independent.

Check command-level errors.

For authentication:

if revocation status cannot be determined due to Redis failure:

FAIL CLOSED.

Do not interpret infrastructure failure as "not revoked".

======================================================================
38. SESSION REVOCATION VS SESSION DELETION
======================================================================

Clearly document:

Deletion:
Redis record is physically removed.

Revocation:
authentication is denied even if some record/tombstone remains.

For normal logout, deletion may be enough if the session record is the source of truth.

For security-sensitive replay protection, a revocation/consumed tombstone may be preferable.

Do not implement redundant revocation storage without a real security requirement.

======================================================================
39. CONCURRENCY REQUIREMENTS
======================================================================

Explicitly test:

- two simultaneous touches
- two simultaneous rotations
- logout during validation
- revokeAll during creation
- concurrent logins
- concurrent max-session enforcement
- concurrent update
- concurrent revoke
- concurrent destroy
- JTI index creation race
- JTI index cleanup race

Use:

- Lua
- atomic Redis commands
- optimistic versioning
- same-slot operations

where appropriate.

Do not use distributed locks unless the invariant genuinely requires one.

Prefer atomic state transitions over locks.

If a lock is used:

- unique lock token
- TTL
- safe release
- no unsafe DEL of another process's lock
- bounded wait
- failure semantics
- no deadlocks

A lock should not be used to compensate for poor data modeling.

======================================================================
40. LUA SCRIPT DESIGN
======================================================================

Create:

SessionScriptRegistry

and scripts such as:

touch.lua
rotate.lua
create.lua
delete.lua
enforce-limit.lua
delete-by-user.lua
cleanup-index.lua
conditional-update.lua

Every script must:

- declare KEYS explicitly
- use same-slot keys only
- never construct dynamic executable Lua
- return stable result codes
- validate expected state
- be versioned/tested

Do not put cross-slot operations inside Lua.

Do not use unbounded loops over attacker-controlled data.

Avoid long-running Lua scripts.

Do not assume Lua scripts can safely delete millions of sessions in one invocation.

======================================================================
41. DISTRIBUTED PARTIAL FAILURE
======================================================================

Explicitly design for:

process crash
Redis connection loss
Redis primary failure
Sentinel promotion
Cluster primary failure
MOVED
ASK
slot migration
partial pipeline failure
timeout after server-side success
retry after ambiguous result
network partition

For every operation determine:

- idempotent?
- safe to retry?
- possibly applied but response lost?
- can duplicate state occur?
- can stale state remain?
- how is it reconciled?

Do NOT automatically retry non-idempotent operations.

For operations where Redis may have applied a write but the client timed out, retry semantics must be explicitly designed.

======================================================================
42. CLUSTER FAILOVER AND RESHARDING
======================================================================

Test:

- primary failure
- replica promotion
- reconnect
- MOVED
- ASK
- slot migration
- resharding
- node reconnect
- temporary partial availability

Do not write custom MOVED/ASK handling if ioredis already provides correct behavior.

Do not cache slot ownership indefinitely in the session layer.

======================================================================
43. CLUSTER PIPELINES
======================================================================

Implement infrastructure-level:

executeBySlot
or equivalent.

Requirements:

- calculate correct slot
- group commands
- execute per-slot pipelines
- bounded concurrency
- preserve result ordering
- handle command-level errors
- safe retries
- no cross-slot MULTI/EXEC

Do not put this logic inside SessionService.

======================================================================
44. CLUSTER SCAN
======================================================================

Implement cluster-wide SCAN only in infrastructure.

SCAN must visit relevant primary nodes.

Never use:

KEYS *

in production.

Provide:

scanCluster(options)

or equivalent.

Use for:

- administrative cleanup
- diagnostics
- maintenance

Never require cluster-wide SCAN for normal authentication validation.

======================================================================
45. MEMORY AND SCALE
======================================================================

Design for millions of sessions.

Avoid:

- global session indexes
- unbounded Redis Sets
- unbounded metadata
- huge Lua arrays
- huge pipelines
- Promise.all over arbitrary session counts
- full-cluster scans during requests
- exact global counters that require scanning
- storing full user objects

Session metadata should have size limits.

Define maximum metadata size.

Reject oversized session payloads.

Prefer compact serialization where practical.

======================================================================
46. USER-INDEX HOTSPOT ANALYSIS
======================================================================

All sessions for a user are intentionally placed in one Redis Cluster slot.

This is correct for per-user atomicity.

But a single extremely active user can become a hot slot.

Document the trade-off.

Do not attempt to distribute one user's sessions across multiple slots if strict per-user atomic operations are required.

If a future sharded-user-index mode is needed, treat it as a separate design.

======================================================================
47. CONFIGURATION
======================================================================

Use Zod as the source of truth.

Create:

SessionConfigSchema

Example:

enabled
namespace
tokenLength
ttl
idleTimeout
absoluteTimeout
touchInterval
rolling
maxSessionsPerUser
storeIpAddress
storeUserAgent
storeDeviceId
secureCookie
httpOnlyCookie
sameSite
cookieName
cookiePath
encryption
circuitBreaker
metrics
health

Validate all relationships.

Examples:

tokenLength >= secure minimum
ttl > 0
touchInterval >= 0
idleTimeout <= absoluteTimeout where both are configured
absoluteTimeout >= ttl where applicable
sameSite = none requires secureCookie = true
maxSessionsPerUser >= 0

Do not enable sessions implicitly unless that is explicitly intended.

Prefer:

session:
  enabled: false

as the default.

Support nested defaults.

======================================================================
48. CONFIGURATION SECURITY
======================================================================

Do not place secrets in normal session configuration.

Encryption keys must come from secure secret/key-management injection.

Do not log configuration objects containing secrets.

Do not expose Redis credentials through health endpoints.

======================================================================
49. PUBLIC API
======================================================================

Keep the public API small and stable.

Example:

const sessions = createSessionManager({
  client: redis,
  config: config.session,
});

const created = await sessions.create({
  userId,
  ...
});

const result = await sessions.validate(token);

const session = await sessions.get(token);

await sessions.touch(token);

const rotated = await sessions.rotate(token);

await sessions.update(token, patch);

await sessions.destroy(token);

await sessions.revoke(token);

await sessions.revokeAll(userId);

const userSessions = await sessions.list(userId);

The public API should not require consumers to know:

- Redis slots
- hash tags
- pipelines
- Lua
- Sentinel
- ioredis

Provide optional methods accepting userId for efficient single-slot operations:

findByUser(userId, token/jti)
rotateByUser(...)
deleteByUser(...)

But do not expose infrastructure complexity unnecessarily.

======================================================================
50. FRAMEWORK INDEPENDENCE
======================================================================

The core package must work with:

- Fastify
- Express
- Hono
- Next.js
- server actions
- API handlers
- WebSocket authentication
- background workers
- server-to-server applications

Do not import framework-specific request/response objects into the core session package.

Provide adapters separately.

======================================================================
51. ERROR MODEL
======================================================================

Create safe typed errors:

SessionError
SessionNotFoundError
SessionExpiredError
SessionRevokedError
SessionInvalidError
SessionRotationError
SessionReplayError
SessionStorageError
SessionSerializationError
SessionConfigurationError
SessionConcurrencyError
RevocationError
RevocationBatchError
CircuitBreakerOpenError

Errors must contain safe metadata.

Never include:

- raw session tokens
- cookies
- passwords
- encryption keys
- secrets
- full session payloads

Avoid putting JTI/userId into public error strings unless explicitly required.

Provide internal structured metadata with redaction.

======================================================================
52. OBSERVABILITY PRIVACY
======================================================================

Never log:

- raw session tokens
- cookies
- authorization headers
- encryption keys
- passwords
- full session payloads

Prefer:

operation
duration
result
error class
topology
Redis command category
retry count
circuit state

Use low-cardinality labels.

======================================================================
53. HEALTH AND READINESS
======================================================================

Implement a framework-neutral:

SessionHealthProvider

It should perform a cheap Redis operation.

Do not perform:

- SCAN
- COUNT all sessions
- full index traversal

during health checks.

Return:

healthy
degraded
unhealthy

based on:

- Redis connectivity
- operation latency
- recent error rate
- circuit state

activeSessionCount should be omitted or explicitly marked approximate if calculating it is expensive.

======================================================================
54. TESTING
======================================================================

Use real Redis integration tests.

Mocks alone are insufficient.

Test environments:

Standalone
Sentinel
Cluster with multiple primaries

Test:

create
get
find
validate
update
touch
rolling
idle timeout
absolute timeout
rotate
replay
destroy
revoke
revokeAll
list
cleanup
max sessions
security version
serialization
corrupt data
encryption if enabled
revocation
batch revocation
Redis outage
timeouts
reconnect
failover
resharding
MOVED
ASK
pipeline errors

======================================================================
55. CONCURRENCY TESTS
======================================================================

Run actual concurrent tests.

Examples:

100 simultaneous creates for one user.

100 simultaneous creates for many users.

Multiple simultaneous rotations of one session.

Multiple simultaneous touches.

Create during revokeAll.

Delete during validation.

Update during rotation.

Concurrent max-session enforcement.

Verify invariants after the race.

Do not simply assert that promises resolved.

Verify Redis state.

======================================================================
56. SECURITY TESTS
======================================================================

Test:

- token entropy
- token format
- raw token never stored
- raw token never logged
- session fixation prevention
- rotation
- replay
- revoke
- revokeAll
- logout
- idle timeout
- absolute timeout
- corrupt data
- malformed serialized data
- encryption key rotation
- wrong encryption key
- tampered ciphertext
- auth tag failure
- Redis outage
- failover
- concurrent rotation
- stale JTI index
- stale user index

======================================================================
57. PERFORMANCE TESTS
======================================================================

Benchmark:

validation
creation
touch
rotation
logout
list
revokeAll

Measure:

Redis round trips
latency
throughput
memory
pipeline size
Lua execution time

Expected targets:

validate:
ideally one Redis read when userId/token mapping allows it.

touch:
zero writes when within touchInterval.

touch:
one atomic write when required.

create:
minimal commands.

destroy:
minimal commands.

rotate:
one atomic same-slot state transition plus only necessary cross-slot index cleanup.

revokeAll:
bounded fan-out if cross-slot indexes exist.

Do not sacrifice correctness for micro-optimizations.

======================================================================
58. SESSION LIMIT PERFORMANCE
======================================================================

Do not use:

SMEMBERS
→ load every session
→ sort in JavaScript
→ delete

as the primary max-session algorithm if a user can have large session counts.

Use Redis sorted-set ordering and bounded eviction.

If using ZSET:

ZADD userIndex createdAt jti

Then:

ZRANGE userIndex 0 excess-1

and delete those sessions.

If atomicity is required, perform this within same-slot Lua.

But bound the amount of work.

======================================================================
59. SERIALIZATION VERSIONING
======================================================================

Every stored session must have a schema version.

Example:

v: 1

Future code should support previous versions where feasible.

Unsupported versions:

- do not crash process
- invalidate safely
- optionally delete corrupt/unsupported record
- increment a metric
- log only safe metadata

======================================================================
60. ENCRYPTION KEY ROTATION
======================================================================

If encryption is enabled:

Current key:
keyVersion = N

Existing sessions:
keyVersion = N-1

Validation must be able to decrypt N-1.

On successful touch/update, optionally re-encrypt using N.

Do not re-encrypt every session during a key rotation migration.

Use lazy migration or bounded background migration.

Never store keys in Redis.

======================================================================
61. REVOCATION TTL
======================================================================

Revocation entries must expire automatically.

TTL should normally equal remaining lifetime of the revoked credential.

If:

expiresAt <= now

reject the revocation request as already expired or treat it according to documented semantics.

Never store expired revocations indefinitely.

======================================================================
62. TOKEN VS SESSION MODEL
======================================================================

Do not confuse a JWT with a Redis session.

A JWT can be:

- access token
- refresh token
- session token
- credential identifier

Define exactly what the Redis session represents.

If JWTs are used elsewhere:

Redis session validation must not automatically imply JWT signature validation.

JWT cryptographic validation and Redis session-state validation are separate concerns.

If revocation uses JTI:

JWT JTI must be validated before using it as an authorization identifier.

======================================================================
63. SESSION FIXATION
======================================================================

Explicitly prevent session fixation.

When authentication state changes:

anonymous session
→ authenticated session

perform rotation.

Do not simply attach userId to an existing attacker-controlled session token.

Rotation must create a new cryptographically random token.

======================================================================
64. COOKIE SESSION FIXATION
======================================================================

Cookie rotation must also be atomic from the application perspective.

Do not leave the old authentication cookie valid indefinitely after rotation.

Document how the adapter:

- clears old cookie
- sets new cookie
- applies Secure
- applies HttpOnly
- applies SameSite
- applies Path

======================================================================
65. REDIS SCRIPT SAFETY
======================================================================

Never interpolate user-controlled values into Lua source.

Pass values through ARGV.

Keys must be explicit KEYS.

Do not use:

redis.call("KEYS", ...)
redis.call("SCAN", ...)
or other dangerous global operations from request-time scripts.

Keep scripts short.

======================================================================
66. REDIS COMMAND SAFETY
======================================================================

Avoid:

KEYS *
FLUSHALL
FLUSHDB

in session APIs.

Never expose arbitrary Redis commands through the session public API.

======================================================================
67. PARTIAL FAILURE OF GLOBAL INDEX
======================================================================

If using JTI index:

Creation:
session write succeeds
JTI index write fails

The session exists but JTI-only lookup may fail.

Therefore:

- userId-aware lookup remains authoritative
- cleanup/reconciliation must be possible
- optional repair API may rebuild index from known session state
- metrics should record index write failures

Do not pretend the two writes are atomic.

Rotation:

old session consumed
new session created
old JTI index delete fails
new JTI index write succeeds/fails

This must be safe because stale JTI entries must not authenticate anything.

The actual session record is authoritative.

======================================================================
68. RECONCILIATION
======================================================================

If global indexes are used, provide optional reconciliation mechanisms.

Do not require them for normal authentication correctness.

Possible:

reconcileUser(userId)
reconcileJtiIndex(...)
cleanupUserIndex(userId)

These must be bounded.

Do not scan the entire cluster during a user request.

======================================================================
69. ACTIVE SESSION COUNT
======================================================================

Do not maintain an exact global active session count unless the architecture provides a reliable way to update it atomically across all create/delete paths.

Even then, Redis failure can create accounting drift.

Prefer:

approximate/eventually consistent gauge

or:

periodic reconciliation.

Document the semantics.

======================================================================
70. CIRCUIT BREAKER SEMANTICS
======================================================================

If enabled:

CLOSED:
normal operation.

OPEN:
reject quickly with infrastructure error.

HALF_OPEN:
allow limited probes.

Successful probes:
close circuit.

Failed probes:
reopen.

Circuit transitions must be concurrency-safe.

Do not wrap all Redis operations blindly if this causes unrelated operations to share one unhealthy breaker.

Prefer operation-class breakers if necessary:

session-read
session-write
revocation

But avoid excessive complexity.

======================================================================
71. BACKPRESSURE
======================================================================

Cross-slot operations must use bounded concurrency.

Do not:

Promise.all(100000 operations)

Use:

- configurable concurrency
- batches
- pagination
- bounded pipelines

Expose limits in configuration where appropriate.

======================================================================
72. API IDEMPOTENCY
======================================================================

Explicitly document idempotency.

destroy:
idempotent.

revoke:
idempotent.

revokeAll:
idempotent.

touch:
idempotent with monotonic semantics.

create:
not idempotent unless idempotency key is supplied.

rotate:
NOT inherently idempotent unless a rotation identifier/idempotency mechanism is implemented.

Do not claim rotation is idempotent simply because it uses Lua.

======================================================================
73. ROTATION IDEMPOTENCY
======================================================================

Consider supporting:

rotationId

or equivalent.

If clients may retry after a network timeout, the server may have successfully rotated the session while the response was lost.

Without idempotency, a retry can incorrectly appear as replay.

If rotation is used across unreliable networks, design an explicit retry-safe mechanism.

Possible:

oldSession + rotationNonce
→ deterministic successor lookup

or:

oldSession stores successor JTI for a short period.

Choose the simplest design that provides correct semantics.

======================================================================
74. UPDATE CONCURRENCY
======================================================================

Do not implement unsafe:

GET
merge
SET

for concurrent updates.

If patch operations are rare, use WATCH/MULTI.

If performance-critical, use Lua.

Use version numbers.

Example:

version = version + 1

Only update if:

current.version == expectedVersion

Otherwise return conflict.

======================================================================
75. TIME HANDLING
======================================================================

Use seconds consistently if Redis TTL uses seconds.

Avoid mixing:

milliseconds
seconds
Date objects
Unix timestamps

Validate all timestamps.

Do not silently accept:

NaN
Infinity
negative expiration
fractional TTL where Redis requires integer seconds.

======================================================================
76. INPUT VALIDATION
======================================================================

All external inputs must be validated.

Validate:

userId
jti
metadata
deviceId
IP
userAgent
expiration
timeouts
configuration

Metadata must have:

- maximum size
- supported types
- safe serialization

Do not allow arbitrary cyclic objects.

======================================================================
77. PACKAGE STRUCTURE
======================================================================

Implement something similar to:

src/
  session/
    session-manager.ts
    session-service.ts
    session-repository.ts
    session-token.ts
    session-serializer.ts
    session-keys.ts
    session-types.ts
    session-errors.ts
    session-scripts.ts
    session-health.ts
    session-metrics.ts
    session-cookie.ts
    session-config.ts
    session-revocation.ts
    scripts/
      create.lua
      touch.lua
      rotate.lua
      delete.lua
      conditional-update.lua
      enforce-limit.lua
      delete-by-user.lua
      cleanup-index.lua

Tests:

tests/
  session/
    standalone/
    sentinel/
    cluster/
    concurrency/
    security/
    failure/
    performance/

Update:

RedisConfig
Zod configuration
RedisClientWrapper
cluster utilities
pipeline utilities
public exports
documentation

======================================================================
78. EXISTING CODE REVIEW
======================================================================

If existing code resembles:

CREATE_SCRIPT:

SET session
SADD user index

this is acceptable only if both keys share the same hash tag and the script is correctly designed.

If existing code resembles:

GET current
then EVAL rotation

do not assume the GET makes rotation safe.

The EVAL script must perform the authoritative state check.

If existing code uses:

SMEMBERS
→ load all sessions
→ sort in JavaScript

replace it where scale makes this unsafe.

If existing code uses:

pipeline.exec()
and only checks whether exec() threw:

fix it.

Pipeline command-level errors must be inspected.

If existing code builds:

jtiIndexKey(jti)

as a global key, explicitly model the partial consistency boundary.

If existing code uses:

consumedAt

ensure that consumed sessions cannot authenticate.

If existing code retains consumed records, bound their TTL.

If existing code stores raw JTI/session tokens in logs/errors, remove this.

======================================================================
79. CODE QUALITY
======================================================================

Use:

TypeScript strict
ESM
Node 22+
small cohesive modules
dependency injection
interfaces
runtime validation

Avoid:

any
unsafe casts
framework coupling
private ioredis APIs
global mutable state
hidden singleton clients
magic constants
unbounded concurrency
unbounded Redis operations

Do not expose ioredis types unnecessarily.

======================================================================
80. TEST INFRASTRUCTURE
======================================================================

Prefer real infrastructure:

Standalone Redis container.

Sentinel Redis environment with:

- master
- replica
- Sentinel

Cluster with multiple primaries/replicas.

Tests should verify actual behavior rather than mocked assumptions.

Use deterministic test fixtures.

Clean namespaces between tests.

Do not use FLUSHALL in shared environments.

======================================================================
81. ACCEPTANCE CHECKLIST
======================================================================

Before declaring completion, verify:

[ ] Standalone works
[ ] Sentinel works
[ ] Cluster works
[ ] Real CRC16 implemented
[ ] Hash tags correct
[ ] No hot global session slot
[ ] Cluster-aware pipelines
[ ] Cluster-aware MGET
[ ] Cluster-aware SCAN
[ ] Cross-slot operations explicitly handled
[ ] Same-slot atomic operations use Lua/atomic commands
[ ] Secure random tokens
[ ] At least 128 bits entropy
[ ] Prefer 256 bits
[ ] SHA-256 token hashing where appropriate
[ ] Raw tokens never stored
[ ] Raw tokens never logged
[ ] Raw tokens never appear in metrics
[ ] Session fixation prevented
[ ] Rotation prevents replay
[ ] Rotation concurrency safe
[ ] Rotation retry semantics documented
[ ] Idle timeout
[ ] Absolute timeout
[ ] Redis TTL
[ ] Rolling sessions
[ ] Touch throttling
[ ] Monotonic touch
[ ] Security version
[ ] Session update concurrency safety
[ ] Logout idempotency
[ ] Revoke idempotency
[ ] Revoke-all
[ ] Max sessions
[ ] Strictness of max sessions documented
[ ] Stale user index cleanup
[ ] Global JTI index consistency documented if used
[ ] Revocation store
[ ] Revocation TTL
[ ] Revocation pipeline errors checked
[ ] Redis failures fail closed
[ ] Infrastructure errors distinguished from invalid sessions
[ ] Circuit breaker fail-closed
[ ] Health checks cheap
[ ] Metrics low-cardinality
[ ] Active session count semantics documented
[ ] Optional encryption correctly implemented if enabled
[ ] Encryption IV uniqueness
[ ] Encryption authentication tag validation
[ ] Encryption key versioning
[ ] Encryption key rotation
[ ] Serialization versioning
[ ] Corrupt records handled safely
[ ] Metadata size limits
[ ] Bounded concurrency
[ ] No KEYS in production APIs
[ ] No unbounded Lua loops
[ ] No unnecessary Redis round trips
[ ] No unsafe retries
[ ] Redis failover tested
[ ] Sentinel failover tested
[ ] Cluster failover tested
[ ] Cluster resharding tested
[ ] MOVED tested
[ ] ASK tested
[ ] Partial failures tested
[ ] Network timeout after successful write tested
[ ] Concurrent operations tested
[ ] Security tests exist
[ ] Performance tests exist
[ ] Documentation exists
[ ] Public API framework-independent
[ ] TypeScript strict passes
[ ] No unnecessary any
[ ] No hidden topology logic in SessionService

======================================================================
82. REQUIRED IMPLEMENTATION REVIEW
======================================================================

After implementation, perform a second architecture review.

Specifically look for:

- race conditions
- lost updates
- session fixation
- replay
- stale indexes
- false authentication
- fail-open behavior
- cross-slot errors
- hot slots
- partial writes
- ambiguous Redis outcomes
- unsafe retries
- Lua script complexity
- memory growth
- unbounded user indexes
- excessive Redis round trips
- expensive health checks
- high-cardinality metrics
- encryption misuse
- serialization corruption
- clock skew
- circuit-breaker behavior
- pipeline command-level errors
- cluster failover behavior
- Sentinel promotion behavior
- resharding behavior

Do not stop at "TypeScript compiles".

Do not stop at unit tests passing.

The implementation must be reviewed as a distributed authentication infrastructure component.

======================================================================
83. REQUIRED DELIVERABLE
======================================================================

Produce:

1. Complete implementation.
2. All required source files.
3. All Redis Lua scripts.
4. Updated Redis infrastructure.
5. Zod configuration.
6. Public exports.
7. Session manager/service/repository.
8. Session token manager.
9. Session serializer.
10. Optional encryption subsystem.
11. Session cookie utility.
12. Revocation store.
13. Health provider.
14. Metrics abstraction.
15. Circuit breaker if justified.
16. Cluster utilities.
17. Integration tests.
18. Concurrency tests.
19. Security tests.
20. Failure/failover tests.
21. Performance tests where appropriate.
22. Documentation.
23. Architecture decision notes for any important deviation from this specification.

======================================================================
84. FINAL ENGINEERING PRINCIPLE
======================================================================

The final implementation must respect this fundamental Redis Cluster model:

Single session:
    ↓
Hash-tagged user/session keys
    ↓
Same slot
    ↓
Atomic operation possible

Multiple sessions for one user:
    ↓
Same user hash tag
    ↓
Same slot
    ↓
Atomic user-level operations possible

Sessions across different users:
    ↓
Different slots
    ↓
No cross-slot transaction
    ↓
Use controlled fan-out/pipelines

Global JTI index:
    ↓
Different slot
    ↓
Not atomically coupled with user session record
    ↓
Treat as secondary/derived state

Revocation JTI keys:
    ↓
Independent single-key operations
    ↓
Cluster-safe

Redis Cluster must NOT be treated like a single-node Redis database.

Do not fight the distributed architecture.

Design around it.

Most importantly:

DO NOT simply implement the supplied design mechanically.

Where the supplied design is technically weaker than a production-grade alternative, change it.

Where a requirement is impossible to make atomic across Redis Cluster slots, explicitly model the partial-failure semantics.

Where convenience creates unnecessary distributed consistency, remove it.

Where strict guarantees cannot be provided, document the actual guarantee instead of claiming stronger semantics.

The final system should be secure, horizontally scalable, topology-independent, observable, testable, operationally predictable, and appropriate for a production authentication platform handling millions of sessions.
