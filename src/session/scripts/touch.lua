-- touch.lua (version 1) - plain (v1) envelopes
-- Throttled, monotonic activity refresh for plain sessions.
--
-- The script is authoritative for all state checks (exists, status,
-- absolute expiry, idle expiry, throttle). Timestamps come from Redis
-- server time, so distributed application clocks cannot race each other.
--
-- KEYS[1] = session record key
--
-- ARGV[1] = touchInterval (seconds)
-- ARGV[2] = idleTimeout (seconds, '' when idle timeout disabled)
-- ARGV[3] = force (1 = ignore throttle)
--
-- Returns:
--   1   touched (write performed)
--   2   skipped: inside touchInterval
--   3   skipped: request older than recorded activity (not possible with
--       server time; retained for parity with the encrypted path)
--   0   not found
--   -1  consumed or revoked
--   -2  absolute expiry passed; record deleted
--   -3  idle expired; NOT resurrected
--   4   envelope is encrypted (caller must use the encrypted touch path)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)

if env.v ~= 1 then
  return 4
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

if s.idleExpiresAt and s.idleExpiresAt ~= cjson.null and tonumber(s.idleExpiresAt) <= now then
  return -3
end

local interval = tonumber(ARGV[1])

if tonumber(ARGV[3]) ~= 1 and now - tonumber(s.lastAccessedAt) < interval then
  return 2
end

s.lastAccessedAt = now

if ARGV[2] ~= '' then
  local idle = now + tonumber(ARGV[2])
  local abs = tonumber(s.absoluteExpiresAt)
  -- Rolling extends the idle boundary but NEVER the absolute boundary.
  s.idleExpiresAt = math.min(idle, abs)
end

local ttl = math.max(1, tonumber(s.absoluteExpiresAt) - now)

redis.call('SET', KEYS[1], cjson.encode(env), 'EX', ttl)

return 1