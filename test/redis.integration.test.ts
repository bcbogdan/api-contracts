import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/rate-limit/rate-limiter";
import { RedisRateLimitStore } from "../src/rate-limit/stores/redis-rate-limit.store";
import type { RateLimitPolicy } from "../src/rate-limit/types";

describe.runIf(process.env.RUN_REDIS_TESTS === "1")("disposable Redis", () => {
  let server: ChildProcess | undefined;
  let directory: string | undefined;
  let socket: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "api-contracts-"));
    socket = join(directory, "redis.sock");
    server = spawn(
      "redis-server",
      [
        "--port",
        "0",
        "--unixsocket",
        socket,
        "--unixsocketperm",
        "700",
        "--save",
        "",
        "--appendonly",
        "no",
      ],
      { cwd: directory, stdio: "ignore" },
    );
    let startupError: Error | undefined;
    server.on("error", (error) => {
      startupError = error;
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (startupError) throw startupError;
      if (server.exitCode !== null)
        throw new Error("Disposable Redis exited before startup");
      const client = createClient({
        socket: { path: socket, reconnectStrategy: false },
      });
      client.on("error", () => {});
      try {
        await client.connect();
        await client.ping();
        return;
      } catch {
        await delay(20);
      } finally {
        if (client.isOpen) await client.disconnect();
      }
    }
    throw new Error("Disposable Redis did not become ready");
  });

  afterAll(async () => {
    if (server?.pid && server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    if (directory) await rm(directory, { recursive: true });
  });

  it.each(["token-bucket", "sliding-window-log"] as const)(
    "shares atomic %s budgets across clients",
    async (algorithm) => {
      const stores = [
        new RedisRateLimitStore({ socket: { path: socket } }),
        new RedisRateLimitStore({ socket: { path: socket } }),
      ];
      const limiters = stores.map(
        (store) => new RateLimiter({ namespace: algorithm, store }),
      );
      const policy: RateLimitPolicy =
        algorithm === "token-bucket"
          ? {
              id: "books",
              algorithm,
              bucket: {
                capacity: 2,
                refill: { tokens: 1, intervalSeconds: 3600 },
              },
            }
          : {
              id: "books",
              algorithm,
              windows: { quota: { limit: 2, windowSeconds: 3600 } },
            };
      const input = { policy, subject: "alice" };
      try {
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            limiters[index % 2].consume(input),
          ),
        );
        expect(
          results.filter((result) => result.outcome === "allowed"),
        ).toHaveLength(2);
        expect(await limiters[1].inspect(input)).toMatchObject({
          outcome: "denied",
        });
        await limiters[0].reset(policy.id, input.subject, algorithm);
        expect(await limiters[1].consume(input)).toMatchObject({
          outcome: "allowed",
        });
      } finally {
        await Promise.all(stores.map((store) => store.close()));
      }
    },
  );
});
