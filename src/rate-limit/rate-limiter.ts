import { SpanStatusCode, trace } from "@opentelemetry/api";
import { RateLimitError } from "./errors";
import type {
  FailureMode,
  RateLimitDecision,
  RateLimiterOptions,
  RateLimitPolicy,
} from "./types";

export function validateFailureMode(mode: FailureMode | undefined) {
  if (mode !== undefined && mode !== "open" && mode !== "closed") {
    throw new RateLimitError("CONFIGURATION", "Invalid failure mode");
  }
}

export function validatePolicy(policy: RateLimitPolicy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy))
    throw new RateLimitError("CONFIGURATION", "Policy required");
  if (typeof policy.id !== "string" || !policy.id.trim())
    throw new RateLimitError("CONFIGURATION", "Policy ID required");
  validateFailureMode(policy.failureMode);
  if (policy.algorithm !== "sliding-window-log") {
    if (policy.algorithm !== undefined && policy.algorithm !== "token-bucket")
      throw new RateLimitError("CONFIGURATION", "Invalid algorithm");
    const bucket = policy.bucket;
    if (
      policy.windows !== undefined ||
      !bucket ||
      !Number.isSafeInteger(bucket.capacity) ||
      bucket.capacity < 1 ||
      bucket.capacity > 1_000_000_000 ||
      !Number.isSafeInteger(bucket.refill?.tokens) ||
      bucket.refill.tokens < 1 ||
      bucket.refill.tokens > 1_000_000_000 ||
      !Number.isFinite(bucket.refill.intervalSeconds) ||
      bucket.refill.intervalSeconds < 0.001 ||
      bucket.refill.intervalSeconds > 4_294_967_295 ||
      (bucket.capacity * bucket.refill.intervalSeconds * 1000) /
        bucket.refill.tokens >
        4_294_967_295_000
    )
      throw new RateLimitError("CONFIGURATION", "Invalid token bucket");
    return;
  }
  if (policy.bucket !== undefined)
    throw new RateLimitError(
      "CONFIGURATION",
      "Incompatible rate limit strategies",
    );
  if (
    !policy.windows ||
    typeof policy.windows !== "object" ||
    Array.isArray(policy.windows)
  )
    throw new RateLimitError("CONFIGURATION", "Invalid rate limit windows");
  const windows = Object.entries(policy.windows ?? {});
  if (!windows.length || windows.length > 32)
    throw new RateLimitError("CONFIGURATION", "Expected 1-32 windows");
  for (const [name, window] of windows) {
    if (
      !name.trim() ||
      !window ||
      typeof window !== "object" ||
      Array.isArray(window) ||
      !Number.isSafeInteger(window.limit) ||
      window.limit < 1 ||
      window.limit > 4_294_967_295 ||
      !Number.isSafeInteger(window.windowSeconds) ||
      window.windowSeconds < 1 ||
      window.windowSeconds > 4_294_967_295 ||
      !Number.isSafeInteger(window.windowSeconds * 1000)
    ) {
      throw new RateLimitError("CONFIGURATION", "Invalid rate limit window");
    }
  }
}

export class RateLimiter {
  private readonly fixedPolicies = new WeakSet<RateLimitPolicy>();

  protected bindPolicy<T extends RateLimitPolicy>(policy: T): T {
    validatePolicy(policy);
    const snapshot = Object.freeze({
      ...policy,
      ...(policy.algorithm === "sliding-window-log"
        ? {
            windows: Object.freeze(
              Object.fromEntries(
                Object.entries(policy.windows ?? {}).map(([name, window]) => [
                  name,
                  Object.freeze({ ...window }),
                ]),
              ),
            ),
          }
        : {
            algorithm: "token-bucket",
            bucket: Object.freeze({
              ...policy.bucket,
              refill: Object.freeze({ ...policy.bucket.refill }),
            }),
          }),
    }) as T;
    validatePolicy(snapshot);
    this.fixedPolicies.add(snapshot);
    return snapshot;
  }

  constructor(readonly options: RateLimiterOptions) {
    if (typeof options.namespace !== "string" || !options.namespace.trim())
      throw new RateLimitError("CONFIGURATION", "Namespace required");
    validateFailureMode(options.failureMode);
    this.options = Object.freeze({ ...options });
  }

  key(
    policyId: string,
    subject: string,
    algorithm: "token-bucket" | "sliding-window-log" = "token-bucket",
  ) {
    if (algorithm !== "token-bucket" && algorithm !== "sliding-window-log")
      throw new RateLimitError("CONFIGURATION", "Invalid algorithm");
    if (
      typeof policyId !== "string" ||
      !policyId.trim() ||
      typeof subject !== "string" ||
      !subject.trim()
    ) {
      throw new RateLimitError(
        "CONFIGURATION",
        "Policy ID and trusted subject required",
      );
    }
    return `rate-limit:${algorithm === "token-bucket" ? "token-bucket:v1:" : ""}${JSON.stringify([this.options.namespace, policyId, subject])}`;
  }

  async consume(input: {
    policy: RateLimitPolicy;
    subject: string;
  }): Promise<RateLimitDecision> {
    return trace
      .getTracer("api-contracts/rate-limit")
      .startActiveSpan("rate_limit.consume", async (span) => {
        try {
          const mode =
            input.policy.failureMode ?? this.options.failureMode ?? "closed";
          if (mode === "open" || mode === "closed")
            span.setAttribute("rate_limit.failure_mode", mode);
          if (typeof input.policy.id === "string" && input.policy.id.trim())
            span.setAttribute("rate_limit.policy_id", input.policy.id);
          // Only immutable startup bindings skip validation; dynamic policies do not.
          if (!this.fixedPolicies.has(input.policy))
            validatePolicy(input.policy);
          const key = this.key(
            input.policy.id,
            input.subject,
            input.policy.algorithm,
          );
          const start = Date.now();
          let decision: RateLimitDecision;
          try {
            decision = await this.options.store.evaluate(
              key,
              input.policy,
              true,
            );
          } catch (error) {
            if (!(error instanceof RateLimitError) || error.type !== "STORE")
              throw error;
            if (mode === "closed") {
              this.recordObservation("unavailable", start);
              throw new RateLimitError("UNAVAILABLE", undefined, {
                cause: error,
              });
            }
            decision = { outcome: "bypassed" };
          }
          this.recordObservation(decision.outcome, start);
          span.setAttribute("rate_limit.outcome", decision.outcome);
          if (decision.outcome === "denied") {
            if (decision.algorithm === "sliding-window-log")
              span.setAttribute(
                "rate_limit.blocking_windows",
                decision.blockingWindows,
              );
            span.setAttribute(
              "rate_limit.retry_after_seconds",
              decision.retryAfterSeconds,
            );
          } else if (decision.outcome === "bypassed") {
            span.setAttribute("error.type", "store");
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: "Rate limit protection bypassed",
            });
          }
          return decision;
        } catch (error) {
          const category =
            error instanceof RateLimitError && error.type === "CONFIGURATION"
              ? "configuration"
              : error instanceof RateLimitError && error.type === "UNAVAILABLE"
                ? "store"
                : "unexpected";
          span.setAttributes({
            "rate_limit.outcome": "unavailable",
            "error.type": category,
          });
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: "Rate limit decision unavailable",
          });
          throw error;
        } finally {
          span.end();
        }
      });
  }

  async enforce(input: { policy: RateLimitPolicy; subject: string }) {
    const decision = await this.consume(input);
    if (decision.outcome === "denied")
      throw new RateLimitError("EXCEEDED", undefined, {
        context: { decision },
      });
    return decision;
  }

  async inspect(input: { policy: RateLimitPolicy; subject: string }) {
    validatePolicy(input.policy);
    const key = this.key(
      input.policy.id,
      input.subject,
      input.policy.algorithm,
    );
    try {
      return await this.options.store.evaluate(key, input.policy, false);
    } catch (error) {
      if (error instanceof RateLimitError && error.type === "STORE")
        throw new RateLimitError("UNAVAILABLE", undefined, { cause: error });
      throw error;
    }
  }

  async reset(
    policyId: string,
    subject: string,
    algorithm: "token-bucket" | "sliding-window-log" = "token-bucket",
  ) {
    const key = this.key(policyId, subject, algorithm);
    try {
      await this.options.store.reset(key);
    } catch (error) {
      if (error instanceof RateLimitError && error.type === "STORE")
        throw new RateLimitError("UNAVAILABLE", undefined, { cause: error });
      throw error;
    }
  }

  private recordObservation(
    outcome: RateLimitDecision["outcome"] | "unavailable",
    start: number,
  ) {
    // Telemetry must not change an already-recorded admission.
    try {
      void Promise.resolve(
        this.options.observe?.({ outcome, durationMs: Date.now() - start }),
      ).catch(() => undefined);
    } catch {}
  }
}
