-- KEYS: one identity key. ARGV: event ID, consume flag, then limit/durationMs pairs.
-- Redis executes all phases atomically. Only an admission records an event.
local key = KEYS[1]
local eventId = ARGV[1]
local consume = ARGV[2] == '1'
local serverTime = redis.call('TIME')
local nowMs = tonumber(serverTime[1]) * 1000 + math.floor(tonumber(serverTime[2]) / 1000)
local longestWindowMs = 0
for argumentIndex = 3, #ARGV, 2 do
  local durationMs = tonumber(ARGV[argumentIndex + 1])
  longestWindowMs = math.max(longestWindowMs, durationMs)
end

-- Prune only expired retained history. Inspection/denial under shorter policies
-- must neither erase older history nor refresh the existing key expiry.
local retentionMs = longestWindowMs
local latestEvent = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
local remainingTtlMs = redis.call('PTTL', key)
if #latestEvent > 0 and remainingTtlMs >= 0 then
  retentionMs = math.max(retentionMs, nowMs + remainingTtlMs - tonumber(latestEvent[2]))
end
redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs - retentionMs)

-- Reply: allowed, server time, TTL, followed by count/reset/retry per window.
-- Window bounds are (now - duration, now]; evaluate every window before writing.
local result = {1, nowMs, 0}
for argumentIndex = 3, #ARGV, 2 do
  local limit = tonumber(ARGV[argumentIndex])
  local durationMs = tonumber(ARGV[argumentIndex + 1])
  local lowerBound = '(' .. (nowMs - durationMs)
  local count = redis.call('ZCOUNT', key, lowerBound, '+inf')
  local retryMs, resetMs = 0, 0
  if count > 0 then
    local firstEvent = redis.call('ZRANGEBYSCORE', key, lowerBound, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
    resetMs = tonumber(firstEvent[2]) + durationMs - nowMs
  end
  if count >= limit then
    result[1] = 0
    -- With lowered limits, several events may need to expire. The limit-th
    -- newest event is the one whose expiry restores capacity, not the oldest.
    local capacityRestoringEvent = redis.call('ZRANGE', key, -limit, -limit, 'WITHSCORES')
    retryMs = tonumber(capacityRestoringEvent[2]) + durationMs - nowMs
  end
  table.insert(result, count)
  table.insert(result, resetMs)
  table.insert(result, retryMs)
end

-- Commit all windows together. Only admission may adopt shorter retention.
if result[1] == 1 and consume then
  redis.call('ZREMRANGEBYSCORE', key, '-inf', nowMs - longestWindowMs)
  redis.call('ZADD', key, nowMs, eventId)
  redis.call('PEXPIRE', key, longestWindowMs)
  local countOffset = 4
  for argumentIndex = 3, #ARGV, 2 do
    local durationMs = tonumber(ARGV[argumentIndex + 1])
    result[countOffset] = result[countOffset] + 1
    if result[countOffset] == 1 then result[countOffset + 1] = durationMs end
    countOffset = countOffset + 3
  end
end
result[3] = redis.call('PTTL', key)
return result
