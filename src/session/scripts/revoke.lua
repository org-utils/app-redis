-- revoke.lua (version 1)
-- Logically revokes a session: status -> 'revoked' with a bounded tombstone
-- TTL (remaining absolute lifetime). Revoked sessions never authenticate,
-- even if a stale copy of the record survives somewhere. Idempotent: a
-- second revoke returns 2.
--
-- KEYS[1] = session record key
--
-- ARGV[1] = new serialized envelope for encrypted (v2) sessions,
--           '' for plain (v1) sessions (the script builds it itself)
-- ARGV[2] = tombstone TTL (remaining absolute lifetime, clamped >= 1)
--
-- Returns:
--   1   revoked
--   2   already revoked (idempotent)
--   0   not found
--   3   unknown envelope (neither v1 nor v2)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return 0
end

local env = cjson.decode(raw)
local ttl = tonumber(ARGV[2])

if env.v == 1 then
  local s = env.s

  if s.status == 'revoked' then
    return 2
  end

  s.status = 'revoked'
  redis.call('SET', KEYS[1], cjson.encode(env), 'EX', ttl)
  return 1
end

if env.v == 2 then
  if env.st == 'revoked' then
    return 2
  end

  if ARGV[1] == '' then
    return 4
  end

  local newEnv = cjson.decode(ARGV[1])
  newEnv.st = 'revoked'
  newEnv.ver = env.ver
  newEnv.la = env.la
  newEnv.idle = env.idle
  newEnv.exp = env.exp
  newEnv.rn = env.rn
  newEnv.rj = env.rj

  redis.call('SET', KEYS[1], cjson.encode(newEnv), 'EX', ttl)
  return 1
end

return 3