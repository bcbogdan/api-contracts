// Storage failures bypass admission checks when open, or reject as unavailable when closed.
// Invalid configuration and missing trusted identities never fail open.
export type FailureMode = "open" | "closed";
export type RateLimitWindows = Readonly<
  Record<string, Readonly<{ limit: number; windowSeconds: number }>>
>;
export type TokenBucket = Readonly<{
  capacity: number;
  refill: Readonly<{ tokens: number; intervalSeconds: number }>;
}>;
export type RateLimitStrategy =
  | {
      readonly algorithm?: "token-bucket";
      readonly bucket: TokenBucket;
      readonly windows?: never;
    }
  | {
      readonly algorithm: "sliding-window-log";
      readonly windows: RateLimitWindows;
      readonly bucket?: never;
    };
export type ResolvedRateLimitStrategy = RateLimitStrategy & {
  readonly algorithm: "token-bucket" | "sliding-window-log";
};
export type RateLimitDefaults<Subject extends string = string> =
  RateLimitStrategy &
    Readonly<{
      subject: Subject;
      failureMode?: FailureMode;
      policies?: never;
    }>;
export type RouteRateLimit<Subject extends string = string> = (
  RateLimitStrategy | { algorithm?: never; bucket?: never; windows?: never }
) & {
  readonly subject?: Subject;
  readonly failureMode?: FailureMode;
  readonly id?: string;
  readonly policies?: never;
};
type NamedRateLimitFields = {
  readonly subject?: never;
  readonly id?: never;
  readonly algorithm?: never;
  readonly bucket?: never;
  readonly windows?: never;
  readonly failureMode?: never;
};
export type NamedRateLimitDefaults<Subject extends string = string> =
  NamedRateLimitFields & {
    readonly policies: Readonly<
      Record<string, RateLimitDefaults<Subject> & { readonly id?: string }>
    >;
  };
export type NamedRouteRateLimit<Subject extends string = string> =
  NamedRateLimitFields & {
    readonly policies: Readonly<
      Record<string, RouteRateLimit<Subject> | false>
    >;
  };
export type ResolvedNamedRateLimit<Subject extends string = string> =
  ResolvedRouteRateLimit<Subject> & {
    readonly name: string;
  };
export type RateLimitPolicy = RateLimitStrategy &
  Readonly<{
    id: string;
    failureMode?: FailureMode;
  }>;
export type ResolvedRouteRateLimit<Subject extends string = string> =
  RateLimitDefaults<Subject> &
    ResolvedRateLimitStrategy & {
      readonly id: string;
    };
export type RateLimitMetadata<Subject extends string = string> = Readonly<{
  policy: ResolvedRouteRateLimit<Subject>;
  responses: readonly number[];
  validateErrorResponse?: (
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ) => boolean;
}>;
export type ComposedRateLimitMetadata<Subject extends string = string> = Omit<
  RateLimitMetadata<Subject>,
  "policy"
> & {
  readonly policies: readonly ResolvedRouteRateLimit<Subject>[];
};
export type RouteRateLimitMetadata =
  RateLimitMetadata | ComposedRateLimitMetadata;
export type WindowMeasurement = {
  limit: number;
  count: number;
  remaining: number;
  resetAfterSeconds: number;
  retryAfterSeconds: number;
};
type Measurement = {
  outcome: "allowed" | "denied";
  retryAfterSeconds: number;
  measuredAtMs: number;
  ttlSeconds: number | null;
};
export type MeasuredDecision = Measurement &
  (
    | {
        algorithm: "sliding-window-log";
        windows: Record<string, WindowMeasurement>;
        blockingWindows: string[];
      }
    | {
        algorithm: "token-bucket";
        bucket: {
          capacity: number;
          availableTokens: number;
          remaining: number;
          fullAfterSeconds: number;
        };
      }
  );
// A storage failure under fail-open has no measured quota or invented remaining capacity.
export type RateLimitDecision = MeasuredDecision | { outcome: "bypassed" };
export interface RateLimitStore {
  evaluate(
    key: string,
    strategy: RateLimitStrategy,
    consume: boolean,
  ): Promise<MeasuredDecision>;
  reset(key: string): Promise<void>;
  close(): Promise<void>;
}
export type RateLimitObservation = {
  outcome: RateLimitDecision["outcome"] | "unavailable";
  durationMs: number;
};
export type RateLimiterOptions = {
  namespace: string;
  store: RateLimitStore;
  failureMode?: FailureMode;
  // Optional best-effort metrics/logging, not an event bus. Never awaited by admission.
  observe?: (observation: RateLimitObservation) => void | Promise<void>;
};
