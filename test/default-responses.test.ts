import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import { createContract, type ResponseStatus } from "../src/contract";
import { createClient, type ClientResponse } from "../src/client";
import type { RouteResponse } from "../src/server";

const defaults = {
  500: {
    data: z.object({ message: z.string() }),
    headers: z.object({ "x-error-id": z.string() }),
    contentType: "application/json",
  },
  503: { data: z.object({ unavailable: z.literal(true) }) },
} as const;
const localError = { data: z.object({ reason: z.literal("local") }) };
const contract = createContract({
  name: "defaults",
  basePath: "/",
  defaultResponses: defaults,
}).defineRoutes({
  inherited: {
    method: "GET",
    path: "/inherited",
    responses: { 200: { data: z.string() } },
  },
  overridden: {
    method: "GET",
    path: "/override",
    responses: { 500: localError, 503: {} },
  },
});

describe("contract default responses", () => {
  it("merges exact statuses without mutating defaults or intersecting overridden entries", () => {
    const inherited = contract.routes.inherited.responses;
    const overridden = contract.routes.overridden.responses;
    expect(Object.keys(inherited)).toEqual(["200", "500", "503"]);
    expect(inherited[500]).toBe(defaults[500]);
    expect(overridden[500]).toBe(localError);
    expect(overridden[500]).not.toHaveProperty("headers");
    expect(overridden[500]).not.toHaveProperty("contentType");
    expect(overridden[503]).toEqual({});
    expect(defaults[500]).toHaveProperty("headers");
    expectTypeOf<
      ResponseStatus<typeof contract.routes.inherited>
    >().toEqualTypeOf<200 | 500 | 503>();
    expectTypeOf<
      ResponseStatus<typeof contract.routes.overridden>
    >().toEqualTypeOf<500 | 503>();
    expectTypeOf<(typeof overridden)[500]>().toEqualTypeOf<typeof localError>();
    expectTypeOf<(typeof overridden)[503]>().toEqualTypeOf<{}>();
    type ClientError = Extract<
      ClientResponse<typeof contract.routes.inherited>,
      { status: 500 }
    >;
    type ServerError = Extract<
      RouteResponse<typeof contract.routes.inherited>,
      { status: 500 }
    >;
    expectTypeOf<ClientError["body"]>().toEqualTypeOf<{ message: string }>();
    expectTypeOf<ClientError["headers"]>().toEqualTypeOf<
      { "x-error-id": string } | undefined
    >();
    expectTypeOf<ClientError["contentType"]>().toEqualTypeOf<
      "application/json" | undefined
    >();
    expectTypeOf<ServerError["data"]>().toEqualTypeOf<{ message: string }>();
    type LocalError = Extract<
      ClientResponse<typeof contract.routes.overridden>,
      { status: 500 }
    >;
    expectTypeOf<LocalError["body"]>().toEqualTypeOf<{ reason: "local" }>();
    expectTypeOf<LocalError["headers"]>().toEqualTypeOf<undefined>();
    type LocalServerError = Extract<
      RouteResponse<typeof contract.routes.overridden>,
      { status: 500 }
    >;
    expectTypeOf<LocalServerError["data"]>().toEqualTypeOf<{
      reason: "local";
    }>();
  });

  it("preserves defaultless responses and literal status inference", () => {
    const responses = { 204: {} };
    const route = createContract({
      name: "legacy",
      basePath: "/",
    }).defineRoutes({
      empty: { method: "DELETE", path: "/", responses },
    }).routes.empty;
    expect(route.responses).toBe(responses);
    expectTypeOf<ResponseStatus<typeof route>>().toEqualTypeOf<204>();
    expectTypeOf<
      ClientResponse<typeof route>["body"]
    >().toEqualTypeOf<undefined>();
  });

  it("recognizes inherited errors and parses their body and headers", async () => {
    const client = createClient(contract, {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "failed" }), {
          status: 500,
          headers: {
            "content-type": "application/json",
            "x-error-id": "trace",
          },
        }),
      ),
    });
    const response = await client.inherited();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ message: "failed" });
    expect(response.headers).toEqual({ "x-error-id": "trace" });
  });

  it("uses only the local schema for overridden statuses", async () => {
    const client = createClient(contract, {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ reason: "local" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    expect(await client.overridden()).toMatchObject({
      status: 500,
      body: { reason: "local" },
    });
  });

  it("still validates inherited response headers", async () => {
    const client = createClient(contract, {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: "failed" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    await expect(client.inherited()).rejects.toThrow("x-error-id");
  });

  it("still rejects undeclared statuses instead of treating defaults as a wildcard", async () => {
    const client = createClient(contract, {
      fetch: vi
        .fn()
        .mockResolvedValue(new Response("missing", { status: 404 })),
    });
    await expect(client.inherited()).rejects.toThrow("Unexpected status 404");
  });
});
