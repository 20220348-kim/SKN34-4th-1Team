-- Do not overwrite an existing token, including an already claimed result.
if redis.call('EXISTS', KEYS[1]) == 1 then
    return 0
end
local now = redis.call('TIME')
local expiresAt = now[1] * 1000 + math.floor(now[2] / 1000) + tonumber(ARGV[2])
redis.call('HSET', KEYS[1], 'payload', ARGV[1])
redis.call('PEXPIREAT', KEYS[1], expiresAt)
return expiresAt
