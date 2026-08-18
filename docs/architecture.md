# Session subsystem — architecture, decisions and deviations

This document records the non-obvious design decisions, deliberate
deviations from a naive implementation, and the exact semantics of the
Redis-backed session + revocation subsystem (`src/session/`). It is the
authoritative companion to `SESSION.md` (the original spec) — where the
spec and this document disagree, this document wins.

## 1. Token model

- A **raw token** is `randomBytes(32)` base64url. It is returned to the
  caller exactly once (on `create`) and is **never persisted** — not in
  Redis, not in logs, not in error details.
- A **jti** is `base64url(SHA-256(token))`. All Redis keys and index
  members use the jti. `SessionTokenManager.hash` is the only mapping.
- Idempotent creation: when `SessionCreateInput.idempotencyKey` is set,
  the **idempotency key IS the token** (`token = key`, `jti =
  hash(key)`). The caller must therefore use **globally unique, random
  keys (UUIDs)**; two users sharing one key produce the same jti, which
  collides in derived state (the optional jti index, the revocation
  store). The per-user create claim itself is user-scoped and safe.

## 2. Key layout and Cluster safety

| Key | Hash tag | Purpose |
| --- | --- | --- |
| `{ns}:session:{userId}:session:{jti}` | `{userId}` | the session record |
| `{ns}:user-sessions:{userId}` | `{userId}` | ZSET of the user's sessions (score = createdAt) |
| `{ns}:security-version:{userId}` | `{userId}` | current security version |
| `{ns}:create-claim:{userId}:{jti}` | `{userId}` | idempotent-create claim |
| `{ns}:jti-index:{jti}` | none (own slot) | optional jti → userId lookup |
| `{ns}:revoked:{jti}` | none | revocation store |

User ids are percent-encoded, so no user id can contain `:` and every
`{userId}`-tagged key family stays in one Cluster slot. **All
same-user operations run as a single Lua script** (atomic, no pipelining
gaps). Cross-slot work (jti index, revokeAll, `deleteByUser`) is executed
by slot-grouped pipelines with bounded concurrency
(`limits.maxFanOutConcurrency`) and bounded batches
(`limits.maxBatchSize`, `limits.maxEvictionsPerCall`).

## 3. The jti index is derived state, never authoritative

`validate`/`rotate`/`update`/etc. resolve the user id from the index only
when the caller omits `userId`. A **missing index entry is not proof of
absence**: the index has its own TTL, is written after (and read before)
the record write, and the record remains authoritative. Consequences,
documented exactly:

- `resolveUserId` returning `null` produces `not_found` outcomes —
  never "invalid", never a throw.
- The index entry for a **consumed** session is intentionally **kept**
  after rotation (TTL-bounded). This is what makes retry-safe rotation
  replays work without a `userId`: the replay resolves the old jti
  through the index for the tombstone window. Validation of the consumed
  session fails regardless of what the index says.
- `destroy`/`revoke`/`deleteByUser` do delete the index entry (the
  session is gone); a later index lookup degrades to `not_found`, which
  is still an invalid outcome.

## 4. Retry-safe rotation (replay semantics)

`rotate(token, { rotationNonce })` is idempotent: the nonce uniquely
identifies the rotation. The scripts store only `hash(nonce)` (the raw
nonce never touches Redis) and the successor jti.

- First call: consumes the record, writes the successor, returns
  `{ token: successorToken, session, replayed: false }`.
- Retry with the **same** nonce: returns the stored successor record
  with `{ session, replayed: true }` and **no token** — the successor
  token cannot be recovered from its hash. The caller must treat the
  outcome as ambiguous and re-authenticate.
- Retry with a **different** nonce (or none) against a consumed record:
  `SessionRevokedError` — a replay attempt.
- **Deviations from the naive design (fixed during testing):** the
  retry's freshly generated successor jti is **never compared** against
  the stored `rotatedTo` — it is discarded. The stored value is
  authoritative. This bug existed in both `rotate.lua` (fixed) and the
  repository's encrypted pre-check (fixed); a unit/integration suite
  (`encryption.test.ts` "replay across managers") now guards it.

## 5. Encrypted sessions (v2 envelopes)

Envelopes: v1 = `{v:1, s:Record}` (plain), v2 =
`{v:2, e:1, k, i, t, c, st, ver, la, idle, exp, rn, rj}` (AES-256-GCM).

- The **header mirrors** (`st/ver/la/idle/exp/rn/rj`) exist so Lua
  scripts can make state decisions atomically without decrypting; the
  ciphertext is authoritative for the payload and
  `assertHeaderMatches` fails closed on any mismatch.
- Lua can therefore check status/expiry/idle for v2 records too
  (`validate.lua` v2 branch, added when the test suite proved consumed
  encrypted sessions were validating as valid).
- Re-encryption happens app-side; the scripts overwrite the header
  mirrors from the checked values so a stale app payload can never
  misrepresent state.
- Key rotation: sessions written under a retired key stay valid while
  the provider still returns the old key; once a version is dropped,
  those sessions become **invalid** (undecryptable) — fail closed, they
  are never "valid". `StaticSessionKeyProvider` and
  `createRandomSessionKeyProvider` are for single-process/development;
  production should plug a KMS-backed `SessionKeyProvider`.

## 6. Clock handling and the two-second granularity rule

- Lua uses `redis.call('TIME')` (Redis server time) for all authoritative
  decisions — no client clock in the critical path.
- Encrypted re-encryption paths re-encrypt app-side, so the app clock
  supplies the new `lastAccessedAt`. The touch script's monotonic guard
  rejects writes **older** than the recorded activity but allows
  **equal-second** writes (the app clock is second-granular and cannot
  advance within the same second; rejecting equality broke legitimate
  same-second touches — fixed in `touch-encrypted.lua`).
- `expired`/`idle_timeout` reasons: the Redis TTL on the record equals
  its earliest boundary, so in normal operation an expired record is
  usually already gone (`not_found`). The script-level `-2`/`-3` codes
  fire when the record outlives its boundary (e.g. TTL removed) and the
  read **deletes** it lazily — a first read reports
  `expired`/`idle_timeout`, subsequent reads `not_found`.

## 7. Fail-closed contract

| Outcome | HTTP mapping |
| --- | --- |
| `valid: true` | 200 |
| `valid: false` (`invalid`/`not_found`/`expired`/`idle_timeout`/`revoked`/`binding_mismatch`) | 401 |
| `SessionStorageError` (infra failure, incl. `circuit_open`) | 503 |
| everything else | programming/config error (500) |

- Validation **never** returns "valid" on infrastructure failure: reads
  that cannot be completed reject with `SessionStorageError` (the
  revocation-store read is included — a broken store check is a 503, not
  a 401).
- The circuit breaker (`circuitBreaker.enabled`) trips only on storage
  failures; invalid-token outcomes are counted as `invalid` metrics, not
  breaker failures (the `validate` guard uses a `classify` callback). This
  is enforced in the service guard: only `SessionStorageError` (and
  unexpected non-`SessionError` throwers) call `breaker.recordFailure()` —
  business errors (`not_found`, `revoked`, `concurrency`, `invalid`, ...)
  are expected outcomes of bad input and can never open the circuit
  (DoS-amplification guard, verified by test).
- Tampered/corrupt records are reported `invalid` **and deleted**
  (best-effort cleanup), so a poisoned record cannot wedge a user.
- Metrics carry a constant `topology` label (`standalone`/`sentinel`/
  `cluster`) from the client config; best-effort jti-index write failures
  are surfaced as `session.jti_index.write_failures` (derived-state
  degradation is observable, never fatal). Deliberately **not** emitted:
  `active_sessions` gauge (exact global counts are impossible on a shared
  cluster — `countByUser` is available per user) and a
  `session_rotation_replay_total` counter (replays are already visible as
  `rotate` outcomes; a dedicated counter would require distinguishing the
  replay branch in the metrics path).

## 8. Idempotent creation

`enableCreateIdempotency` (default off): the create script stores a
claim (`{ns}:create-claim:{userId}:{jti}`, TTL `min(60, ttl)`) **before**
the collision check, so a retried create with the same key returns the
original session (`replayed: true`) instead of creating a duplicate or
erroring. The claim check precedes the EXISTS check in `create.lua`
(ordering fixed during testing). Claims are user-scoped; see §1 for the
global-uniqueness requirement on keys.

## 9. Touch semantics

- Throttled by `touchInterval` (service-side map + script check); `force`
  bypasses.
- A session past its idle boundary is **not** resurrected by touch
  (`idle_expired`, or `not_found` after the lazy cleanup of §6).
- Rolling sessions extend the idle boundary via the absolute `ttl`
  ceiling; non-rolling sessions keep the key until absolute expiry and
  let the script enforce the idle boundary (this is what makes
  `idle_timeout` observable in tests).

## 10. Eviction ceiling

`maxSessionsPerUser` is enforced **inside the create script**: the
create that pushes the count over the limit evicts the oldest excess
sessions in the same atomic step, so parallel logins cannot both observe
spare capacity. Eviction is bounded per call
(`limits.maxEvictionsPerCall`) and converges over subsequent creates for
very large indexes. Evicted records are **deleted outright** (no
tombstone): they validate as `not_found`.

## 11. Idempotency keys vs strict token format

The strict token format (base64url of the configured entropy) remains
the primary gate against malformed input; caller-supplied idempotency
keys (bounded printable ASCII, 8–256 chars) are additionally accepted by
`isAcceptableToken` so an idempotent create can be validated/touched/
rotated with the same string. This is a deliberate, bounded relaxation
(SHA-256 hashing makes any accepted string safe; the length and alphabet
bounds keep it DoS-safe).

## 12. Deviations from SESSION.md (summary)

1. `rotate` replay: stored `rotatedTo` is authoritative; fresh successor
   jtis are never compared (both plain and encrypted paths).
2. `create.lua`: claim check before collision check.
3. `touch-encrypted.lua`: monotonic guard rejects strictly older writes
   only (equal-second writes allowed).
4. `validate.lua`: gained a v2 branch (status/expiry/idle checks for
   encrypted records) + `ARGV[1]` jti for index cleanup; the old jti
   index entry is kept after rotation.
5. Encrypted rotate: app-side replay pre-check uses the stored
   `rotatedTo`, not the fresh jti.
6. `validate` accepts idempotency-key tokens (see §11).
7. Stale jti-index entries are removed best-effort (never throwing) at
   every record-gone branch (validate `0`/`-2`/`-3`, touch/update/rotate
   `not_found`, destroy `false`, revoke `not_found`), instead of only via
   TTL. The spec's "remove stale index" is implemented without ever making
   the cleanup part of an auth decision.
8. Cyclic metadata objects are rejected with `SessionInvalidError`
   (`metadata_cyclic`), not a 503: the size check runs `JSON.stringify`
   inside a `TypeError` guard.
9. Metrics use `session.<op>.total` / `session.<op>.duration_ms` naming
   with a `topology` label rather than the spec's suggested OpenMetrics
   names; `active_sessions` gauge and a rotation-replay counter are
   deliberately omitted (see §7).