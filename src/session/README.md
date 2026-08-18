# app-redis Session subsystem (`src/session/`)

The production session stack: server-side authentication sessions (refresh
tokens, long-lived browser sessions) with validation, retry-safe rotation,
idle/absolute expiry, eviction ceilings, security versioning, optional
AES-256-GCM encryption at rest, a fail-closed circuit breaker, metrics and
health — all Redis-Cluster-safe by construction.

- Spec: `SESSION.md` (root of the package)
- Decisions & deviations: `docs/architecture.md`
- This file: the complete operational API reference.

```ts
import { createSessionManager } from 'app-redis';
// or: import { createSessionManager } from 'app-redis/session';
```

---

## 1. Token model

| Thing | Definition | Persisted? |
| --- | --- | --- |
| **raw token** | `randomBytes(32)` (256-bit) encoded base64url | **never** — not stored, logged, or embedded in keys/errors |
| **jti** | `SHA-256(token)` base64url | yes — the Redis key component and the only identity stored |
| **rotation nonce** | same-strength random string, hashed on rotate | only its SHA-256 hash (`rotationNonceHash`), for retry safety |

A jti can only be reversed to the token by brute force, so persisting it is
safe. The raw token is returned to the caller exactly once (on `create` /
`rotate`) and must be handed to the client (cookie / header / app storage).

`SessionTokenManager` API:

```ts
const token = manager.token.generate();        // new raw token
const nonce = manager.token.generateNonce();   // rotation nonce
const jti = manager.token.hash(token);         // SHA-256, base64url
manager.token.validateFormat(token);           // boolean: strict format check
manager.token.safeEquals(a, b);                // constant-time compare
const jti = manager.token.tokenToJti(token);   // throws SessionInvalidError if malformed
```

---

## 2. Quick start (complete flow)

```ts
import { createSessionManager } from 'app-redis/session';

const manager = createSessionManager({
  client, // RedisClientWrapper (standalone / sentinel / cluster)
  config: {
    enabled: true,             // required: explicit opt-in
    namespace: 'authcore',
    ttl: 60 * 60 * 24 * 30,    // 30 days absolute lifetime
    idleTimeout: 60 * 60 * 24, // 24h idle timeout
    maxSessionsPerUser: 20,
  },
});
await manager.init();          // eagerly SCRIPT LOAD the Lua scripts

// ---- Login: create -----------------------------------------------------
const { token, session } = await manager.service.create({
  userId: 'user-42',
  deviceId: 'web-chrome',
  ipAddress: '10.0.0.1',
  userAgent: 'Mozilla/5.0 …',
  metadata: { plan: 'pro', tags: ['a', 'b'] },
});
// Give `token` to the client; store it nowhere server-side.

// ---- Cookie helper -----------------------------------------------------
const setCookie = manager.cookies.serialize(token); // 'sid=…; Path=/; HttpOnly; Secure; SameSite=Lax'
// req -> res.setHeader('Set-Cookie', setCookie)
const fromHeader = manager.cookies.parse(req.headers.cookie); // token | null

// ---- Authenticate: validate --------------------------------------------
// Pass userId when the auth layer knows it: single Redis round trip.
const result = await manager.service.validate(fromHeader, {
  userId: 'user-42',
  ipAddress: requestIp,
});
if (result.valid) {
  const s = result.session;   // SessionRecord — check s.metadata etc.
} else {
  // result.reason: 'invalid' | 'not_found' | 'expired' | 'idle_timeout'
  //               | 'revoked' | 'binding_mismatch'
}

// ---- Activity: touch ---------------------------------------------------
await manager.service.touch(token, { userId: 'user-42' });
// 'touched' | 'skipped_throttled' | 'skipped_stale' | 'not_found'
// | 'consumed' | 'expired' | 'idle_expired'

// ---- Rotate (single-use; retry-safe with a nonce) ----------------------
const rotated = await manager.service.rotate(token, {
  userId: 'user-42',
  rotationNonce: 'uuid-or-csp-rand',   // idempotent retries
});
// Give rotated.token to the client, drop the old token.

// ---- Logout ------------------------------------------------------------
await manager.service.destroy(token, { userId: 'user-42' }); // physical
await manager.service.revoke(token, { userId: 'user-42' });   // tombstone
await manager.service.revokeAll('user-42');                   // logout all devices
await manager.service.deleteByUser('user-42');                // physical, all devices

// ---- Security event (password change, MFA reset) -----------------------
await manager.service.setSecurityVersion('user-42'); // bumps 0->1, invalidates all older sessions
```

---

## 3. Architecture

```
application
  └─ SessionManager            composition root (createSessionManager)
       ├─ SessionService       business rules, guards, fail-closed mapping
       │    ├─ SessionRepository      Redis I/O (plain + encrypted paths)
       │    │    └─ SessionScriptRegistry + Lua scripts/  (13 atomic scripts)
       │    ├─ SessionTokenManager    token/jti
       │    ├─ SessionKeyStrategy     cluster-safe key layout
       │    ├─ SessionMetrics         counters/histograms/gauge (adapter)
       │    ├─ SessionCircuitBreaker  fail-closed trip on storage failures
       │    ├─ SessionHealthChecker   PING + sliding error-rate
       │    ├─ SessionCookieManager   Set-Cookie / Cookie helpers
       │    └─ (optional) RedisRevocationStore  external jti denylist
       └─ config: Zod-validated, defaults applied (session-config.ts)
```

The client (`RedisClientWrapper`) and any encryption key provider are
**owned by the application**; `manager.close()` only invalidates the script
cache (the client stays open).

---

## 4. Key layout (Redis Cluster safe)

Every key of one user carries the `{userId}` hash tag (the userId is
percent-encoded by `encodeUserId` first), so per-user atomic Lua scripts
work on Cluster. No global hash tag is used, so users spread across slots.

| Key | Type | Purpose |
| --- | --- | --- |
| `{ns}:session:{userId}:session:{jti}` | string | session record (TTL = remaining lifetime) |
| `{ns}:user-sessions:{userId}` | ZSET | per-user index (member = jti, score = createdAt) |
| `{ns}:security-version:{userId}` | string | per-user security version counter |
| `{ns}:create-claim:{userId}:{jti}` | string | idempotent-create claim (TTL `min(60, ttl)`) |
| `{ns}:jti-index:{jti}` | string | **optional** global jti → userId map (cross-slot, derived state) |
| `{ns}:revoked:{jti}` | string | **optional** revocation entries (single-key, no tag) |

The jti index is **never authoritative** — the session record is. A missing
index entry is not proof of absence (see `docs/architecture.md` §3). The
index self-heals: stale entries are removed best-effort whenever the record
is gone, and all entries have a TTL.

---

## 5. Configuration

`parseSessionConfig` (Zod) validates and applies defaults. Invalid config
throws `SessionConfigurationError` at construction.

### Top-level

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | **Required** opt-in; the manager throws otherwise |
| `namespace` | string | `'authcore'` | Key prefix (1–64 chars, no whitespace/`{}:*?[]`) |
| `tokenBytes` | int | `32` | Raw token entropy (16–64 bytes) |
| `ttl` | int | `2_592_000` (30d) | Absolute lifetime in seconds (the hard max) |
| `idleTimeout` | int \| null | `86_400` (24h) | Idle timeout; `null` disables inactivity expiry |
| `rolling` | boolean | `true` | `touch` extends the idle boundary (never the absolute one) |
| `touchInterval` | int | `300` | Min seconds between touch writes (throttling) |
| `maxSessionsPerUser` | int | `20` | Eviction ceiling; `0` disables. Enforced **atomically inside the create script** |
| `storeDeviceId` | boolean | `false` | Persist `deviceId` from `create()` |
| `storeIpAddress` | boolean | `false` | Persist `ipAddress` from `create()` |
| `storeUserAgent` | boolean | `false` | Persist `userAgent` from `create()` |
| `bindingPolicy` | enum | `'disabled'` | `'disabled'` \| `'advisory'` (report mismatch) \| `'strict'` (reject with `binding_mismatch`) |
| `securityVersion` | object | off | `{ enabled }` — capture user version at create, check at validate |
| `jtiIndex` | object | off | `{ enabled }` — global jti → userId index |
| `checkRevocationStore` | boolean | `false` | Consult the revocation store during `validate()` |
| `encryption` | object | off | `{ enabled, reEncryptOnWrite }` (see §10) |
| `circuitBreaker` | object | off | `{ enabled, failureThreshold, resetTimeoutMs, halfOpenMaxRequests }` |
| `metrics` | object | on | `{ enabled }` (no-op without an adapter) |
| `health` | object | — | `{ latencyThresholdMs: 200, errorRateThreshold: 0.1, errorWindowSize: 100 }` |
| `cookie` | object | — | `{ name: 'sid', path: '/', httpOnly: true, secure: true, sameSite: 'lax' }` |
| `limits` | object | — | see below |
| `enableCreateIdempotency` | boolean | `false` | Idempotent `create()` via `idempotencyKey` |
| `retainConsumedTombstones` | boolean | `true` | Keep consumed records (TTL-bounded) for replay detection |

### Limits

| Option | Default | Description |
| --- | --- | --- |
| `maxMetadataSize` | `4096` | Max serialized metadata bytes (reject larger writes) |
| `maxListPageSize` | `100` | Max sessions fetched per list page |
| `maxBatchSize` | `100` | Max session keys per Lua invocation |
| `maxFanOutConcurrency` | `8` | Max concurrent cross-slot pipelines (revokeAll, jti cleanup) |
| `maxEvictionsPerCall` | `1000` | Max sessions evicted by one enforce-limit script call |
| `maxSessionsPerUserHardCap` | `10_000` | Max sessions processed per user-scoped bulk op |

### Validation rules (Zod superRefine)

- `idleTimeout` must not exceed `ttl`
- `touchInterval` must not exceed `ttl`
- `sameSite: 'none'` requires `secure: true`
- `encryption.enabled` requires `encryptionKeyProvider` at construction

`redactSessionConfig(config)` returns a safe-to-log subset.

---

## 6. `createSessionManager` / `SessionManager`

```ts
createSessionManager(options: SessionManagerOptions): SessionManager
```

| Option | Description |
| --- | --- |
| `client` | `RedisClientWrapper` (standalone / sentinel / cluster) |
| `config` | partial config; defaults applied |
| `encryptionKeyProvider` | **required** when `encryption.enabled` |
| `revocationStore` | external jti denylist checked when `checkRevocationStore` |
| `metricsAdapter` | sink for metrics (no-op without it) |
| `circuitBreaker` | inject a custom breaker instead of the config-built one |
| `now` | injectable clock (tests) |

Manager surface:

| Member | Type | Purpose |
| --- | --- | --- |
| `manager.config` | `SessionConfig` | parsed, defaults applied |
| `manager.service` | `SessionService` | all operations (§7) |
| `manager.repository` | `SessionRepository` | low-level Redis I/O (advanced) |
| `manager.metrics` | `SessionMetrics` | metrics facade (§11) |
| `manager.health` | `SessionHealthChecker` | PING + error-rate health (§12) |
| `manager.circuitBreaker` | `SessionCircuitBreaker \| null` | breaker, when enabled (§13) |
| `manager.cookies` | `SessionCookieManager` | cookie helpers (§8) |
| `manager.token` | `SessionTokenManager` | token/jti (§1) |
| `manager.keys` | `SessionKeyStrategy` | key layout (§4) |
| `manager.init()` | async | eagerly `SCRIPT LOAD` all Lua scripts |
| `manager.close()` | void | invalidates the script cache (client stays open) |

---

## 7. `SessionService` — operation reference

All operations are guarded: metrics + health feedback per call, and — when
the breaker is enabled — fail-fast `circuit_open` (thrown as
`SessionStorageError` with `reason: 'circuit_open'`) while open.

### `create(input: SessionCreateInput): Promise<CreatedSession>`

| Input | Description |
| --- | --- |
| `userId` | required, 1–512 chars |
| `deviceId` / `ipAddress` / `userAgent` | stored only when the matching `store*` config is on |
| `metadata` | arbitrary JSON, bounded by `limits.maxMetadataSize` |
| `idempotencyKey` | requires `enableCreateIdempotency`; 8–256 printable ASCII; **is** the token |

Result: `{ token, session, replayed? }`. `token` is the raw token — hand it
to the client, store it nowhere. `replayed: true` = a previous create with
the same `idempotencyKey` won; the same token resolves to the existing
session. The claim is TTL-bounded (`min(60, ttl)`), so replay windows
cannot grow forever.

Throws: `SessionConfigurationError` (userId/idempotencyKey invalid;
idempotencyKey without the feature), `SessionInvalidError`
(`metadata_too_large`, `metadata_cyclic`).

### `validate(token, options?): Promise<SessionValidationResult>`

**Never throws for invalid sessions.** Throws `SessionStorageError` only on
infrastructure failure (fail closed), and `SessionConfigurationError` when
a userId is required but absent and the jti index is disabled.

| Option | Description |
| --- | --- |
| `userId` | known user → single round trip, skip the index |
| `ipAddress` / `userAgent` / `deviceId` | compared against stored values under `bindingPolicy` |

Result (discriminated union):

```ts
{ valid: true,  session: SessionRecord, binding?: BindingMismatch }
{ valid: false, reason: 'invalid' | 'not_found' | 'expired' | 'idle_timeout'
                     | 'revoked' | 'binding_mismatch' }
```

Check order (all fail closed on infra errors):

1. Token format (`isAcceptableToken`) → `invalid`
2. userId resolution (index or explicit) → `not_found`
3. Script read: record gone → `not_found`; consumed/revoked → `invalid`/`revoked`; absolute expiry → `expired`; idle expiry → `idle_timeout`
4. Deserialize/decrypt: corruption or tampering → `invalid` + best-effort record cleanup
5. Security version mismatch (encrypted path; plain path checked in the script) → `revoked`
6. Binding policy: mismatch with `strict` → `binding_mismatch`
7. Revocation store (`checkRevocationStore`) → `revoked`
8. `binding` details reported when `advisory`

### `touch(token, options?): Promise<TouchOutcome>`

`{ force?, userId? }`. Throttled by `touchInterval` (in-memory + in-script).
Never resurrects an idle-expired session.

Outcome: `'touched'` \| `'skipped_throttled'` \| `'skipped_stale'` \|
`'not_found'` \| `'consumed'` \| `'expired'` \| `'idle_expired'`.

### `rotate(token, options?): Promise<RotatedSession>`

Single-use atomic rotation. `{ rotationNonce?, userId?, expectedVersion? }`.

- With a nonce, retries are idempotent: if the first rotation succeeded but
  the response was lost, retrying with the same nonce returns the
  already-created successor with `replayed: true` and **no `token`** (the
  successor's raw token is unrecoverable — the caller must re-authenticate
  rather than reuse the old token).
- The old record becomes a consumed tombstone (`retainConsumedTombstones`)
  so reuse of the old token is detected: validate → `invalid` (or
  `revoked` for revoked records); another rotate → throws.
- `expectedVersion` applies optimistic concurrency (stale → throw).

Result: `{ token?, session, replayed }` — `token` present and `replayed:
false` on a fresh rotation; absent on a replay.

Throws: `SessionNotFoundError` (unknown token / `jti_index_miss`),
`SessionRevokedError` (reuse with wrong/absent nonce on a consumed
record), `SessionExpiredError`, `SessionConcurrencyError`
(`version_conflict`), `SessionRotationError` (`successor_collision`,
`successor_unavailable`), `SessionSerializationError`
(`envelope_mode_mismatch`).

### `update(token, patch, options?): Promise<SessionRecord>`

Patch-only update of non-security fields: `deviceId`, `ipAddress`,
`userAgent`, `metadata` (each `undefined` = leave, `null` = clear).
`{ expectedVersion?, userId? }` — optimistic concurrency; a stale version
throws `SessionConcurrencyError` (`version_conflict`). Throws
`SessionNotFoundError` when the session is gone; `SessionInvalidError` for
oversized/cyclic metadata and overlong fields.

### `destroy(token, options?): Promise<boolean>`

Physical, idempotent deletion (+ index cleanup). `false` when the session
did not exist.

### `revoke(token, options?): Promise<string>`

Logical revocation with a bounded tombstone (TTL = session TTL).
Returns `'revoked'` \| `'already_revoked'` \| `'not_found'`. Also removes
the jti index entry.

### `revokeAll(userId): Promise<number>`

Revokes every session of a user (bounded by `maxSessionsPerUserHardCap`,
fan-out bounded by `maxFanOutConcurrency`). Returns the number revoked.
Partial failure surfaces as `SessionStorageError`.

### `deleteByUser(userId): Promise<string[]>`

Physically deletes every session of a user; returns the removed jtis.

### `findByUser(userId, options?): Promise<SessionRecord[]>`

Oldest-first listing. `{ limit? (default 100), offset?, includeInactive?
(default false) }`. Lazily cleans stale index members. `list` is an alias.

### `setSecurityVersion(userId, version?): Promise<number>`

Bumps (or sets) the user's security version, invalidating every session
captured at an older version (validate → `revoked`). Use after password /
MFA changes. `getSecurityVersion(userId)` reads it.

### `health(): Promise<SessionHealthStatus>`

Delegates to the health checker (always configured by the manager).

---

## 8. `SessionCookieManager`

Framework-independent `Set-Cookie` / `Cookie` helpers.

```ts
manager.cookies.name;                              // 'sid'
manager.cookies.serialize(token, { maxAge? });     // Set-Cookie value (string)
manager.cookies.serializeWithAttributes(token, options);
//   → { header, name, value, attributes: { path, domain?, httpOnly,
//        secure, sameSite, maxAge? } }   // both the string AND the object
manager.cookies.clear({ path? });                  // expires the cookie
manager.cookies.parse(header);                     // token | null
```

`serialize` is a thin wrapper over `serializeWithAttributes` — they always
agree. `header` is ready for `res.setHeader('Set-Cookie', …)`; the
structured `attributes` (or the whole `SerializedCookie`) are for
framework adapters, logging, and exact-shape tests. `SerializedCookie`,
`SerializedCookieAttributes` and `SerializeCookieOptions` are exported
from the package root and `app-redis/session`.

Defaults from `config.cookie`; `Max-Age` comes from `options.maxAge` or
`config.cookie.maxAge` — pass the session TTL explicitly to align the
cookie lifetime with the session. The raw token IS the cookie value —
HttpOnly + Secure by default.

---

## 9. `SessionRecord` (persisted shape)

```ts
{
  jti: string;                  // SHA-256(token) base64url — identity, immutable
  userId: string;               // identity, immutable
  createdAt: number;            // Unix seconds — identity, immutable
  lastAccessedAt: number;
  absoluteExpiresAt: number;    // hard boundary; Redis TTL derives from it
  idleExpiresAt: number | null;
  status: 'active' | 'consumed' | 'revoked';
  version: number;              // optimistic concurrency
  securityVersion: number | null;
  deviceId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  rotatedFrom: string | null;   // rotation chain
  rotatedTo: string | null;     // enables retry-safe rotation
  consumedAt: number | null;
  rotationNonceHash: string | null;
}
```

Serialization: plain records are stored as `{ v: 1, s: <record> }`;
encrypted records as `{ v: 2, e: 1, k, i, t, c, st, ver, la, idle, exp, rn,
rj }` — an AES-256-GCM envelope plus plaintext mirrors of the fields Lua
needs. A header that disagrees with the decrypted payload fails closed.

---

## 10. Encryption at rest

Threat model: protects against a **compromised Redis instance / disk /
backup** (payloads unreadable and tamper-evident without the key). It does
**not** protect against a compromised application process (the key lives
in it) or key deletion (DoS).

- AES-256-GCM, 12-byte random IV per encryption, 16-byte auth tag.
- Key versioning: the envelope stores `k`; reads support older versions
  via the provider; writes use the current key (`reEncryptOnWrite` lazily
  re-encrypts on touch/update).
- A key version no longer available from the provider makes those sessions
  `invalid` (they are cleaned up).
- Keys never live in config or Redis — only in the provider.

```ts
import { StaticSessionKeyProvider, createRandomSessionKeyProvider } from 'app-redis';

// KMS/vault-backed provider (production):
const provider: SessionKeyProvider = {
  getCurrentKey() { return { keyVersion: 2, key: await vault.key(2) }; },
  getKey(v) { return v >= 1 ? await vault.key(v) : null; },
};

// Single-process convenience (dev/tests):
const provider = createRandomSessionKeyProvider(1);

const manager = createSessionManager({
  client,
  config: { enabled: true, namespace: 'authcore', encryption: { enabled: true } },
  encryptionKeyProvider: provider,
});
```

`SessionKeyProvider`: `getCurrentKey(): { keyVersion, key }` and
`getKey(keyVersion): Buffer | string | null`. Keys must be exactly 32 bytes
(AES-256). Keys may be Buffers or strings — strings are decoded by
`toKeyBuffer` in priority order: 64-char hex, base64/base64url decoding to
32 bytes, then utf8. A `SessionKeyProvider` interface is exported for custom
implementations; `StaticSessionKeyProvider` validates keys at construction.

---

## 11. Metrics

`SessionMetricsAdapter` (injected via `metricsAdapter`):

```ts
interface SessionMetricsAdapter {
  incCounter(name: string, delta?: number, attributes?: Record<string, string | number>): void;
  recordHistogram(name: string, value: number, attributes?: Record<string, string | number>): void;
  setGauge(name: string, value: number, attributes?: Record<string, string | number>): void;
}
```

Emitted names:

| Name | Type | Attributes |
| --- | --- | --- |
| `session.<op>.total` | counter | `outcome` (`ok`/`error`/`invalid`), `code` (e.g. `storage`, `circuit_open`), `topology` |
| `session.<op>.duration_ms` | histogram | `topology` |
| `session.circuit_breaker.state` | gauge | `topology` (0 closed / 1 half_open / 2 open) |
| `session.circuit_breaker.<state>` | counter | `topology` |
| `session.revocation_store.fail_closed` | counter | `topology` |
| `session.encryption.errors` | counter | `reason`, `topology` |
| `session.jti_index.write_failures` | counter | `topology` |

Operations (`<op>`): `create`, `validate`, `touch`, `rotate`, `update`,
`destroy`, `revoke`, `revoke_all`, `delete_by_user`, `list`,
`find_by_user`, `set_security_version`, `health`.

`topology` is the client mode (`standalone` | `sentinel` | `cluster`).
Metrics never throw and never touch the hot path. Without an adapter every
call is a no-op.

---

## 12. Health

`manager.health.check(): Promise<SessionHealthStatus>`

```ts
{ healthy: boolean, latencyMs: number | null, errorRate: number,
  reachable: boolean, checkedAt: number }
```

`healthy` requires: reachable (PING succeeded), latency ≤
`health.latencyThresholdMs` (200), and the sliding-window operation error
rate (last `errorWindowSize` ops, fed automatically by the service) ≤
`health.errorRateThreshold` (0.1). `check()` never throws — probe failures
surface as `reachable: false`. Health does not affect per-request
semantics: requests still fail closed individually.

---

## 13. Circuit breaker

Fail-closed breaker around session storage calls. **Trips only on storage
failures** — `SessionStorageError` (infra) and unexpected throwers count;
business outcomes (`invalid`, `not_found`, `revoked`, concurrency
conflicts, malformed tokens) never do, so bad input cannot open the
circuit (DoS amplification guard, enforced in the service guard).

Config: `enabled` (default off), `failureThreshold` (10), `resetTimeoutMs`
(30_000), `halfOpenMaxRequests` (5).

States: `closed` → (consecutive storage failures ≥ threshold) → `open`
(all calls fail fast for `resetTimeoutMs`, thrown as
`SessionStorageError` with `reason: 'circuit_open'`) → (timer elapsed, on
next call) → `half_open` (up to `halfOpenMaxRequests` probes; first success
closes, first failure reopens).

The breaker is **process-local** by design (failures are usually local to a
connection/instance). API: `state`, `run(fn)`, `tryAcquire()`,
`recordSuccess()`, `recordFailure()`, `reset()`. A custom breaker can be
injected via `createSessionManager({ circuitBreaker })`.

---

## 14. `RedisRevocationStore`

External jti denylist (JWT jti denylists, cross-service revocations),
plugged in via `revocationStore` and checked when
`checkRevocationStore: true`. Also usable standalone.

```ts
const store = new RedisRevocationStore({ client, keyPrefix: 'auth:revoked:' });

await store.revoke({ jti, reason: 'logout', expiresAt: unixSeconds });
await store.revokeMany([{ jti, reason, expiresAt }, …]);   // slot-grouped pipelines
await store.isRevoked(jti);                                // boolean
const revoked = await store.isRevokedMany([jti1, jti2]);   // Set<string>
```

- Key = `{prefix}{jti}`, TTL = remaining lifetime → automatic reclamation.
- Validation fails fast: missing / non-finite / past `expiresAt` →
  `RevocationError` before any network call.
- **Fail closed**: a failed check throws `RevocationError` /
  `RevocationBatchError` (carrying the exact failed jtis) — an unknown
  status is never treated as "not revoked".
- Batch pipelines are grouped by hash slot and every command result is
  inspected.

---

## 15. Errors

All extend `SessionError` (which extends `RedisError`). Public messages
never contain raw tokens, cookies, keys or identifiers; jtis/userIds appear
only redacted in `details`. `redactIdentifier(value)` is exported for
logging.

| Class | Code | HTTP | When |
| --- | --- | --- | --- |
| `SessionStorageError` | `SESSION_STORAGE_UNAVAILABLE` | **503** | infra failure; also `circuit_open` fast-fails; the only error that trips the breaker |
| `SessionNotFoundError` | `SESSION_NOT_FOUND` | 401 | token unknown, record gone, `invalid_token`, `jti_index_miss` |
| `SessionExpiredError` | `SESSION_EXPIRED` | 401 | rotate on an expired session |
| `SessionRevokedError` | `SESSION_REVOKED` | 401 | rotate reuse on a consumed/revoked session |
| `SessionInvalidError` | `SESSION_INVALID` | 401 | `metadata_too_large`, `metadata_cyclic`, `device_id_too_long`, `ip_address_too_long`, `user_agent_too_long` |
| `SessionRotationError` | `SESSION_ROTATION_FAILED` | 401 | `successor_collision`, `successor_unavailable` |
| `SessionReplayError` | `SESSION_REPLAY` | 401 | exported for API compatibility; rotation reuse is thrown as `SessionRevokedError` |
| `SessionConcurrencyError` | `SESSION_CONCURRENCY` | 409 | `version_conflict`, `session_not_active` |
| `SessionSerializationError` | `SESSION_SERIALIZATION_ERROR` | 401/500 | corrupt/tampered records, `envelope_mode_mismatch`, unknown key version |
| `SessionConfigurationError` | `SESSION_CONFIGURATION_ERROR` | 500 | invalid config (construction), missing userId without jti index, bad idempotency key |
| `RevocationError` | `REVOCATION_ERROR` | 503 | revocation could not be persisted / checked |
| `RevocationBatchError` | `REVOCATION_BATCH_ERROR` | 503 | partial batch failure; `.failures`/`.ids` carry the affected jtis |
| `CircuitBreakerOpenError` | `CIRCUIT_OPEN` | 503 | exported; the service throws `SessionStorageError` (`circuit_open`) instead |

**Fail-closed contract**: `SessionStorageError` → 503, never "invalid".
`SessionNotFound/Expired/Revoked/Invalid` → 401. Everything else is a
programming or configuration error (500).

---

## 16. Lua scripts (`src/session/scripts/`)

All scripts are deterministic, strict-mode, declare every key in `KEYS`,
use server time (`TIME`), and only touch same-slot keys (per-user hash
tags).

| Script | Purpose |
| --- | --- |
| `create.lua` | atomic create + user-index add + eviction ceiling + idempotency claim (claim checked **before** the collision check) |
| `validate.lua` | read + status/expiry/idle checks + lazy cleanup + jti-index cleanup (`ARGV[1]`) + security-version check; v2 (encrypted) branch via header mirrors |
| `touch.lua` | throttled monotonic activity refresh |
| `touch-encrypted.lua` | encrypted touch: header-mirror CAS (equal-second writes allowed) |
| `rotate.lua` | single-use rotation: consume old, create successor, keep tombstone (stored `rotatedTo` authoritative for replays) |
| `rotate-encrypted.lua` | encrypted rotation with the same replay semantics |
| `conditional-update.lua` | CAS patch update (version conflict → `-3`) |
| `conditional-update-encrypted.lua` | encrypted CAS patch update |
| `revoke.lua` | logical revoke with bounded tombstone |
| `delete.lua` | physical delete + index member removal |
| `delete-by-user.lua` | physical delete of every session of a user |
| `enforce-limit.lua` | bounded eviction of the oldest excess sessions |
| `cleanup-index.lua` | bounded stale-member cleanup of the user index |

`EVALSHA` with automatic `EVAL` fallback (survives `SCRIPT FLUSH` and
cluster node restarts); `manager.init()` preloads all scripts up front.
The scripts ship in the published package under `dist/session/scripts`.

---

## 17. Cluster / topology notes

- Per-user hash tags make every per-user transition a single atomic script,
  including the eviction ceiling (parallel logins cannot both observe spare
  capacity).
- Cross-slot work (jti index, revocation batches, revokeAll fan-out) is
  slot-grouped with bounded concurrency (`limits.maxFanOutConcurrency`) —
  no `CROSSSLOT`, no unbounded fan-out.
- No `SCAN`/`KEYS` is used against session state; list/cleanup paths work
  through the ZSET index.
- Sentinel/cluster failover: the wrapper reconnects and re-runs scripts
  (NOSCRIPT → EVAL fallback); validated by a live failover drill
  (`test/infra/sentinel-failover-probe.mjs`).

---

## 18. Testing

- Unit (40): config, keys, token, serializer, encryption, cookie, metrics,
  health, breaker, revocation-store validation — no Redis required.
- Real-Redis suites in `test/session/` (integration, concurrency, security,
  failure, encryption, performance): run against `localhost:6379` by
  default; `REDIS_MODE=cluster` / `REDIS_MODE=sentinel` with the compose
  topologies in `test/infra/`; skip cleanly when Redis is unreachable.
- `npm run typecheck` covers `src/`, `test/` and `scripts/`.