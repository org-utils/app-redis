-- delete.lua (version 1)
-- Physically deletes a session record and removes it from the user index.
-- Idempotent: deleting a missing session returns 0 and is not an error.
--
-- KEYS[1] = session record key
-- KEYS[2] = user session index key
--
-- ARGV[1] = jti
--
-- Returns: 1 if the record existed, 0 otherwise.
local existed = redis.call('DEL', KEYS[1])

redis.call('ZREM', KEYS[2], ARGV[1])

return existed