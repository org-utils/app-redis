-- rotate-encrypted.lua (version 1) - encrypted (v2) envelopes
-- Atomic, single-use session rotation for encrypted sessions.
--
-- The ciphertext cannot be decoded inside Lua, so the app decrypts the
-- old record, builds the consumed + successor payloads (re-encrypted with
-- the current key) and passes them as ARGV. The script is the only
-- authority for the state transition, decided from the plaintext header
-- mirrors (st/ver/exp/rn/rj) and Redis server time; the header mirrors of
-- the written payloads are overwritten from the checked values so a stale
-- app payload can never misrepresent state.
--
-- KEYS[1] = old session record key
-- KEYS[2] = successor session record key
-- KEYS[3] = user session index key
--
-- ARGV[1] = consumed serialized envelope (app-built, re-encrypted)
-- ARGV[2] = successor serialized envelope (app-built, re-encrypted)
-- ARGV[3] = successor jti
-- ARGV[4] = expected version of the old session ('' = no check)
-- ARGV[5] = rotation nonce hash ('' = none)
-- ARGV[6] = retain consumed tombstone (1/0)
-- ARGV[7] = old jti
-- ARGV[8] = successor TTL (clamped >= 1)
-- ARGV[9] = consumed tombstone TTL (clamped >= 1)
--
-- Returns: same codes as rotate.lua (1/2/0/-1/-2/-3/-4/5), plus 6 when the
-- envelope is plain (caller must use the plain path).
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 2 then
  return 6
end

local now = tonumber(redis.call('TIME')[1])

-- Retry-safe replay detection BEFORE rejecting consumed records.
-- The rotation nonce uniquely identifies the rotation: when the consumed
-- record carries the same nonce hash, this is a retry of an already-applied
-- rotation. The stored rotatedTo jti is returned (the retry's own freshly
-- generated successor jti is discarded - it can never match).
if env.st == 'consumed' then
  if ARGV[5] ~= '' and env.rn == ARGV[5] then
    return { 2, env.rj }
  end
  return -1
end

if env.st ~= 'active' then
  return -1
end

if tonumber(env.exp) <= now then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[7])
  return -2
end

if ARGV[4] ~= '' and tostring(env.ver) ~= ARGV[4] then
  return -3
end

if redis.call('EXISTS', KEYS[2]) == 1 then
  return -4
end

local consumedEnv = cjson.decode(ARGV[1])
consumedEnv.st = 'consumed'
consumedEnv.ver = env.ver
consumedEnv.la = env.la
consumedEnv.idle = env.idle
consumedEnv.exp = env.exp
consumedEnv.rn = cjson.null
consumedEnv.rj = ARGV[3]

if ARGV[5] ~= '' then
  consumedEnv.rn = ARGV[5]
end

local nextEnv = cjson.decode(ARGV[2])
nextEnv.st = 'active'
nextEnv.ver = 1
nextEnv.la = now
if nextEnv.idle ~= cjson.null then
  nextEnv.idle = math.min(tonumber(nextEnv.idle), tonumber(nextEnv.exp))
end
nextEnv.rn = cjson.null
nextEnv.rj = cjson.null

local nextTtl = math.max(1, tonumber(ARGV[8]))

if ARGV[6] == '1' then
  redis.call('SET', KEYS[1], cjson.encode(consumedEnv), 'EX', math.max(1, tonumber(ARGV[9])))
else
  redis.call('DEL', KEYS[1])
end

redis.call('SET', KEYS[2], cjson.encode(nextEnv), 'EX', nextTtl)
redis.call('ZREM', KEYS[3], ARGV[7])
redis.call('ZADD', KEYS[3], now, ARGV[3])

return { 1, ARGV[3] }