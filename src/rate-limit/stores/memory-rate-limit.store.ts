import { RateLimitError } from "../errors";
import type {
  MeasuredDecision,
  RateLimitStore,
  RateLimitStrategy,
  TokenBucket,
  WindowMeasurement,
} from "../types";

/** Explicit test/local storage. Active identities are never evicted to admit traffic. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<
    string,
    { events: number[]; expiresAt: number }
  >();
  private readonly tokens = new Map<
    string,
    { balance: number; at: number; config: TokenBucket; expiresAt: number }
  >();
  constructor(
    private readonly capacity = 10_000,
    private readonly now = Date.now,
    private readonly eventCapacity = 100_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RateLimitError("CONFIGURATION", "Invalid memory capacity");
    if (!Number.isSafeInteger(eventCapacity) || eventCapacity < 1)
      throw new RateLimitError(
        "CONFIGURATION",
        "Invalid memory event capacity",
      );
  }

  async evaluate(
    key: string,
    strategy: RateLimitStrategy,
    consume: boolean,
  ): Promise<MeasuredDecision> {
    const now = this.now();
    for (const [identity, bucket] of this.tokens)
      if (bucket.expiresAt <= now) this.tokens.delete(identity);
    let eventCount = 0;
    for (const [identity, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(identity);
      else eventCount += bucket.events.length;
    }
    if (strategy.algorithm !== "sliding-window-log") {
      const config = strategy.bucket;
      const existing = this.tokens.get(key);
      // Policy changes affect future refill only after an admission persists them.
      let balance = existing
        ? Math.min(
            existing.config.capacity,
            existing.balance +
              (Math.max(0, now - existing.at) * existing.config.refill.tokens) /
                (existing.config.refill.intervalSeconds * 1000),
          )
        : config.capacity;
      balance = Math.min(config.capacity, balance);
      const allowed = balance >= 1;
      // Until admission changes configuration, only stored refill or key expiry can restore capacity.
      const waitFor = (target: number) => {
        if (!existing || balance >= target) return 0;
        const refillMs =
          target > existing.config.capacity
            ? Infinity
            : Math.max(0, existing.at - now) +
              ((target - balance) *
                existing.config.refill.intervalSeconds *
                1000) /
                existing.config.refill.tokens;
        return Math.ceil(Math.min(refillMs, existing.expiresAt - now) / 1000);
      };
      const retry = allowed ? 0 : waitFor(1);
      let fullAfterSeconds = waitFor(config.capacity);
      if (allowed && consume) {
        if (!existing && this.tokens.size + this.buckets.size >= this.capacity)
          throw new RateLimitError("STORE", undefined, {
            cause: "Memory rate limit capacity exhausted",
          });
        balance--;
        fullAfterSeconds = Math.ceil(
          ((config.capacity - balance) * config.refill.intervalSeconds) /
            config.refill.tokens,
        );
        this.tokens.set(key, {
          balance,
          at: now,
          config: { ...config, refill: { ...config.refill } },
          expiresAt:
            now +
            Math.ceil(
              ((config.capacity - balance) *
                config.refill.intervalSeconds *
                1000) /
                config.refill.tokens,
            ),
        });
      }
      return {
        algorithm: "token-bucket",
        outcome: allowed ? "allowed" : "denied",
        bucket: {
          capacity: config.capacity,
          availableTokens: balance,
          remaining: Math.floor(balance),
          fullAfterSeconds,
        },
        retryAfterSeconds: retry,
        measuredAtMs: now,
        ttlSeconds: this.tokens.has(key)
          ? Math.ceil((this.tokens.get(key)!.expiresAt - now) / 1000)
          : null,
      };
    }
    const windows = strategy.windows;
    const existing = this.buckets.get(key);
    const longest = Math.max(
      ...Object.values(windows).map((window) => window.windowSeconds * 1000),
    );
    const retention = Math.max(
      longest,
      existing
        ? existing.expiresAt - existing.events[existing.events.length - 1]
        : 0,
    );
    const events = (existing?.events ?? []).filter(
      (time) => time > now - retention,
    );
    const measurements = Object.create(null) as Record<
      string,
      WindowMeasurement
    >;
    const blockingWindows: string[] = [];
    for (const [name, window] of Object.entries(windows)) {
      const active = events.filter(
        (time) => time > now - window.windowSeconds * 1000,
      );
      const retry =
        active.length >= window.limit
          ? Math.ceil(
              (active[active.length - window.limit] +
                window.windowSeconds * 1000 -
                now) /
                1000,
            )
          : 0;
      if (retry) blockingWindows.push(name);
      measurements[name] = {
        limit: window.limit,
        count: active.length,
        remaining: Math.max(0, window.limit - active.length),
        resetAfterSeconds: active.length
          ? Math.ceil((active[0] + window.windowSeconds * 1000 - now) / 1000)
          : 0,
        retryAfterSeconds: retry,
      };
    }
    const allowed = !blockingWindows.length;
    if (allowed && consume) {
      const admittedEvents = events.filter((time) => time > now - longest);
      if (!existing && this.buckets.size + this.tokens.size >= this.capacity)
        throw new RateLimitError("STORE", undefined, {
          cause: "Memory rate limit capacity exhausted",
        });
      if (
        eventCount - (existing?.events.length ?? 0) + admittedEvents.length >=
        this.eventCapacity
      )
        throw new RateLimitError("STORE", undefined, {
          cause: "Memory rate limit event capacity exhausted",
        });
      admittedEvents.push(now);
      this.buckets.set(key, {
        events: admittedEvents,
        expiresAt: now + longest,
      });
      for (const [name, measurement] of Object.entries(measurements)) {
        measurement.count++;
        measurement.remaining = Math.max(
          0,
          measurement.limit - measurement.count,
        );
        if (measurement.count === 1)
          measurement.resetAfterSeconds = windows[name].windowSeconds;
      }
    } else if (existing) {
      existing.events = events;
    }
    return {
      algorithm: "sliding-window-log",
      outcome: allowed ? "allowed" : "denied",
      windows: measurements,
      blockingWindows,
      retryAfterSeconds: Math.max(
        0,
        ...Object.values(measurements).map(
          (window) => window.retryAfterSeconds,
        ),
      ),
      measuredAtMs: now,
      ttlSeconds: this.buckets.has(key)
        ? Math.max(
            0,
            Math.ceil((this.buckets.get(key)!.expiresAt - now) / 1000),
          )
        : null,
    };
  }
  async reset(key: string) {
    this.buckets.delete(key);
    this.tokens.delete(key);
  }
  async close() {
    this.buckets.clear();
    this.tokens.clear();
  }
}
