import "reflect-metadata";
import {
  Controller,
  Injectable,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createContract } from "../src/contract";
import { Implements, Request, type InferRequests } from "../src/server";
import { RateLimitModule } from "../src/rate-limit/nestjs/rate-limit.module";
import { RateLimitService } from "../src/rate-limit/nestjs/rate-limit.service";
import { MemoryRateLimitStore } from "../src/rate-limit/stores/memory-rate-limit.store";
import { RateLimitError } from "../src/rate-limit/errors";

const responses = {
  200: { data: z.object({ title: z.string() }) },
  429: {
    data: z.object({
      error: z.literal(true),
      code: z.literal("RATE_LIMIT_EXCEEDED"),
      message: z.string(),
      retryAfterSeconds: z.number(),
    }),
    headers: z.object({ "retry-after": z.string() }),
  },
  503: {
    data: z.object({
      error: z.literal(true),
      code: z.literal("RATE_LIMIT_UNAVAILABLE"),
      message: z.string(),
    }),
  },
};
const contract = createContract({
  name: "Books",
  basePath: "/books",
  rateLimitSubjects: ["actor"],
  rateLimit: {
    subject: "actor",
    bucket: { capacity: 1, refill: { tokens: 1, intervalSeconds: 60 } },
  },
}).defineRoutes({
  create: {
    method: "POST",
    path: "/",
    body: { schema: z.object({ title: z.string() }) },
    responses,
  },
});

interface ActorRequest {
  headers: Record<string, string | undefined>;
  actorId?: string;
}
@Injectable()
class ActorGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ActorRequest>();
    if (request.headers.authorization !== "test-credential") return false;
    request.actorId = "test-actor";
    return true;
  }
}
const handled = vi.fn();
@Controller("/books")
class BooksController {
  @UseGuards(ActorGuard)
  @Implements(contract.routes.create)
  create(@Request() input: InferRequests<typeof contract>["create"]) {
    handled();
    return { status: 200 as const, data: { title: input.body.title } };
  }
}

describe("NestJS rate limiting", () => {
  it("runs guards before quota admission and charges invalid attempts before parsing", async () => {
    handled.mockClear();
    const store = new MemoryRateLimitStore(100, () => 1000);
    const module = await Test.createTestingModule({
      imports: [
        RateLimitModule.register<ActorRequest, "actor">({
          namespace: "books",
          store,
          subjects: { actor: (request) => request.actorId },
        }),
      ],
      controllers: [BooksController],
      providers: [ActorGuard],
    }).compile();
    const app = module.createNestApplication();
    try {
      await app.listen(0, "127.0.0.1");
      const url = `${await app.getUrl()}/books`;
      const post = (body: unknown, authorized = true) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authorized ? { authorization: "test-credential" } : {}),
          },
          body: JSON.stringify(body),
        });
      expect((await post({ title: "Hello" }, false)).status).toBe(403);
      expect((await post({ title: 42 })).status).toBe(400);
      const denied = await post({ title: "Hello" });
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).toBe("60");
      expect(await denied.json()).toMatchObject({
        code: "RATE_LIMIT_EXCEEDED",
        retryAfterSeconds: 60,
      });
      expect(handled).not.toHaveBeenCalled();
      const service = app.get(RateLimitService);
      await service.reset("POST /books", "test-actor");
      expect((await post({ title: "Hello" })).status).toBe(200);
      expect(handled).toHaveBeenCalledTimes(1);
      vi.spyOn(store, "evaluate").mockRejectedValue(
        new RateLimitError("STORE", "dependency failure"),
      );
      const unavailable = await post({ title: "Hello" });
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({
        error: true,
        code: "RATE_LIMIT_UNAVAILABLE",
        message: "Service Unavailable",
      });
    } finally {
      await app.close();
    }
  });

  it("requires compatible error schemas at startup", () => {
    const service = new RateLimitService({
      namespace: "validation",
      store: new MemoryRateLimitStore(),
      subjects: { actor: () => "alice" },
    });
    expect(() =>
      service.validateRoute({
        policy: {
          id: "books",
          subject: "actor",
          algorithm: "token-bucket",
          bucket: { capacity: 1, refill: { tokens: 1, intervalSeconds: 1 } },
        },
        responses: [200],
      }),
    ).toThrow("must declare 429");
  });
});
