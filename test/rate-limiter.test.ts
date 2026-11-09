import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/rate-limit/rate-limiter";
import { RateLimitError, rateLimitHttpError } from "../src/rate-limit/errors";
import { MemoryRateLimitStore } from "../src/rate-limit/stores/memory-rate-limit.store";
import { rateLimitMiddleware } from "../src/rate-limit/rate-limit.middleware";
import type { RateLimitPolicy, RateLimitStore } from "../src/rate-limit/types";

const bucket: RateLimitPolicy = {
  id: "books",
  bucket: { capacity: 2, refill: { tokens: 1, intervalSeconds: 10 } },
};
const window: RateLimitPolicy = {
  id: "books",
  algorithm: "sliding-window-log",
  windows: { burst: { limit: 2, windowSeconds: 10 } },
};

describe.each([bucket, window])("rate limiting: $algorithm", (policy) => {
  it("enforces quotas, isolates subjects and namespaces, and resets one identity", async () => {
    const store = new MemoryRateLimitStore(100, () => 1000);
    const first = new RateLimiter({ store, namespace: "one" });
    const second = new RateLimiter({ store, namespace: "two" });
    const input = { policy, subject: "alice" };
    expect(await first.consume(input)).toMatchObject({ outcome: "allowed" });
    expect(await first.consume(input)).toMatchObject({ outcome: "allowed" });
    expect(await first.inspect(input)).toMatchObject({ outcome: "denied" });
    await expect(first.enforce(input)).rejects.toMatchObject({
      type: "EXCEEDED",
    });
    expect(await first.consume({ policy, subject: "bob" })).toMatchObject({
      outcome: "allowed",
    });
    expect(await second.consume(input)).toMatchObject({ outcome: "allowed" });
    await first.reset(policy.id, "alice", policy.algorithm);
    expect(await first.consume(input)).toMatchObject({ outcome: "allowed" });
    await store.close();
  });

  it("recovers capacity over time without consuming on inspection", async () => {
    let now = 1000;
    const limiter = new RateLimiter({
      namespace: "clock",
      store: new MemoryRateLimitStore(100, () => now),
    });
    const input = { policy, subject: "alice" };
    await limiter.inspect(input);
    await limiter.enforce(input);
    await limiter.enforce(input);
    expect(await limiter.consume(input)).toMatchObject({
      outcome: "denied",
      retryAfterSeconds: 10,
    });
    now += 10_000;
    expect(await limiter.consume(input)).toMatchObject({ outcome: "allowed" });
  });

  it("admits at most the available budget under concurrent calls", async () => {
    const limiter = new RateLimiter({
      namespace: "concurrent",
      store: new MemoryRateLimitStore(100, () => 1000),
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.consume({ policy, subject: "alice" }),
      ),
    );
    expect(
      results.filter((result) => result.outcome === "allowed"),
    ).toHaveLength(2);
  });
});

describe("portable error handling", () => {
  function failingStore(error: Error): RateLimitStore {
    return {
      evaluate: async () => {
        throw error;
      },
      reset: async () => {},
      close: async () => {},
    };
  }

  it("fails open only for designated store failures", async () => {
    const limiter = new RateLimiter({
      namespace: "open",
      store: failingStore(new RateLimitError("STORE")),
      failureMode: "open",
    });
    expect(await limiter.consume({ policy: bucket, subject: "alice" })).toEqual(
      { outcome: "bypassed" },
    );
    await expect(
      limiter.consume({ policy: bucket, subject: "" }),
    ).rejects.toMatchObject({ type: "CONFIGURATION" });
    const unexpected = new Error("unexpected");
    const broken = new RateLimiter({
      namespace: "open",
      store: failingStore(unexpected),
      failureMode: "open",
    });
    await expect(
      broken.consume({ policy: bucket, subject: "alice" }),
    ).rejects.toBe(unexpected);
  });

  it("keeps dependency errors out of public responses", async () => {
    const cause = new Error("sensitive dependency detail");
    const limiter = new RateLimiter({
      namespace: "closed",
      store: failingStore(new RateLimitError("STORE", undefined, { cause })),
    });
    try {
      await limiter.enforce({ policy: bucket, subject: "alice" });
      expect.fail("Expected unavailable error");
    } catch (error) {
      expect(rateLimitHttpError(error)).toEqual({
        status: 503,
        headers: {},
        body: {
          error: true,
          code: "RATE_LIMIT_UNAVAILABLE",
          message: "Service Unavailable",
        },
      });
      expect(JSON.stringify(rateLimitHttpError(error))).not.toContain(
        cause.message,
      );
    }
    expect(rateLimitHttpError(new Error("unrelated"))).toBeUndefined();
  });

  it("does not let an observer change admission", async () => {
    const limiter = new RateLimiter({
      namespace: "observe",
      store: new MemoryRateLimitStore(),
      observe: async () => {
        throw new Error("observer failed");
      },
    });
    expect(
      await limiter.consume({ policy: bucket, subject: "alice" }),
    ).toMatchObject({ outcome: "allowed" });
  });

  it("supports Express-compatible middleware without an Express dependency", async () => {
    const limiter = new RateLimiter({
      namespace: "middleware",
      store: new MemoryRateLimitStore(100, () => 1000),
    });
    const middleware = rateLimitMiddleware<{ actor: string }>({
      limiter,
      policy: bucket,
      subject: (request) => request.actor,
    });
    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const next = vi.fn();
    await middleware({ actor: "alice" }, response, next);
    await middleware({ actor: "alice" }, response, next);
    await middleware({ actor: "alice" }, response, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "10");
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "RATE_LIMIT_EXCEEDED" }),
    );
  });
});
