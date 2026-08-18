-- conditional-update.lua (version 1) - plain (v1) envelopes
-- Optimistic-concurrency patch update. The script is the authority for:
--   - existence / status / expiry checks
--   - the version compare-and-swap
--   - the mutable-field whitelist (identity and security-critical fields
--     are never touched, regardless of what the caller sends)
--
-- KEYS[1] = session record key
--
-- ARGV[1] = expected version ('' = no check)
-- ARGV[2] = patch JSON: only { deviceId?, ipAddress?, userAgent?, metadata? }
--           may be present; other keys are ignored (never applied)
--
-- Returns:
--   {1, newVersion}  applied
--   0                not found
--   -1               consumed or revoked
--   -2               expired (record removed)
--   -3               version conflict
--   5                envelope is encrypted (use the encrypted path)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 1 then
  return 5
end

local s = env.s

if s.status ~= 'active' then
  return -1
end

local now = tonumber(redis.call('TIME')[1])

if tonumber(s.absoluteExpiresAt) <= now then
  redis.call('DEL', KEYS[1])
  return -2
end

if ARGV[1] ~= '' and tostring(s.version) ~= ARGV[1] then
  return -3
end

local patch = cjson.decode(ARGV[2])

if patch.deviceId ~= nil then s.deviceId = patch.deviceId end
if patch.ipAddress ~= nil then s.ipAddress = patch.ipAddress end
if patch.userAgent ~= nil then s.userAgent = patch.userAgent end
if patch.metadata ~= nil then s.metadata = patch.metadata end

s.version = tonumber(s.version) + 1

local ttl = math.max(1, tonumber(s.absoluteExpiresAt) - now)

redis.call('SET', KEYS[1], cjson.encode(env), 'EX', ttl)

return { 1, tostring(s.version) }