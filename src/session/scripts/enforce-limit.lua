-- enforce-limit.lua (version 1)
-- Standalone max-session enforcement (admin/repair paths). Evicts the
-- oldest excess sessions from a user's index using ZSET ordering and
-- bounded work (never loads the whole index).
--
-- KEYS[1] = user session index key
--
-- ARGV[1] = maxSessionsPerUser (0 disables)
-- ARGV[2] = max evictions per call (bounded Lua work; callers loop to
--           converge when the excess exceeds this bound)
-- ARGV[3] = session key prefix for this user (same hash tag => same slot)
--
-- Returns: { evictedCount, {evictedJtis...} }
local card = redis.call('ZCARD', KEYS[1])
local limit = tonumber(ARGV[1])

if limit <= 0 then
  return { 0, {} }
end

local excess = card - limit

if excess <= 0 then
  return { 0, {} }
end

local n = math.min(excess, tonumber(ARGV[2]))
local members = redis.call('ZRANGE', KEYS[1], 0, n - 1)
local prefix = ARGV[3]
local evicted = {}

for _, member in ipairs(members) do
  redis.call('DEL', prefix .. member)
  redis.call('ZREM', KEYS[1], member)
  table.insert(evicted, member)
end

return { #evicted, evicted }