import type { RateLimiter } from "./rate-limiter";
import type { RateLimitDecision, RateLimitPolicy } from "./types";
import { RateLimitError, rateLimitHttpError } from "./errors";

type Response = {
  setHeader(name: string, value: string): unknown;
  status(status: number): Response;
  json(body: unknown): unknown;
};
export function rateLimitMiddleware<Request>(options: {
  limiter: RateLimiter;
  policy:
    | RateLimitPolicy
    | ((request: Request) => RateLimitPolicy | Promise<RateLimitPolicy>);
  subject: (request: Request) => string | Promise<string>;
  onDecision?: (decision: RateLimitDecision, response: Response) => void;
  errorHandling?: "response" | "next";
}) {
  return async (
    request: Request,
    response: Response,
    next: (error?: unknown) => void,
  ) => {
    try {
      const policy =
        typeof options.policy === "function"
          ? await options.policy(request)
          : options.policy;
      const decision = await options.limiter.consume({
        policy,
        subject: await options.subject(request),
      });
      options.onDecision?.(decision, response);
      if (decision.outcome === "denied")
        throw new RateLimitError("EXCEEDED", undefined, {
          context: { decision },
        });
      next();
    } catch (error) {
      if (options.errorHandling === "next") return next(error);
      const http = rateLimitHttpError(error);
      if (!http) return next(error);
      for (const [name, value] of Object.entries(http.headers))
        response.setHeader(name, value);
      response.status(http.status).json(http.body);
    }
  };
}
