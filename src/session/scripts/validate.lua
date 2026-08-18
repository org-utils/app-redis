-- validate.lua (version 1)
-- Single-round-trip validation read: fetches the session record, the
-- user's security version (when the key exists) and lazily cleans up
-- expired records and their index members, all in one same-slot script.
--
-- The script performs the cheap, non-cryptographic state checks; binding
-- checks and (for encrypted sessions) decryption happen app-side on the
-- returned payload. A missing security-version key means the check is
-- skipped (the version is only enforced once setSecurityVersion has run).
--
-- KEYS[1] = session record key
-- KEYS[2] = user security version key (same slot)
-- KEYS[3] = user session index key (same slot)
--
-- ARGV[1] = jti (used for the lazy index cleanup of encrypted records,
--            whose headers do not carry their own jti)
--
-- Returns:
--   {1, raw, securityVersion?}  record exists and passed script checks;
--                               raw is the stored envelope; securityVersion
--                               is the current user version when set
--   {0}                         not found
--   {-1, status}                not active (consumed/revoked)
--   {-2}                        expired (absolute); record + index entry
--                               removed
--   {-3}                        idle expired; record + index entry removed
--   {-4}                        security version mismatch (plain records)
local raw = redis.call('GET', KEYS[1])

if not raw then
  return { 0 }
end

local currentRaw = redis.call('GET', KEYS[2])
local currentVersion = nil

if currentRaw then
  currentVersion = tonumber(currentRaw)
end

local env = cjson.decode(raw)
local now = tonumber(redis.call('TIME')[1])

if env.v == 1 then
  local s = env.s

  if s.status ~= 'active' then
    return { -1, s.status }
  end

  if tonumber(s.absoluteExpiresAt) <= now then
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[3], s.jti)
    return { -2 }
  end

  if s.idleExpiresAt and s.idleExpiresAt ~= cjson.null and tonumber(s.idleExpiresAt) <= now then
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[3], s.jti)
    return { -3 }
  end

  if currentVersion and (s.securityVersion == nil or tonumber(s.securityVersion) ~= currentVersion) then
    return { -4 }
  end
elseif env.v == 2 then
  -- Encrypted envelope: only the plaintext header mirrors are readable in
  -- Lua. They are the script-level authority for state decisions; the
  -- ciphertext remains authoritative for the payload (assertHeaderMatches).
  if env.st ~= 'active' then
    return { -1, env.st }
  end

  if tonumber(env.exp) <= now then
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[3], ARGV[1])
    return { -2 }
  end

  if env.idle ~= cjson.null and tonumber(env.idle) <= now then
    redis.call('DEL', KEYS[1])
    redis.call('ZREM', KEYS[3], ARGV[1])
    return { -3 }
  end

  -- Security version is checked app-side for encrypted records (it lives
  -- only inside the ciphertext).
end

return { 1, raw, currentVersion }