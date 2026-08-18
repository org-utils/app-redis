-- rotate.lua (version 1) - plain (v1) envelopes
-- Atomic, single-use session rotation.
--
-- The old session is consumed (status=consumed, consumedAt, rotatedTo,
-- rotationNonceHash) and the successor is created, all in one same-slot
-- script. No preliminary GET can make this safe; the script is the only
-- authority. Timestamps are stamped from Redis server time.
--
-- Retry-safe idempotency: when the caller retries a rotation that already
-- succeeded (response lost), the consumed record retains rotationNonceHash
-- and rotatedTo. If both match the retry, the script returns {2, jti} and
-- the caller returns the existing successor instead of a replay error.
--
-- KEYS[1] = old session record key
-- KEYS[2] = successor session record key
-- KEYS[3] = user session index key
--
-- ARGV[1] = successor serialized envelope (app-built static fields)
-- ARGV[2] = successor jti
-- ARGV[3] = expected version of the old session ('' = no check)
-- ARGV[4] = rotation nonce hash ('' = none)
-- ARGV[5] = retain consumed tombstone (1/0)
-- ARGV[6] = old jti
--
-- Returns:
--   {1, successorJti}  success
--   {2, successorJti}  idempotent replay of a rotation with the same nonce
--   0                  old session not found
--   -1                 already consumed / revoked (replay)
--   -2                 old session expired (record removed)
--   -3                 version conflict
--   -4                 successor jti collision
--   5                  envelope is encrypted (use the encrypted path)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 1 then
  return 5
end

local s = env.s
local now = tonumber(redis.call('TIME')[1])

-- Retry-safe replay detection BEFORE rejecting consumed records.
-- The rotation nonce uniquely identifies the rotation: when the consumed
-- record carries the same nonce hash, this is a retry of an already-applied
-- rotation. The stored rotatedTo jti is returned (the retry's own freshly
-- generated successor jti is discarded - it can never match).
if s.status == 'consumed' then
  if ARGV[4] ~= '' and s.rotationNonceHash == ARGV[4] then
    return { 2, s.rotatedTo }
  end
  return -1
end

if s.status ~= 'active' then
  return -1
end

if tonumber(s.absoluteExpiresAt) <= now then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[6])
  return -2
end

if ARGV[3] ~= '' and tostring(s.version) ~= ARGV[3] then
  return -3
end

-- Successor collision: cryptographically improbable, but never overwrite.
if redis.call('EXISTS', KEYS[2]) == 1 then
  return -4
end

-- Build the successor record; server time is authoritative for ordering.
local nextEnv = cjson.decode(ARGV[1])
local ns = nextEnv.s

ns.createdAt = now
ns.lastAccessedAt = now
ns.rotatedFrom = s.jti
ns.version = 1

if ns.idleExpiresAt and ns.idleExpiresAt ~= cjson.null then
  ns.idleExpiresAt = math.min(tonumber(ns.idleExpiresAt), tonumber(ns.absoluteExpiresAt))
end

local nextTtl = math.max(1, tonumber(ns.absoluteExpiresAt) - now)

-- Consume the old session.
s.status = 'consumed'
s.consumedAt = now
s.rotatedTo = ARGV[2]

if ARGV[4] ~= '' then
  s.rotationNonceHash = ARGV[4]
else
  s.rotationNonceHash = cjson.null
end

local oldTtl = math.max(1, tonumber(s.absoluteExpiresAt) - now)

if ARGV[5] == '1' then
  -- Short-lived consumed tombstone for replay detection (bounded TTL).
  redis.call('SET', KEYS[1], cjson.encode(env), 'EX', oldTtl)
else
  redis.call('DEL', KEYS[1])
end

redis.call('SET', KEYS[2], cjson.encode(nextEnv), 'EX', nextTtl)
redis.call('ZREM', KEYS[3], ARGV[6])
redis.call('ZADD', KEYS[3], now, ARGV[2])

return { 1, ARGV[2] }