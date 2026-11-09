import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClient } from "@/client";
import type { ApiContract } from "@/contract";

describe("api-contract - client", () => {
  const BookSchema = z.object({
    id: z.string(),
    title: z.string(),
    author: z.string(),
    isbn: z.string(),
  });

  const CreateBookSchema = z.object({
    title: z.string(),
    author: z.string(),
    isbn: z.string(),
  });

  const contract = {
    name: "Books API",
    basePath: "/api/books",
    routes: {
      listBooks: {
        method: "GET",
        path: "/",
        query: z.object({ page: z.number() }),
        responses: {
          200: { data: z.array(BookSchema) },
        },
      },
      createBook: {
        method: "POST",
        path: "/",
        headers: z.object({ "x-api-key": z.string() }),
        body: { schema: CreateBookSchema },
        responses: {
          200: {
            data: BookSchema,
            headers: z.object({ "x-trace-id": z.string() }),
          },
        },
      },
      getBook: {
        method: "GET",
        path: "/:id",
        responses: {
          200: { data: BookSchema },
        },
      },
    },
  } as const satisfies ApiContract;

  it("should generate all the route handlers", () => {
    const client = createClient(contract, {
      fetch: vi.fn() as unknown as typeof fetch,
    });

    expect(client.listBooks).toBeTypeOf("function");
    expect(client.createBook).toBeTypeOf("function");
    expect(client.getBook).toBeTypeOf("function");
  });

  it("should call fetch with query and params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "book-1",
          title: "Book 1",
          author: "Author",
          isbn: "123",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = createClient(contract, {
      baseUrl: "https://example.com",
      fetch: fetchMock,
    });

    await client.getBook({ params: { id: "book-1" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/books/book-1",
      {
        method: "GET",
        headers: {},
        body: undefined,
      },
    );
  });

  it("should use the current global fetch when no fetch option is provided", async () => {
    const originalFetch = globalThis.fetch;
    const firstFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "book-1",
          title: "Book 1",
          author: "Author",
          isbn: "123",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const secondFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "book-2",
          title: "Book 2",
          author: "Author",
          isbn: "456",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    try {
      globalThis.fetch = firstFetch;
      const client = createClient(contract, { baseUrl: "https://example.com" });
      globalThis.fetch = secondFetch;

      await client.getBook({ params: { id: "book-2" } });

      expect(firstFetch).not.toHaveBeenCalled();
      expect(secondFetch).toHaveBeenCalledWith(
        "https://example.com/api/books/book-2",
        {
          method: "GET",
          headers: {},
          body: undefined,
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should keep using an explicitly provided fetch option", async () => {
    const originalFetch = globalThis.fetch;
    const explicitFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "book-1",
          title: "Book 1",
          author: "Author",
          isbn: "123",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const globalFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "book-2",
          title: "Book 2",
          author: "Author",
          isbn: "456",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    try {
      const client = createClient(contract, {
        baseUrl: "https://example.com",
        fetch: explicitFetch,
      });
      globalThis.fetch = globalFetch;

      await client.getBook({ params: { id: "book-1" } });

      expect(globalFetch).not.toHaveBeenCalled();
      expect(explicitFetch).toHaveBeenCalledWith(
        "https://example.com/api/books/book-1",
        {
          method: "GET",
          headers: {},
          body: undefined,
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("should send headers and parse response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "book-2",
          title: "Book 2",
          author: "Author",
          isbn: "456",
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-trace-id": "trace-123",
          },
        },
      ),
    );
    const client = createClient(contract, {
      baseUrl: "https://example.com",
      fetch: fetchMock,
    });

    const res = await client.createBook({
      headers: { "x-api-key": "test-key" },
      body: { title: "Book 2", author: "Author", isbn: "456" },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://example.com/api/books/", {
      method: "POST",
      headers: {
        "x-api-key": "test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ title: "Book 2", author: "Author", isbn: "456" }),
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("book-2");
    expect(res.headers).toEqual({ "x-trace-id": "trace-123" });
  });

  it("should append query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "book-1", title: "Book 1", author: "Author", isbn: "123" },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const client = createClient(contract, {
      baseUrl: "https://example.com",
      fetch: fetchMock,
    });

    await client.listBooks({ query: { page: 2 } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/api/books/?page=2",
      {
        method: "GET",
        headers: {},
        body: undefined,
      },
    );
  });

  it("should validate inputs before sending", async () => {
    const fetchMock = vi.fn();
    const client = createClient(contract, {
      baseUrl: "https://example.com",
      fetch: fetchMock,
    });

    await expect(
      client.listBooks({ query: { page: "2" as unknown as number } }),
    ).rejects.toThrow("Invalid query");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("should reject unexpected response status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("Oops", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    const client = createClient(contract, {
      baseUrl: "https://example.com",
      fetch: fetchMock,
    });

    await expect(client.listBooks({ query: { page: 1 } })).rejects.toThrow(
      "Unexpected status 500",
    );
  });
});
