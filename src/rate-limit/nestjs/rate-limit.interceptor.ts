import {
  HttpException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { RATE_LIMIT_METADATA } from "../rate-limit.constants";
import type { RouteRateLimitMetadata } from "../types";
import { RateLimitService } from "./rate-limit.service";
import { RateLimitError, rateLimitHttpError } from "../errors";
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    @Inject(RateLimitService) private readonly service: RateLimitService | null,
  ) {}
  async intercept(context: ExecutionContext, next: CallHandler) {
    const metadata = Reflect.getMetadata(
      RATE_LIMIT_METADATA,
      context.getHandler(),
    ) as RouteRateLimitMetadata | undefined;
    if (metadata) {
      try {
        if (!this.service)
          throw new RateLimitError("UNAVAILABLE", undefined, {
            cause: "Rate limiter is not configured",
          });
        await this.service.enforceRoute(
          metadata,
          context.switchToHttp().getRequest<unknown>(),
        );
      } catch (error) {
        const http = rateLimitHttpError(error);
        if (!http) throw error;
        const response = context
          .switchToHttp()
          .getResponse<{ setHeader(name: string, value: string): void }>();
        for (const [name, value] of Object.entries(http.headers))
          response.setHeader(name, value);
        throw new HttpException(http.body, http.status);
      }
    }
    return next.handle();
  }
}
