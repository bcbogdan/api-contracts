import type { MeasuredDecision } from "./types";

const definitions = {
  CONFIGURATION: {
    code: "RATE_LIMIT_CONFIGURATION",
    message: "Invalid rate limit configuration",
    status: 500,
  },
  STORE: {
    code: "RATE_LIMIT_STORE",
    message: "Rate limit storage failure",
    status: 503,
  },
  UNAVAILABLE: {
    code: "RATE_LIMIT_UNAVAILABLE",
    message: "Service Unavailable",
    status: 503,
  },
  EXCEEDED: {
    code: "RATE_LIMIT_EXCEEDED",
    message: "Too many requests",
    status: 429,
  },
} as const;

export type RateLimitErrorType = keyof typeof definitions;
export type RateLimitErrorOptions = {
  cause?: unknown;
  context?: { decision?: MeasuredDecision };
};

export class RateLimitError extends Error {
  readonly name = "RateLimitError";
  readonly code: (typeof definitions)[RateLimitErrorType]["code"];
  readonly httpStatusCode: number;
  readonly context: { decision?: MeasuredDecision };

  constructor(
    readonly type: RateLimitErrorType,
    message?: string,
    options: RateLimitErrorOptions = {},
  ) {
    super(message ?? definitions[type].message, { cause: options.cause });
    this.code = definitions[type].code;
    this.httpStatusCode = definitions[type].status;
    this.context = options.context ?? {};
  }
}

export function rateLimitHttpError(error: unknown):
  | {
      status: number;
      headers: Record<string, string>;
      body: {
        error: true;
        code: string;
        message: string;
        retryAfterSeconds?: number;
      };
    }
  | undefined {
  if (!(error instanceof RateLimitError)) return undefined;
  if (error.type !== "EXCEEDED" && error.type !== "UNAVAILABLE")
    return undefined;
  const retry =
    error.type === "EXCEEDED"
      ? error.context.decision?.retryAfterSeconds
      : undefined;
  const retryAfterSeconds =
    typeof retry === "number" && Number.isFinite(retry) && retry >= 0
      ? Math.ceil(retry)
      : undefined;
  return {
    status: error.httpStatusCode,
    headers:
      retryAfterSeconds === undefined
        ? {}
        : { "Retry-After": String(retryAfterSeconds) },
    body: {
      error: true,
      code: error.code,
      message: definitions[error.type].message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}
