-- conditional-update-encrypted.lua (version 1) - encrypted (v2) envelopes
-- Optimistic-concurrency patch update for encrypted sessions.
--
-- The app decrypts the record, applies the whitelisted patch, re-encrypts
-- and passes the new envelope. The script CAS's the plaintext version
-- mirror and enforces status/expiry; the absolute expiry mirror is
-- preserved from the stored record (identity/security fields can never be
-- changed through update).
--
-- KEYS[1] = session record key
--
-- ARGV[1] = expected version ('' = no check)
-- ARGV[2] = new serialized envelope (app-built, re-encrypted)
-- ARGV[3] = new version (expected + 1)
-- ARGV[4] = new TTL (clamped >= 1)
--
-- Returns:
--   {1, newVersion}  applied
--   0                not found
--   -1               consumed or revoked
--   -2               expired (record removed)
--   -3               version conflict
--   6                envelope is plain (use the plain path)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 2 then
  return 6
end

if env.st ~= 'active' then
  return -1
end

local now = tonumber(redis.call('TIME')[1])

if tonumber(env.exp) <= now then
  redis.call('DEL', KEYS[1])
  return -2
end

if ARGV[1] ~= '' and tostring(env.ver) ~= ARGV[1] then
  return -3
end

local newEnv = cjson.decode(ARGV[2])
newEnv.st = 'active'
newEnv.ver = tonumber(ARGV[3])
newEnv.exp = env.exp
newEnv.rn = env.rn
newEnv.rj = env.rj

redis.call('SET', KEYS[1], cjson.encode(newEnv), 'EX', tonumber(ARGV[4]))

return { 1, ARGV[3] }