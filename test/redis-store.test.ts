import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisRateLimitStore } from "../src/rate-limit/stores/redis-rate-limit.store";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("redis", () => ({ createClient: mocks.createClient }));
afterEach(() => vi.clearAllMocks());

function fakeClient() {
  const client = {
    isOpen: false,
    isReady: false,
    on: vi.fn(),
    connect: vi.fn(async () => {
      client.isOpen = true;
      client.isReady = true;
    }),
    disconnect: vi.fn(async () => {
      client.isOpen = false;
      client.isReady = false;
    }),
    eval: vi.fn(async (): Promise<unknown> => [1, 1000, 1000, "1", 0, 1000]),
    del: vi.fn(async () => 1),
  };
  mocks.createClient.mockReturnValue(client);
  return client;
}
const bucket = {
  bucket: { capacity: 2, refill: { tokens: 1, intervalSeconds: 1 } },
};

describe("Redis storage adapter", () => {
  it("connects lazily and loads bundled Lua scripts", async () => {
    const client = fakeClient();
    const store = new RedisRateLimitStore({});
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(await store.evaluate("books", bucket, true)).toMatchObject({
      algorithm: "token-bucket",
      outcome: "allowed",
      bucket: { remaining: 1 },
    });
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call"),
      { keys: ["books"], arguments: ["1", "2", "1", "1000"] },
    );
    await store.close();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  it("treats malformed measurements as designated storage failures", async () => {
    const client = fakeClient();
    client.eval.mockResolvedValue([1, 1000, 1000, "not-a-number", 0, 1000]);
    const store = new RedisRateLimitStore({});
    try {
      await expect(store.evaluate("books", bucket, true)).rejects.toMatchObject(
        { type: "STORE" },
      );
    } finally {
      await store.close();
    }
  });

  it("bounds acquisition time and rejects use after close", async () => {
    const client = fakeClient();
    client.connect.mockImplementation(() => new Promise(() => {}));
    const store = new RedisRateLimitStore({}, 10);
    await expect(store.evaluate("books", bucket, true)).rejects.toMatchObject({
      type: "STORE",
    });
    await store.close();
    await expect(store.evaluate("books", bucket, true)).rejects.toMatchObject({
      type: "STORE",
    });
  });
});
