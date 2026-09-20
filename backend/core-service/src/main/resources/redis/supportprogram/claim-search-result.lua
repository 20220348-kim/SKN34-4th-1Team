local ttl = redis.call('PTTL', KEYS[1])
if ttl == -2 or ttl == 0 then
    return nil
end
if ttl < 0 then
    return redis.error_reply('Invalid search result expiry')
end
local payload = redis.call('HGET', KEYS[1], 'payload')
if not payload then
    return redis.error_reply('Missing search result payload')
end
local owner = redis.call('HGET', KEYS[1], 'accountId')
if owner and owner ~= ARGV[1] then
    return nil
end
if not owner then
    redis.call('HSET', KEYS[1], 'accountId', ARGV[1])
end
return payload
