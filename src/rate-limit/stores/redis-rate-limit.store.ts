import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient, type RedisClientOptions } from "redis";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { RateLimitError } from "../errors";
import type {
  MeasuredDecision,
  RateLimitStore,
  RateLimitStrategy,
  WindowMeasurement,
} from "../types";

// CommonJS source and compiled package both keep the asset beside this module.
const SCRIPT = readFileSync(join(__dirname, "sliding-window.lua"), "utf8");
const TOKEN_SCRIPT = readFileSync(join(__dirname, "token-bucket.lua"), "utf8");

export class RedisRateLimitStore implements RateLimitStore {
  private client?: ReturnType<typeof createClient>;
  private connecting?: Promise<void>;
  private closed = false;
  constructor(
    private readonly config: RedisClientOptions,
    private readonly timeoutMs = 1000,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new RateLimitError("CONFIGURATION", "Invalid Redis deadline");
  }

  private async run<T>(
    action: "eval" | "inspect" | "reset",
    command: (client: ReturnType<typeof createClient>) => Promise<T>,
  ): Promise<T> {
    return trace.getTracer("api-contracts/rate-limit").startActiveSpan(
      "rate_limit.redis",
      {
        kind: SpanKind.CLIENT,
        attributes: { "rate_limit.redis.action": action },
      },
      async (span) => {
        const acquisitionStart = performance.now();
        let acquisitionMs: number | undefined;
        span.setAttribute(
          "rate_limit.redis.connection_required",
          !this.client?.isReady,
        );
        try {
          if (this.closed)
            throw new RateLimitError("STORE", undefined, {
              cause: "Redis rate limit store closed",
            });
          if (!this.client) {
            this.client = createClient({
              ...this.config,
              disableOfflineQueue: true,
              socket: {
                ...this.config.socket,
                connectTimeout: this.timeoutMs,
                reconnectStrategy: false,
              },
            });
            // Command promises report storage errors to the engine.
            this.client.on("error", () => {});
          }
          const client = this.client;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              (async () => {
                if (!client.isReady) {
                  this.connecting ??= client.connect().then(() => undefined);
                  await this.connecting;
                }
                if (this.client !== client || this.closed)
                  throw new Error("Redis connection cancelled");
                acquisitionMs = performance.now() - acquisitionStart;
                return command(client);
              })(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Redis rate limit deadline exceeded")),
                  this.timeoutMs,
                );
              }),
            ]);
          } catch (error) {
            if (this.client === client) {
              this.client = undefined;
              this.connecting = undefined;
              if (client.isOpen)
                await client.disconnect().catch(() => undefined);
            }
            throw new RateLimitError("STORE", undefined, { cause: error });
          } finally {
            if (timer) clearTimeout(timer);
          }
        } catch (error) {
          span.setAttribute(
            "error.type",
            error instanceof RateLimitError && error.type === "STORE"
              ? "store"
              : "unexpected",
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Rate limit Redis operation failed",
          });
          throw error;
        } finally {
          span.setAttribute(
            "rate_limit.redis.acquisition_ms",
            acquisitionMs ?? performance.now() - acquisitionStart,
          );
          span.end();
        }
      },
    );
  }

  async evaluate(
    key: string,
    strategy: RateLimitStrategy,
    consume: boolean,
  ): Promise<MeasuredDecision> {
    if (strategy.algorithm !== "sliding-window-log") {
      const { capacity, refill } = strategy.bucket;
      const result: unknown = await this.run(
        consume ? "eval" : "inspect",
        (client) =>
          client.eval(TOKEN_SCRIPT, {
            keys: [key],
            arguments: [
              consume ? "1" : "0",
              String(capacity),
              String(refill.tokens),
              String(refill.intervalSeconds * 1000),
            ],
          }),
      );
      if (
        !Array.isArray(result) ||
        result.length !== 6 ||
        result.some((value: unknown, index: number) =>
          index === 3
            ? typeof value !== "string" ||
              !value.trim() ||
              !Number.isFinite(Number(value))
            : typeof value !== "number" || !Number.isSafeInteger(value),
        )
      )
        throw new RateLimitError("STORE", undefined, {
          cause: "Malformed Redis token bucket result",
        });
      const [allowed, now, ttl, balance, retry, full] = result.map(Number);
      if (
        (allowed !== 0 && allowed !== 1) ||
        balance < 0 ||
        balance > capacity ||
        now < 0 ||
        ttl < -2 ||
        retry < 0 ||
        full < 0 ||
        (allowed === 1 && retry !== 0) ||
        (allowed === 0 && (retry < 1 || balance >= 1))
      )
        throw new RateLimitError("STORE", undefined, {
          cause: "Invalid Redis token bucket measurements",
        });
      return {
        algorithm: "token-bucket",
        outcome: allowed ? "allowed" : "denied",
        bucket: {
          capacity,
          availableTokens: balance,
          remaining: Math.floor(balance),
          fullAfterSeconds: full,
        },
        retryAfterSeconds: retry,
        measuredAtMs: now,
        ttlSeconds: ttl < 0 ? null : Math.ceil(ttl / 1000),
      };
    }
    const windows = strategy.windows;
    const entries = Object.entries(windows);
    const result: unknown = await this.run(
      consume ? "eval" : "inspect",
      (client) =>
        client.eval(SCRIPT, {
          keys: [key],
          arguments: [
            randomUUID(),
            consume ? "1" : "0",
            ...entries.flatMap(([, window]) => [
              String(window.limit),
              String(window.windowSeconds * 1000),
            ]),
          ],
        }),
    );
    if (
      !Array.isArray(result) ||
      result.length !== 3 + entries.length * 3 ||
      !result.every(
        (value: unknown) =>
          typeof value === "number" && Number.isSafeInteger(value),
      ) ||
      (result[0] !== 0 && result[0] !== 1) ||
      result[1] < 0 ||
      result[2] < -2
    ) {
      throw new RateLimitError("STORE", undefined, {
        cause: "Malformed Redis rate limit result",
      });
    }
    const values = result as number[];
    const measurements = Object.create(null) as Record<
      string,
      WindowMeasurement
    >;
    const blockingWindows: string[] = [];
    entries.forEach(([name, window], i) => {
      const [count, reset, retry] = values.slice(3 + i * 3, 6 + i * 3);
      if (count < 0 || reset < 0 || retry < 0)
        throw new RateLimitError("STORE", undefined, {
          cause: "Invalid Redis measurements",
        });
      if (retry > 0) blockingWindows.push(name);
      measurements[name] = {
        limit: window.limit,
        count,
        remaining: Math.max(0, window.limit - count),
        resetAfterSeconds: Math.ceil(reset / 1000),
        retryAfterSeconds: Math.ceil(retry / 1000),
      };
    });
    if ((values[0] === 0) !== blockingWindows.length > 0)
      throw new RateLimitError("STORE", undefined, {
        cause: "Inconsistent Redis decision",
      });
    return {
      algorithm: "sliding-window-log",
      outcome: values[0] === 1 ? "allowed" : "denied",
      windows: measurements,
      blockingWindows,
      retryAfterSeconds: Math.max(
        0,
        ...Object.values(measurements).map(
          (window) => window.retryAfterSeconds,
        ),
      ),
      measuredAtMs: values[1],
      ttlSeconds: values[2] < 0 ? null : Math.ceil(values[2] / 1000),
    };
  }

  async reset(key: string) {
    await this.run("reset", (client) => client.del(key));
  }
  async close() {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    if (client?.isOpen) await client.disconnect().catch(() => undefined);
  }
}
