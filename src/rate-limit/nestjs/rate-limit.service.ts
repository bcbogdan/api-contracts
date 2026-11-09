import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { RateLimiter } from "../rate-limiter";
import { RateLimitError, rateLimitHttpError } from "../errors";
import { RATE_LIMIT_OPTIONS } from "../rate-limit.constants";
import type {
  RateLimitMetadata,
  RouteRateLimitMetadata,
  ComposedRateLimitMetadata,
  ResolvedRouteRateLimit,
  RateLimiterOptions,
  RateLimitDecision,
} from "../types";

export type RateLimitModuleOptions<
  Request,
  Subject extends string,
> = RateLimiterOptions & {
  subjects: Record<
    Subject,
    (request: Request) => string | undefined | Promise<string | undefined>
  >;
};

@Injectable()
export class RateLimitService extends RateLimiter implements OnModuleDestroy {
  private readonly bindings = new WeakMap<
    RouteRateLimitMetadata,
    {
      metadata: RouteRateLimitMetadata;
      policies: readonly {
        policy: ResolvedRouteRateLimit;
        resolve: RateLimitModuleOptions<unknown, string>["subjects"][string];
      }[];
    }
  >();
  constructor(
    @Inject(RATE_LIMIT_OPTIONS)
    readonly moduleOptions: RateLimitModuleOptions<unknown, string>,
  ) {
    super(moduleOptions);
  }

  validateRoute(metadata: RateLimitMetadata): RateLimitMetadata;
  validateRoute(metadata: ComposedRateLimitMetadata): ComposedRateLimitMetadata;
  validateRoute(metadata: RouteRateLimitMetadata): RouteRateLimitMetadata;
  validateRoute(metadata: RouteRateLimitMetadata): RouteRateLimitMetadata {
    const existing = this.bindings.get(metadata);
    if (existing) return existing.metadata;
    const responses = Object.freeze([...metadata.responses]);
    const ids = new Set<string>();
    const policies = (
      "policy" in metadata ? [metadata.policy] : metadata.policies
    ).map((entry) => {
      const policy = this.bindPolicy(entry);
      if (ids.has(policy.id))
        throw new RateLimitError(
          "CONFIGURATION",
          `Duplicate effective policy ID: ${policy.id}`,
        );
      ids.add(policy.id);
      if (
        !Object.prototype.hasOwnProperty.call(
          this.moduleOptions.subjects,
          policy.subject,
        ) ||
        typeof this.moduleOptions.subjects[policy.subject] !== "function"
      ) {
        throw new RateLimitError(
          "CONFIGURATION",
          `Unknown rate limit subject: ${policy.subject}`,
        );
      }
      if (
        !responses.includes(429) ||
        ((policy.failureMode ?? this.options.failureMode ?? "closed") ===
          "closed" &&
          !responses.includes(503))
      ) {
        throw new RateLimitError(
          "CONFIGURATION",
          `Rate limited route ${policy.id} must declare 429 and, when closed, 503`,
        );
      }
      if (metadata.validateErrorResponse) {
        const errors = [
          new RateLimitError("EXCEEDED", undefined, {
            context: {
              decision: {
                ...(policy.algorithm === "sliding-window-log"
                  ? {
                      algorithm: "sliding-window-log" as const,
                      windows: {},
                      blockingWindows: [],
                    }
                  : {
                      algorithm: "token-bucket" as const,
                      bucket: {
                        capacity: policy.bucket.capacity,
                        availableTokens: 0,
                        remaining: 0,
                        fullAfterSeconds: 1,
                      },
                    }),
                outcome: "denied",
                retryAfterSeconds: 1,
                measuredAtMs: 0,
                ttlSeconds: null,
              },
            },
          }),
          ...((policy.failureMode ?? this.options.failureMode ?? "closed") ===
          "closed"
            ? [new RateLimitError("UNAVAILABLE")]
            : []),
        ];
        for (const error of errors) {
          const http = rateLimitHttpError(error)!;
          if (
            !metadata.validateErrorResponse(
              http.status,
              http.body,
              http.headers,
            )
          )
            throw new RateLimitError(
              "CONFIGURATION",
              `Incompatible rate limit error schemas for ${policy.id}`,
            );
        }
      }
      return Object.freeze({
        policy,
        resolve: this.moduleOptions.subjects[policy.subject],
      });
    });
    const snapshot = Object.freeze(
      "policy" in metadata
        ? { policy: policies[0]!.policy, responses }
        : {
            policies: Object.freeze(policies.map(({ policy }) => policy)),
            responses,
          },
    );
    this.bindings.set(metadata, {
      metadata: snapshot,
      policies: Object.freeze(policies),
    });
    return snapshot;
  }

  async enforceRoute(
    metadata: RateLimitMetadata,
    request: unknown,
  ): Promise<RateLimitDecision>;
  async enforceRoute(
    metadata: ComposedRateLimitMetadata,
    request: unknown,
  ): Promise<void>;
  async enforceRoute(
    metadata: RouteRateLimitMetadata,
    request: unknown,
  ): Promise<RateLimitDecision | void>;
  async enforceRoute(
    metadata: RouteRateLimitMetadata,
    request: unknown,
  ): Promise<RateLimitDecision | void> {
    this.validateRoute(metadata);
    const binding = this.bindings.get(metadata)!;
    // A later identity failure must not spend an earlier quota.
    const subjects = new Map<
      RateLimitModuleOptions<unknown, string>["subjects"][string],
      string
    >();
    for (const { resolve } of binding.policies) {
      if (subjects.has(resolve)) continue;
      const subject = await resolve(request);
      if (typeof subject !== "string" || !subject.trim())
        throw new RateLimitError(
          "CONFIGURATION",
          "Trusted rate limit subject missing",
        );
      subjects.set(resolve, subject);
    }
    let decision;
    for (const { policy, resolve } of binding.policies) {
      decision = await this.enforce({
        policy,
        subject: subjects.get(resolve)!,
      });
    }
    if ("policy" in metadata) return decision;
  }

  async onModuleDestroy() {
    await this.options.store.close();
  }
}
