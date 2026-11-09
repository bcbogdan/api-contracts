# api-contracts

Define HTTP contracts once. Infer request and response types, validate with Zod, and call them with a typed fetch client.

The contract builder and client are browser-safe and framework-independent. NestJS integration and rate limiting are opt-in. No built-in application routes, authentication provider, subject vocabulary, database, or deployment configuration.

## Status

Early standalone library. Available as source on GitHub; not published to npm. Node.js 22+ for server code; modern browsers or a compatible fetch implementation for clients. Development uses Bun 1.4.4.

```sh
git clone https://github.com/bcbogdan/api-contracts.git
cd api-contracts
bun install
bun run build
bun run test
```

The package name is `@bcbogdan/api-contracts`. The root export has no NestJS or Redis runtime dependency.

## Define a contract

```ts
import { z } from "zod";
import { createContract } from "@bcbogdan/api-contracts";

export const books = createContract({
  name: "Books",
  basePath: "/books",
  defaultResponses: {
    500: { data: z.object({ message: z.string() }) },
  },
}).defineRoutes({
  get: {
    method: "GET",
    path: "/:id",
    params: z.object({ id: z.string() }),
    responses: {
      200: { data: z.object({ id: z.string(), title: z.string() }) },
      404: { data: z.object({ message: z.string() }) },
    },
  },
});
```

Default responses are opt-in. Route responses replace an entire default at the same status. Only declared status codes are recognized; defaults do not install an exception handler.

## Call from any fetch-capable runtime

```ts
import { createClient } from "@bcbogdan/api-contracts/client";
import { books } from "./books.contract";

const client = createClient(books, { baseUrl: "https://example.com" });
const response = await client.get({ params: { id: "123" } });
if (response.status === 200) {
  console.log(response.body.title);
}
```

An optional `fetch` option supplies your own implementation, including authentication headers. Declared errors are typed responses, not thrown exceptions. Unexpected statuses and invalid payloads throw by default. Input validation defaults to enabled. Query serialization uses `URLSearchParams`; nested query objects are not supported.

## Optional NestJS adapter

Install the optional peers when using this adapter:

```sh
bun add @nestjs/common@^11 @nestjs/core@^11 reflect-metadata rxjs
```

Enable `experimentalDecorators` and `emitDecoratorMetadata` in your TypeScript configuration and import `reflect-metadata` at server startup.

```ts
import { Controller } from "@nestjs/common";
import {
  Implements,
  Request,
  type InferRequests,
} from "@bcbogdan/api-contracts/nestjs";
import { books } from "./books.contract";

@Controller("/books")
export class BooksController {
  @Implements(books.routes.get, { validateResponse: true })
  get(@Request() request: InferRequests<typeof books>["get"]) {
    return {
      status: 200 as const,
      data: { id: request.params.id, title: "Example" },
    };
  }
}
```

Register the controller in your module. Server handlers return `{ status, data }`; clients receive `{ status, body }`. Response validation is opt-in. Scope and auth declarations are metadata only: applications must enforce authentication and authorization with their own guards.

## Framework-independent rate limiting

```ts
import { RateLimiter } from "@bcbogdan/api-contracts/rate-limit/rate-limiter";
import { MemoryRateLimitStore } from "@bcbogdan/api-contracts/rate-limit/stores/memory-rate-limit.store";

const limiter = new RateLimiter({
  namespace: "example",
  store: new MemoryRateLimitStore(),
  failureMode: "closed",
});

await limiter.enforce({
  policy: {
    id: "create-book",
    bucket: { capacity: 20, refill: { tokens: 5, intervalSeconds: 1 } },
  },
  subject: "trusted-actor-id",
});
```

- Token buckets are the default. Use `algorithm: "sliding-window-log"` with `windows: { quota: { limit: 10, windowSeconds: 60 } }` for a strict rolling quota.
- `consume` returns a decision; `enforce` throws `RateLimitError` when denied. `inspect` does not spend capacity; `reset` targets one policy/subject/algorithm.
- Memory storage is bounded and intended for local development and tests. It is not a distributed production store or an automatic fallback.
- Authenticate before resolving a subject. Never trust an unverified client-supplied identity. Namespace, policy ID, and subject must be stable across replicas.
- Closed storage failures reject with an unavailable error. Open storage failures return `outcome: "bypassed"`. Invalid configuration and missing identities never fail open.
- `rateLimitMiddleware` from `@bcbogdan/api-contracts/rate-limit/rate-limit.middleware` accepts Express-compatible request/response objects without importing Express. Supply `limiter`, `policy`, and a trusted `subject` resolver.
- A custom store implements `RateLimitStore` from `@bcbogdan/api-contracts/rate-limit/types`. Its `evaluate` operation must atomically evaluate and optionally consume capacity for one key. It must wrap storage failures in `RateLimitError("STORE", undefined, { cause })`.

### Redis storage

```sh
bun add redis@^4.7
```

```ts
import { RedisRateLimitStore } from "@bcbogdan/api-contracts/rate-limit/stores/redis-rate-limit.store";

const store = new RedisRateLimitStore({ url: process.env.REDIS_URL });
```

Pass the store to `RateLimiter` or the NestJS module. Redis operations use bundled Lua scripts for per-key atomic admission. Connections are lazy and bounded by a configurable deadline (1,000 ms by default). Call `store.close()` during shutdown; the NestJS module handles its registered store lifecycle.

### Contract-driven NestJS admission

```ts
import { z } from "zod";
import { createContract } from "@bcbogdan/api-contracts";
import { RateLimitModule } from "@bcbogdan/api-contracts/rate-limit/nestjs/rate-limit.module";
import { RedisRateLimitStore } from "@bcbogdan/api-contracts/rate-limit/stores/redis-rate-limit.store";

const subjects = ["actor"] as const;
type Subject = (typeof subjects)[number];
type AuthenticatedRequest = { actorId?: string };

export const writes = createContract({
  name: "Writes",
  basePath: "/writes",
  rateLimitSubjects: subjects,
  rateLimit: {
    subject: "actor",
    bucket: { capacity: 10, refill: { tokens: 1, intervalSeconds: 1 } },
  },
}).defineRoutes({
  create: {
    method: "POST",
    path: "/",
    responses: {
      201: { data: z.object({ id: z.string() }) },
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
    },
  },
});

export const admission = RateLimitModule.register<
  AuthenticatedRequest,
  Subject
>({
  namespace: "example",
  store: new RedisRateLimitStore({ url: process.env.REDIS_URL }),
  subjects: { actor: (request) => request.actorId },
});
```

Import `admission` into your NestJS module and use `@Implements(writes.routes.create)` on a guarded controller. Your guard must populate `actorId` after authentication. There are no built-in subject names or authentication assumptions. Guards run before admission; admission runs before contract parsing and business logic. Attempts consume quota even when later validation or business logic fails.

Enabled routes must declare compatible 429 responses and, for fail-closed behavior, 503 responses. Startup validates these schemas. Route policies inherit defaults; `false` disables admission. Named composition uses `rateLimit: { policies: { burst: { subject: "actor", bucket: ... }, quota: { subject: "actor", algorithm: "sliding-window-log", windows: ... } } }`. Named route overrides inherit by name, replace complete strategies, append new entries, or disable an existing entry with `name: false`. Singular and named forms cannot mix. Each policy is consumed sequentially; a later denial does not refund earlier charges. All identities resolve before consumption.

### Errors and telemetry

`RateLimitError` is a plain, library-owned `Error` with a typed `type`, stable `RATE_LIMIT_*` code, HTTP status, optional decision context, and an underlying `cause`. `rateLimitHttpError` translates only denied/unavailable errors into safe HTTP bodies and `Retry-After` headers; unrelated errors remain the application's responsibility. Raw dependency messages and causes are never put in that HTTP body.

OpenTelemetry spans use the `api-contracts/rate-limit` instrumentation scope. No exporter or telemetry backend is configured. The optional best-effort `observe` callback receives outcome and duration, without identity values. Browser contract/client imports do not load telemetry, NestJS, Redis, or Node.js modules.

## Checks

```sh
bun run fmt
bun run build
bun run test
bun run check:public
RUN_REDIS_TESTS=1 bun run test
```

The optional Redis tests start a disposable local `redis-server` over a Unix socket; install that executable first. No shared Redis service is used.

`check:public` checks tracked files for environment files, credentials, local paths, and workspace-only dependencies. It is a guardrail, not a guarantee or a replacement for reviewing material before publishing. The repository starts with fresh history and includes only the generic library, generic tests, and standalone tooling.

No open-source license has been selected yet. Public source visibility does not grant a redistribution license.
