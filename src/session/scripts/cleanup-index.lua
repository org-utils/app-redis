-- cleanup-index.lua (version 1)
-- Lazily removes stale members (whose session records no longer exist,
-- e.g. expired and naturally reclaimed by Redis TTL) from the user index.
-- Bounded: the caller chunks the user's jtis into batches.
--
-- KEYS[1]   = user session index key
-- KEYS[2..] = session record keys (same slot as KEYS[1])
--
-- ARGV[1..] = matching jtis (index i pairs with KEYS[i + 1])
--
-- Returns: the jtis removed from the index.
local removed = {}

for i = 2, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then
    redis.call('ZREM', KEYS[1], ARGV[i - 1])
    table.insert(removed, ARGV[i - 1])
  end
end

return removed