-- Add one use only while the guest is under the daily limit; the first use expires at the next Seoul midnight.
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
    return 0
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
    redis.call('PEXPIREAT', KEYS[1], ARGV[2])
end
return used
