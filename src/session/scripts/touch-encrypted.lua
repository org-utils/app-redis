-- touch-encrypted.lua (version 1) - encrypted (v2) envelopes
-- Throttled, monotonic activity refresh for encrypted sessions.
--
-- The ciphertext cannot be decoded inside Lua, so the app re-encrypts the
-- record (with its own clock) and passes the new envelope as ARGV[4]. The
-- script validates state via the plaintext header mirrors and enforces
-- monotonicity: a stale request can never move lastAccessedAt backwards.
--
-- KEYS[1] = session record key
--
-- ARGV[1] = touchInterval (seconds)
-- ARGV[2] = idleTimeout (seconds, '' when disabled)
-- ARGV[3] = force (1 = ignore throttle)
-- ARGV[4] = new serialized envelope (re-encrypted with the current key)
-- ARGV[5] = new lastAccessedAt (app clock, seconds)
-- ARGV[6] = new idleExpiresAt (app clock, seconds, '' when disabled)
-- ARGV[7] = new TTL (absoluteExpiresAt - now, clamped >= 1)
--
-- Returns:
--   1   touched (write performed)
--   2   skipped: inside touchInterval
--   3   skipped: request older than recorded activity
--   0   not found
--   -1  consumed or revoked
--   -2  absolute expiry passed; record deleted
--   -3  idle expired; NOT resurrected
--   4   envelope is plain (caller must use the plain touch path)
--   5   stale request: ARGV[5] older than recorded activity
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 2 then
  return 4
end

if env.st ~= 'active' then
  return -1
end

local now = tonumber(redis.call('TIME')[1])

if tonumber(env.exp) <= now then
  redis.call('DEL', KEYS[1])
  return -2
end

if env.idle ~= cjson.null and tonumber(env.idle) <= now then
  return -3
end

local interval = tonumber(ARGV[1])

if tonumber(ARGV[3]) ~= 1 and now - tonumber(env.la) < interval then
  return 2
end

-- Monotonic guard: a stale app request must never regress activity.
-- Equal-second requests are allowed (the app clock is second-granular and
-- cannot advance within the same second); only strictly older writes are
-- rejected.
local newLa = tonumber(ARGV[5])

if newLa < tonumber(env.la) then
  return 5
end

local newEnv = cjson.decode(ARGV[4])

-- Keep the plaintext header mirrors in sync with the checked values.
newEnv.st = env.st
newEnv.la = newLa
if ARGV[6] ~= '' then
  newEnv.idle = tonumber(ARGV[6])
else
  newEnv.idle = cjson.null
end
newEnv.ver = env.ver
newEnv.exp = env.exp
newEnv.rn = env.rn
newEnv.rj = env.rj

redis.call('SET', KEYS[1], cjson.encode(newEnv), 'EX', tonumber(ARGV[7]))

return 1