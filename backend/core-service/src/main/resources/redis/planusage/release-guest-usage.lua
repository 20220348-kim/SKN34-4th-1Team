-- Give back one use of a failed request. An expired key is not recreated and the remaining TTL is kept.
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used <= 0 then
    return 0
end
return redis.call('DECR', KEYS[1])
