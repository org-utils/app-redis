# app-redis

## 0.0.11

### Patch Changes

- [`50dc64e`](https://github.com/org-utils/app-redis/commit/50dc64e0e2c023e664066cc0ff89560e263ac9a3) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - updated package

## 0.0.10

### Patch Changes

- [`9b7adf2`](https://github.com/org-utils/app-redis/commit/9b7adf27b06c5478ac929eaf10a4a930af11f59a) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - updated key configuratoin

## 0.0.9

### Patch Changes

- [`4d06be7`](https://github.com/org-utils/app-redis/commit/4d06be77cdb1c9c1c391f1ff5e092f5d93bec4f5) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - Updated package to add session

## 0.0.9

### Minor Changes

- **Session subsystem** (`createSessionManager`, `src/session/`): production session stack on top of the legacy stores — validation with fail-closed semantics (`SessionStorageError` = 503, never "invalid"), retry-safe rotation (idempotent `rotationNonce` replays), throttled touches, idle + absolute expiry, atomic per-user eviction ceilings, security versioning, optional AES-256-GCM encryption at rest with key rotation, optional jti index, fail-closed circuit breaker, metrics/health hooks, and idempotent creation. All Cluster-safe by construction (hash-tagged Lua scripts, slot-grouped pipelines).
- `RedisRevocationStore` gained typed `RevocationError` / `RevocationBatchError` (both `RedisError` subclasses) with exact failure jtis, future-`expiresAt` validation, redaction, and fail-closed reads.

### Patch Changes

- Fixed **sentinel mode**: the wrapper passed `sentinelNodes` straight to
  ioredis, which expects `sentinels` — sentinel connections only worked
  against the mock and failed with `ECONNREFUSED` against real sentinels.
  Now translated internally (public API unchanged).
- Legacy `RedisSessionStore` is marked `@deprecated` (kept, frozen); the
  `RedisRevocationStore` in `src/session/revocation-store.ts` was upgraded
  in place and is shared by the new subsystem.
- Lua scripts ship in the published package (`dist/session/scripts`).
- Full test coverage: 12 files / 143 tests — 40 pure unit tests for the
  subsystem plus 55 real-Redis integration/security/concurrency/failure/
  encryption/performance tests (smoke included), all also validated
  against a real Redis Cluster and Sentinel with a live failover drill
  (see `test/infra/`).
- Stale jti-index entries are now removed best-effort whenever the session
  record is gone (spec §25); repeated business errors (invalid tokens,
  consumed sessions) can no longer open the circuit breaker; cyclic
  metadata is rejected as `SessionInvalidError` instead of a 503; session
  metrics carry a `topology` label and surface jti-index write failures
  (`session.jti_index.write_failures`).

## 0.0.8

### Patch Changes

- [`ff887e3`](https://github.com/org-utils/app-redis/commit/ff887e3c2bcf943897baf427021d5618bfc07ac0) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - update the shape

## 0.0.7

### Patch Changes

- [`7b010a0`](https://github.com/org-utils/app-redis/commit/7b010a0bda267e508f95354e207c00af682e27d2) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - updated types

## 0.0.6

### Patch Changes

- [`ae1775f`](https://github.com/org-utils/app-redis/commit/ae1775fd96ad38f542bdb300e473e607bcb395b1) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - optional ratelimit params

## 0.0.5

### Patch Changes

- [`6d276aa`](https://github.com/org-utils/app-redis/commit/6d276aa0c2f5786d77dfba1fe00635b7463c461f) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - Update the whole package

## 0.0.4

### Patch Changes

- [`ac33e19`](https://github.com/org-utils/app-redis/commit/ac33e190faabc7a888ea839e21dffa34fbf23f7a) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - added getdel method to redis client

## 0.0.3

### Patch Changes

- [`6343f62`](https://github.com/org-utils/app-redis/commit/6343f622ff67ae7e817e704e7d95c331af54f0ed) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - Updated health check

## 0.0.2

### Patch Changes

- [#7](https://github.com/org-utils/app-redis/pull/7) [`e27bb47`](https://github.com/org-utils/app-redis/commit/e27bb4791813b2d514c7dda0648ed8a5464fb16b) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - removed hardcoded logger

## 0.0.1

### Patch Changes

- [#4](https://github.com/org-utils/app-redis/pull/4) [`8d96134`](https://github.com/org-utils/app-redis/commit/8d961345324e81e72ccb5373069c14d52a440895) Thanks [@Anwarkamal143](https://github.com/Anwarkamal143)! - updated the version by patching
