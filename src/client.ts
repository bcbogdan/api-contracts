import { z } from "zod";
import {
  ApiContract,
  BodySchema,
  InferZod,
  PathParams,
  ResponseData,
  ResponseHeaders,
  ResponseSchema,
  ResponseStatus,
  RouteDefinition,
  normalizeHeaders,
} from "./contract";

type HasPathParams<Path extends string> = keyof PathParams<Path> extends never
  ? false
  : true;

export type ClientInput<Route extends RouteDefinition> =
  (Route["params"] extends z.ZodType
    ? { params: InferZod<Route["params"]> }
    : HasPathParams<Route["path"]> extends true
      ? { params: PathParams<Route["path"]> }
      : {}) &
    (Route["query"] extends z.ZodType
      ? { query: InferZod<Route["query"]> }
      : {}) &
    (Route["headers"] extends z.ZodType
      ? { headers: InferZod<Route["headers"]> }
      : {}) &
    (Route["body"] extends BodySchema
      ? { body: InferZod<Route["body"]["schema"]> }
      : {});

export type ClientResponseShape<
  Status extends number,
  Schema extends ResponseSchema,
> = {
  status: Status;
  body: ResponseData<Schema>;
  headers?: ResponseHeaders<Schema>;
  contentType?: Schema["contentType"];
};

export type ClientResponse<Route extends RouteDefinition> = {
  [Status in ResponseStatus<Route>]: ClientResponseShape<
    Status,
    Route["responses"][Status]
  >;
}[ResponseStatus<Route>];

export type Client<Contract extends ApiContract> = {
  [RouteKey in keyof Contract["routes"]]: keyof ClientInput<
    Contract["routes"][RouteKey]
  > extends never
    ? () => Promise<ClientResponse<Contract["routes"][RouteKey]>>
    : (
        input: ClientInput<Contract["routes"][RouteKey]>,
      ) => Promise<ClientResponse<Contract["routes"][RouteKey]>>;
};

type ClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  validateInput?: boolean;
  throwOnUnexpectedStatus?: boolean;
};

const joinPaths = (basePath: string, routePath: string) => {
  const normalizedBase = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  const normalizedRoute = routePath.startsWith("/")
    ? routePath
    : `/${routePath}`;

  if (!normalizedBase) {
    return normalizedRoute;
  }

  return `${normalizedBase}${normalizedRoute}`;
};

const applyPathParams = (path: string, params: Record<string, string> = {}) => {
  return path.replace(/:([A-Za-z0-9_]+)/g, (_match, key: string) => {
    const value = params[key];

    if (value === undefined) {
      throw new Error(`Missing route param: ${key}`);
    }

    return encodeURIComponent(value);
  });
};

const buildQueryString = (query: Record<string, unknown> | undefined) => {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }

    params.set(key, String(value));
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
};

const parseInput = (
  schema: z.ZodType | undefined,
  value: unknown,
  label: string,
  enabled: boolean,
) => {
  if (!enabled || !schema) {
    return value;
  }

  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new Error(`Invalid ${label}: ${parsed.error.message}`);
};

const parseResponseBody = async (
  response: Response,
  schema: ResponseSchema | undefined,
) => {
  const contentType =
    response.headers.get("content-type") ?? schema?.contentType;
  const isJson = contentType?.includes("application/json");

  if (response.status === 204) {
    return undefined;
  }

  const rawBody = isJson ? await response.json() : await response.text();

  if (!schema?.data) {
    return rawBody;
  }

  const result = schema.data.safeParse(rawBody);
  if (result.error) {
    console.error(result.error);
    throw new Error("Invalid response body");
  } else {
    return result.data;
  }
};

const parseResponseHeaders = (
  response: Response,
  schema: ResponseSchema | undefined,
) => {
  if (!schema?.headers) {
    return undefined;
  }

  const rawHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    rawHeaders[key] = value;
  });
  return schema.headers.parse(rawHeaders);
};

export function createClient<Contract extends ApiContract>(
  contract: Contract,
  options: ClientOptions = {},
): Client<Contract> {
  const explicitFetch = options.fetch;
  const baseUrl = options.baseUrl ? options.baseUrl.replace(/\/+$/, "") : "";
  const basePath = contract.basePath
    ? contract.basePath.replace(/\/+$/, "")
    : "";
  const routes = contract.routes as Record<string, RouteDefinition>;
  const validateInput = options.validateInput ?? true;
  const throwOnUnexpectedStatus = options.throwOnUnexpectedStatus ?? true;

  const client: Partial<Client<Contract>> = {};

  for (const [routeKey, route] of Object.entries(routes)) {
    client[routeKey as keyof Contract["routes"]] = (async (
      input?: ClientInput<RouteDefinition>,
    ) => {
      const resolvedInput = (input ?? {}) as ClientInput<RouteDefinition>;
      const validatedParams = parseInput(
        route.params,
        (resolvedInput as { params?: unknown }).params,
        "params",
        validateInput,
      );
      const validatedQuery = parseInput(
        route.query,
        (resolvedInput as { query?: unknown }).query,
        "query",
        validateInput,
      );
      const validatedHeaders = parseInput(
        route.headers,
        (resolvedInput as { headers?: unknown }).headers,
        "headers",
        validateInput,
      );
      const validatedBody = parseInput(
        route.body?.schema,
        (resolvedInput as { body?: unknown }).body,
        "body",
        validateInput,
      );
      const headers = normalizeHeaders(
        (validatedHeaders as Record<string, unknown>) ?? {},
      );
      const routePath = applyPathParams(
        route.path,
        (validatedParams as Record<string, string>) ?? {},
      );
      const requestPath = joinPaths(basePath, routePath);
      const url = `${baseUrl}${requestPath}${buildQueryString(validatedQuery as Record<string, unknown> | undefined)}`;

      let body: BodyInit | undefined;
      if (route.body) {
        const contentType = route.body.contentType ?? "application/json";
        if (!headers["content-type"]) {
          headers["content-type"] = contentType;
        }

        const rawBody = validatedBody;
        body = contentType.includes("application/json")
          ? JSON.stringify(rawBody ?? null)
          : String(rawBody ?? "");
      }

      const response = await (explicitFetch ?? fetch)(url, {
        method: route.method,
        headers: headers as Record<string, string>,
        body,
      });

      const responseSchema = route.responses[response.status] as
        ResponseSchema | undefined;
      if (!responseSchema && throwOnUnexpectedStatus) {
        throw new Error(
          `Unexpected status ${response.status} for ${route.method} ${route.path}`,
        );
      }
      const responseBody = await parseResponseBody(response, responseSchema);
      const responseHeaders = parseResponseHeaders(response, responseSchema);
      const contentType =
        response.headers.get("content-type") ?? responseSchema?.contentType;

      return {
        status: response.status,
        body: responseBody,
        headers: responseHeaders,
        contentType,
      } as ClientResponse<RouteDefinition>;
    }) as Client<Contract>[keyof Contract["routes"]];
  }

  return client as Client<Contract>;
}
