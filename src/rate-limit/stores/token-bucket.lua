local key = KEYS[1]
local consume = ARGV[1] == '1'
local capacity = tonumber(ARGV[2])
local tokens = tonumber(ARGV[3])
local interval = tonumber(ARGV[4])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local stored = redis.call('HMGET', key, 'balance', 'at', 'capacity', 'tokens', 'interval')
local storedBalance = tonumber(stored[1])
local storedAt = tonumber(stored[2])
local storedCapacity = tonumber(stored[3])
local storedRefillTokens = tonumber(stored[4])
local storedRefillInterval = tonumber(stored[5])
local balance = capacity
-- Refill elapsed time under the admitted configuration before applying new capacity.
if storedBalance then
    local elapsedMs = math.max(0, now - storedAt)
    local refilledTokens = elapsedMs * storedRefillTokens / storedRefillInterval
    balance = math.min(storedCapacity, storedBalance + refilledTokens)
end
balance = math.min(capacity, balance)
local allowed = balance >= 1
local ttl = redis.call('PTTL', key)
-- Until admission, use stored refill; expiry restores a full bucket under requested capacity.
local function waitFor(target)
    if not storedBalance or balance >= target then return 0 end
    local wait = math.huge
    if target <= storedCapacity then
        local clockDelayMs = math.max(0, storedAt - now)
        local refillWaitMs = (target - balance) * storedRefillInterval / storedRefillTokens
        wait = clockDelayMs + refillWaitMs
    end
    if ttl >= 0 then wait = math.min(wait, ttl) end
    return math.ceil(wait / 1000)
end
local retry = allowed and 0 or waitFor(1)
local full = waitFor(capacity)
if allowed and consume then
    balance = balance - 1
    redis.call('HSET', key, 'balance', string.format('%.17g', balance), 'at', now, 'capacity', capacity, 'tokens', tokens, 'interval', interval)
    redis.call('PEXPIRE', key, math.ceil((capacity - balance) * interval / tokens))
    full = math.ceil((capacity - balance) * interval / tokens / 1000)
end
return {allowed and 1 or 0, now, redis.call('PTTL', key), string.format('%.17g', balance), retry, full}
