import { expectTypeOf } from "vitest";
import { z } from "zod";
import { createContract } from "../src/contract";
import type { InferRequests, RouteResponse } from "../src/server";
import { RateLimitModule } from "../src/rate-limit/nestjs/rate-limit.module";
import type { RateLimitStore } from "../src/rate-limit/types";

const rateLimitSubjects = ["user", "organization"] as const;
type Subject = (typeof rateLimitSubjects)[number];
const windows = { burst: { limit: 10, windowSeconds: 60 } };
const bucket = { capacity: 10, refill: { tokens: 1, intervalSeconds: 10 } };
createContract({
  name: "bucket",
  basePath: "/",
  rateLimitSubjects: ["user"],
  rateLimit: { subject: "user", bucket },
});
createContract({
  name: "mixed",
  basePath: "/",
  rateLimitSubjects: ["user"],
  // @ts-expect-error Mixed strategies are invalid.
  rateLimit: { subject: "user", bucket, windows },
});
createContract({
  name: "implicit",
  basePath: "/",
  rateLimitSubjects: ["user"],
  // @ts-expect-error Sliding windows require an explicit discriminator.
  rateLimit: { subject: "user", windows },
});
const config = { name: "typed", basePath: "/api", rateLimitSubjects };
const route = {
  method: "POST",
  path: "/:id",
  responses: { 200: { data: z.literal("ok") } },
} as const;
const composed = createContract({
  ...config,
  rateLimit: {
    policies: {
      userBurst: { subject: "user", bucket, id: "shared-user" },
      orgQuota: {
        subject: "organization",
        algorithm: "sliding-window-log",
        windows,
      },
    },
  },
}).defineRoutes({
  inherit: route,
  override: {
    ...route,
    rateLimit: { policies: { userBurst: { bucket }, orgQuota: false } },
  },
});
expectTypeOf(
  composed.routes.inherit.resolvedRateLimits?.[0]?.subject,
).toEqualTypeOf<Subject | undefined>();
expectTypeOf(composed.routes.inherit.path).toEqualTypeOf<"/:id">();
function rejectedComposition() {
  createContract({
    ...config,
    rateLimit: {
      policies: {
        // @ts-expect-error Named defaults require complete strategies.
        missing: { subject: "user" },
        // @ts-expect-error Named subjects cannot widen the vocabulary.
        typo: { subject: "organzation", bucket },
      },
    },
  });
  createContract(config).defineRoutes({
    invalid: {
      ...route,
      rateLimit: {
        policies: {
          // @ts-expect-error Named overrides use the contract vocabulary.
          typo: { subject: "organzation" },
          // @ts-expect-error Strategies cannot be mixed within a named entry.
          mixed: { subject: "user", bucket, windows },
        },
      },
    },
  });
  createContract({
    ...config,
    // @ts-expect-error Named and singular declarations cannot be mixed.
    rateLimit: { policies: {}, subject: "user", bucket },
  });
  createContract(config).defineRoutes({
    invalid: {
      ...route,
      // @ts-expect-error Named and singular route overrides cannot be mixed.
      rateLimit: { policies: {}, subject: "user" },
    },
  });
}
void rejectedComposition;

const contract = createContract({
  ...config,
  scopes: ["read", "write"],
  rateLimit: {
    subject: "user",
    algorithm: "sliding-window-log" as const,
    windows,
  },
}).defineRoutes({
  inherited: {
    ...route,
    scope: ["read"],
    body: { schema: z.object({ title: z.string() }) },
  },
  override: { ...route, rateLimit: { subject: "organization" } },
  replace: {
    ...route,
    rateLimit: {
      algorithm: "sliding-window-log" as const,
      windows: { daily: { limit: 20, windowSeconds: 86400 } },
    },
  },
  shared: { ...route, rateLimit: { id: "shared" } },
  disabled: { ...route, rateLimit: false },
});

expectTypeOf(contract.rateLimitSubjects).toEqualTypeOf<
  typeof rateLimitSubjects
>();
expectTypeOf(contract.routes.inherited.path).toEqualTypeOf<"/:id">();
expectTypeOf(contract.routes.inherited.method).toEqualTypeOf<"POST">();
expectTypeOf(contract.routes.inherited.scope).toEqualTypeOf<"read"[]>();
expectTypeOf(
  contract.routes.inherited.resolvedRateLimit?.subject,
).toEqualTypeOf<Subject | undefined>();
expectTypeOf<InferRequests<typeof contract>["inherited"]>().toEqualTypeOf<
  { params: { id: string } } & { body: { title: string } }
>();
expectTypeOf<
  RouteResponse<typeof contract.routes.inherited>["status"]
>().toEqualTypeOf<200>();
expectTypeOf<
  RouteResponse<typeof contract.routes.inherited>["data"]
>().toEqualTypeOf<"ok">();

// Keep rejected inputs out of runtime execution; tsc still checks every assertion.
function rejectedContracts() {
  createContract({
    name: "inline typo",
    basePath: "/",
    rateLimitSubjects: ["user", "organization"],
    rateLimit: {
      // @ts-expect-error Inline tuples also infer exclusively from the vocabulary.
      subject: "organzation",
      algorithm: "sliding-window-log" as const,
      windows,
    },
  });
  createContract({
    ...config,
    rateLimit: {
      // @ts-expect-error Defaults cannot widen the vocabulary to include a misspelling.
      subject: "organzation",
      algorithm: "sliding-window-log" as const,
      windows,
    },
  });
  createContract(config).defineRoutes({
    typo: {
      ...route,
      rateLimit: {
        // @ts-expect-error Partial overrides must use the same vocabulary.
        subject: "organzation",
      },
    },
  });
  createContract({
    name: "inline route typo",
    basePath: "/",
    rateLimitSubjects: ["user"],
  }).defineRoutes({
    typo: {
      ...route,
      rateLimit: {
        // @ts-expect-error Route inference cannot widen an inline vocabulary.
        subject: "organization",
        algorithm: "sliding-window-log" as const,
        windows,
      },
    },
  });
  createContract({
    name: "missing",
    basePath: "/",
    // @ts-expect-error Enabled defaults require an explicit vocabulary.
    rateLimit: {
      subject: "user",
      algorithm: "sliding-window-log" as const,
      windows,
    },
  });
  createContract({ name: "missing", basePath: "/" }).defineRoutes({
    missing: {
      ...route,
      // @ts-expect-error Enabled route-only limits also require a vocabulary.
      rateLimit: {
        subject: "user",
        algorithm: "sliding-window-log" as const,
        windows,
      },
    },
  });
  createContract({ name: "missing", basePath: "/" }).defineRoutes({
    missing: {
      ...route,
      // @ts-expect-error Even an empty enabled override requires a vocabulary.
      rateLimit: {},
    },
  });
  createContract({ ...config, scopes: ["read"] }).defineRoutes({
    invalid: {
      ...route,
      // @ts-expect-error Scope inference remains constrained independently of subjects.
      scope: ["write"],
    },
  });
  const widenedSubjects: string[] = ["user"];
  // @ts-expect-error Widened arrays cannot define a finite subject vocabulary.
  createContract({ ...config, rateLimitSubjects: widenedSubjects });
}
void rejectedContracts;

const ordinary = createContract({
  name: "ordinary",
  basePath: "/",
}).defineRoutes({
  plain: route,
  disabled: { ...route, rateLimit: false },
});
expectTypeOf(ordinary.routes.plain.path).toEqualTypeOf<"/:id">();
createContract(config).defineRoutes({
  limited: {
    ...route,
    rateLimit: {
      subject: "user",
      algorithm: "sliding-window-log" as const,
      windows,
    },
  },
});
createContract({
  name: "inline",
  basePath: "/",
  rateLimitSubjects: ["user", "organization"],
  rateLimit: {
    subject: "user",
    algorithm: "sliding-window-log" as const,
    windows,
  },
}).defineRoutes({
  valid: { ...route, rateLimit: { subject: "organization" } },
});

interface TrustedRequest {
  userId: string;
}

function registries(store: RateLimitStore) {
  const options = { namespace: "typed", store };
  const subjects = {
    user: (request: TrustedRequest) => request.userId,
    organization: async (request: TrustedRequest) => request.userId,
  };
  // @ts-expect-error Request alone cannot silently default the subject vocabulary to string.
  RateLimitModule.register<TrustedRequest>({ ...options, subjects });
  // @ts-expect-error A complete registry still cannot define the vocabulary by inference.
  RateLimitModule.register({ ...options, subjects });
  // @ts-expect-error The registry is required with explicit type arguments too.
  RateLimitModule.register<TrustedRequest, Subject>(options);
  // @ts-expect-error A broad string vocabulary would bypass resolver completeness checks.
  RateLimitModule.register<TrustedRequest, string>({ ...options, subjects });
  RateLimitModule.register<TrustedRequest, Subject>({
    ...options,
    subjects: {
      user: (request) => request.userId,
      organization: async (request) => request.userId,
    },
  });
  RateLimitModule.register<TrustedRequest, Subject>({
    ...options,
    // @ts-expect-error Every vocabulary entry needs a resolver.
    subjects: { user: (request) => request.userId },
  });
  RateLimitModule.register<TrustedRequest, Subject>({
    ...options,
    subjects: {
      ...subjects,
      // @ts-expect-error Misspelled registry entries are not accepted.
      organzation: () => "org",
    },
  });
  RateLimitModule.register<TrustedRequest, Subject>({
    ...options,
    subjects: {
      ...subjects,
      // @ts-expect-error Resolvers cannot return numbers.
      user: () => 123,
    },
  });
  RateLimitModule.register<TrustedRequest, Subject>({
    ...options,
    subjects: {
      ...subjects,
      // @ts-expect-error Async resolvers cannot return objects.
      organization: async () => ({ id: "org" }),
    },
  });
}
void registries;
