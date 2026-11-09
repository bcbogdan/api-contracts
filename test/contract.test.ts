import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { createContract } from "@/contract";

describe("api-contract - contract builder", () => {
  it("creates a contract with typed scopes", () => {
    const contract = createContract({
      name: "Books API",
      basePath: "/api/books",
      version: "1.0.0",
      scopes: ["books:read", "books:write"] as const,
    }).defineRoutes({
      listBooks: {
        method: "GET",
        path: "/",
        scope: ["books:read"],
        responses: {
          200: { data: z.array(z.string()) },
        },
      },
      createBook: {
        method: "POST",
        path: "/",
        scope: ["books:write"],
        body: {
          schema: z.object({ title: z.string() }),
          contentType: "application/json",
        },
        responses: {
          201: { data: z.object({ id: z.string() }) },
        },
      },
      getBook: {
        method: "GET",
        path: "/:id",
        scope: ["books:read"],
        params: z.object({ id: z.string() }),
        responses: {
          200: { data: z.object({ id: z.string() }) },
        },
      },
    });

    type RouteScopeValue = NonNullable<
      (typeof contract)["routes"][keyof (typeof contract)["routes"]]["scope"]
    >[number];

    expectTypeOf<RouteScopeValue>().toEqualTypeOf<
      "books:read" | "books:write"
    >();
    expect(contract.version).toBe("1.0.0");
    expect(contract.scopes).toEqual(["books:read", "books:write"]);
    expect(contract.routes.listBooks.scope).toEqual(["books:read"]);
    expect(contract.routes.createBook.scope).toEqual(["books:write"]);
  });

  it("allows scope values when contract does not declare scopes", () => {
    const contract = createContract({
      name: "Health API",
      basePath: "/api/health",
    }).defineRoutes({
      healthCheck: {
        method: "GET",
        path: "/",
        scope: ["internal:health"],
        responses: {
          200: { data: z.object({ ok: z.boolean() }) },
        },
      },
    });

    expect(contract.routes.healthCheck.scope).toEqual(["internal:health"]);
  });
});
