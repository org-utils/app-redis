-- delete-by-user.lua (version 2)
-- Deletes a bounded batch of a user's sessions and removes them from the
-- user index, in one same-slot script. The caller chunks the user's jtis
-- into batches (limits.maxBatchSize), so a user with an arbitrarily large
-- session count never produces one giant script.
--
-- KEYS[1]   = user session index key
-- KEYS[2..] = session record keys (same slot as KEYS[1])
--
-- ARGV[1..] = matching jtis (index i pairs with KEYS[i + 1])
--
-- Returns: the jtis whose records were actually deleted. The index key is
-- deleted at the end (the whole-user operation is complete when the caller
-- has processed every batch).
local deleted = {}

for i = 2, #KEYS do
  local jti = ARGV[i - 1]

  if redis.call('DEL', KEYS[i]) == 1 then
    table.insert(deleted, jti)
  end

  redis.call('ZREM', KEYS[1], jti)
end

redis.call('DEL', KEYS[1])

return deleted