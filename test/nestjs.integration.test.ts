import "reflect-metadata";
import { Controller } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { of } from "rxjs";
import { z } from "zod";
import { Implements, Request } from "@/server";
import { createContract } from "@/contract";

const inheritedRoute = createContract({
  name: "inherited response",
  basePath: "/implements",
  defaultResponses: {
    503: {
      data: z.object({ message: z.string() }),
      headers: z.object({ "x-error-id": z.string() }),
    },
  },
}).defineRoutes({
  unavailable: {
    method: "GET",
    path: "/inherited",
    responses: { 200: { data: z.boolean() } },
  },
}).routes.unavailable;

const requestRoute = {
  method: "POST",
  path: "/request/:id",
  query: z.object({ page: z.coerce.number() }),
  headers: z.object({ "x-api-key": z.string() }),
  body: { schema: z.object({ title: z.string() }) },
  responses: {
    200: {
      data: z.object({
        params: z.object({ id: z.string() }),
        query: z.object({ page: z.number() }),
        headers: z.object({ "x-api-key": z.string() }),
        body: z.object({ title: z.string() }),
      }),
    },
  },
} as const;

const mappedResponseRoute = {
  method: "GET",
  path: "/mapped-response",
  responses: {
    201: {
      data: z.object({ ok: z.boolean() }),
    },
  },
} as const;

const observableRoute = {
  method: "POST",
  path: "/observable",
  responses: {
    200: { data: z.boolean() },
  },
} as const;

const validateStatusRoute = {
  method: "POST",
  path: "/validate-status",
  responses: {
    200: { data: z.object({ ok: z.boolean() }) },
  },
} as const;

const validateBodyRoute = {
  method: "POST",
  path: "/validate-body",
  responses: {
    200: { data: z.object({ ok: z.boolean() }) },
  },
} as const;

const validateHeadersRoute = {
  method: "POST",
  path: "/validate-headers",
  responses: {
    200: {
      data: z.object({ ok: z.boolean() }),
      headers: z.object({ "x-trace-id": z.literal("trace") }),
    },
  },
} as const;

@Controller("implements")
class ImplementsController {
  @Implements(inheritedRoute, { validateResponse: true })
  inheritedResponse() {
    return {
      status: 503 as const,
      data: { message: "unavailable" },
      headers: { "x-error-id": "trace" },
    };
  }

  @Implements(requestRoute)
  parseRequest(@Request() input: unknown) {
    return {
      status: 200 as const,
      data: input,
    };
  }

  @Implements(mappedResponseRoute)
  mappedResponse() {
    return {
      status: 201 as const,
      data: { ok: true },
      headers: { "x-trace-id": "trace" },
      contentType: "application/json",
    };
  }

  @Implements(observableRoute)
  observableResponse() {
    return of({
      status: 200 as const,
      data: true,
      headers: { "x-stream-id": "stream" },
      contentType: "text/plain",
    });
  }

  @Implements(validateStatusRoute, { validateResponse: true })
  invalidStatusResponse() {
    return {
      status: 500 as const,
      data: { ok: true },
    };
  }

  @Implements(validateBodyRoute, { validateResponse: true })
  invalidBodyResponse() {
    return {
      status: 200 as const,
      data: { ok: "no" },
    };
  }

  @Implements(validateHeadersRoute, { validateResponse: true })
  invalidHeadersResponse() {
    return {
      status: 200 as const,
      data: { ok: true },
      headers: { "x-trace-id": "wrong" },
    };
  }
}

const withTestApp = async (run: (baseUrl: string) => Promise<void>) => {
  const moduleRef = await Test.createTestingModule({
    controllers: [ImplementsController],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  await app.listen(0);

  try {
    const address = app.getHttpServer().address();

    if (!address || typeof address === "string") {
      throw new Error("Could not resolve test server port");
    }

    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await app.close();
  }
};

describe("api-contract - nestjs integration", () => {
  it("validates and emits inherited response statuses, bodies and headers", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/inherited`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ message: "unavailable" });
      expect(response.headers.get("x-error-id")).toBe("trace");
    });
  });
  it("parses params, query, headers, and body from HTTP request", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/request/abc?page=3`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret",
        },
        body: JSON.stringify({ title: "Test" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        params: { id: "abc" },
        query: { page: 3 },
        headers: { "x-api-key": "secret" },
        body: { title: "Test" },
      });
    });
  });

  it("binds correct method and path through live routing", async () => {
    await withTestApp(async (baseUrl) => {
      const wrongMethodResponse = await fetch(
        `${baseUrl}/implements/request/abc?page=1`,
        {
          method: "GET",
        },
      );
      const wrongPathResponse = await fetch(
        `${baseUrl}/implements/request?page=1`,
        {
          method: "POST",
        },
      );

      expect(wrongMethodResponse.status).toBe(404);
      expect(wrongPathResponse.status).toBe(404);
    });
  });

  it("maps status, headers, content type, and response body", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/mapped-response`);

      expect(response.status).toBe(201);
      expect(response.headers.get("x-trace-id")).toBe("trace");
      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
      expect(await response.json()).toEqual({ ok: true });
    });
  });

  it("maps observable response payload to HTTP response", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/observable`, {
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-stream-id")).toBe("stream");
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("true");
    });
  });

  it("returns 400 for invalid request payload", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/request/abc?page=3`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secret",
        },
        body: JSON.stringify({ invalid: true }),
      });

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Invalid body");
    });
  });

  it("returns 500 when validateResponse receives an unexpected status", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/validate-status`, {
        method: "POST",
      });

      expect(response.status).toBe(500);
      expect(await response.text()).toContain("Unexpected status 500");
    });
  });

  it("returns 500 when validateResponse receives invalid response body", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/validate-body`, {
        method: "POST",
      });

      expect(response.status).toBe(500);
      expect(await response.text()).toContain("Invalid response body");
    });
  });

  it("returns 500 when validateResponse receives invalid response headers", async () => {
    await withTestApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/implements/validate-headers`, {
        method: "POST",
      });

      expect(response.status).toBe(500);
      expect(await response.text()).toContain("Invalid response headers");
    });
  });
});
