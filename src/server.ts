import {
  applyDecorators,
  BadRequestException,
  createParamDecorator,
  Delete,
  ExecutionContext,
  Get,
  InternalServerErrorException,
  Patch,
  Post,
  Put,
  UseInterceptors,
  SetMetadata,
} from "@nestjs/common";
import { RateLimitInterceptor } from "./rate-limit/nestjs/rate-limit.interceptor";
import { RATE_LIMIT_METADATA } from "./rate-limit/rate-limit.constants";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { z } from "zod";
import {
  ApiContract,
  BodySchema,
  HttpMethod,
  InferZod,
  PathParams,
  ResponseData,
  ResponseHeaders,
  ResponseSchema,
  ResponseStatus,
  RouteDefinition,
  normalizeHeaders,
} from "./contract";

export type RequestInput<Route extends RouteDefinition> = {
  params: Route["params"] extends z.ZodType
    ? InferZod<Route["params"]>
    : PathParams<Route["path"]>;
} & (Route["query"] extends z.ZodType
  ? { query: InferZod<Route["query"]> }
  : {}) &
  (Route["headers"] extends z.ZodType
    ? { headers: InferZod<Route["headers"]> }
    : {}) &
  (Route["body"] extends BodySchema
    ? { body: InferZod<Route["body"]["schema"]> }
    : {});

export type ContractRequest<
  Contract extends ApiContract,
  RouteKey extends keyof Contract["routes"],
> = RequestInput<Contract["routes"][RouteKey]>;

export type ResponseShape<
  Status extends number,
  Schema extends ResponseSchema,
> = {
  status: Status;
  data: ResponseData<Schema>;
  headers?: ResponseHeaders<Schema>;
  contentType?: Schema["contentType"];
};

export type RouteResponse<Route extends RouteDefinition> = {
  [Status in ResponseStatus<Route>]: ResponseShape<
    Status,
    Route["responses"][Status]
  >;
}[ResponseStatus<Route>];

export type InferController<Contract extends ApiContract> = {
  [RouteKey in keyof Contract["routes"]]: (
    ...args: any[]
  ) => Promise<RouteResponse<Contract["routes"][RouteKey]>>;
};

export type InferRequests<Contract extends ApiContract> = {
  [Key in keyof Contract["routes"]]: RequestInput<Contract["routes"][Key]>;
};

export type InferRequest<Controller, RouteKey extends keyof Controller> =
  Controller extends InferController<infer Contract>
    ? RouteKey extends keyof Contract["routes"]
      ? RequestInput<Contract["routes"][RouteKey]>
      : never
    : Controller[RouteKey] extends (
          input: infer Input,
          ...args: any[]
        ) => Promise<unknown>
      ? Input
      : never;

export type ControllerResponses<Controller> = {
  [Key in keyof Controller]: Controller[Key] extends (
    ...args: any[]
  ) => Promise<infer Output>
    ? Promise<Output>
    : never;
};

type RequestSchemas = {
  params?: z.ZodType;
  query?: z.ZodType;
  headers?: z.ZodType;
  body?: z.ZodType;
};

const REQUEST_INPUT_METADATA = Symbol("api-contract:request-input");

const parseSchema = (
  schema: z.ZodType | undefined,
  value: unknown,
  label: string,
) => {
  if (!schema) {
    return undefined;
  }

  const parsed = schema.safeParse(value);

  if (parsed.success) {
    return parsed.data;
  }

  throw new BadRequestException({
    message: `Invalid ${label}`,
    issues: parsed.error.issues,
  });
};

const buildInput = (schemas: RequestSchemas, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest();
  const normalizedHeaders = normalizeHeaders(request.headers ?? {});

  return {
    params: schemas.params
      ? parseSchema(schemas.params, request.params, "params")
      : (request.params ?? {}),
    ...(schemas.query
      ? { query: parseSchema(schemas.query, request.query, "query") }
      : {}),
    ...(schemas.headers
      ? { headers: parseSchema(schemas.headers, normalizedHeaders, "headers") }
      : {}),
    ...(schemas.body
      ? { body: parseSchema(schemas.body, request.body, "body") }
      : {}),
  };
};

const ContractInput = (schemas: RequestSchemas) =>
  createParamDecorator((_data: unknown, context: ExecutionContext) =>
    buildInput(schemas, context),
  )();

export const Request =
  (): ParameterDecorator => (target, propertyKey, parameterIndex) => {
    if (!propertyKey) {
      return;
    }

    const existing =
      (Reflect.getMetadata(REQUEST_INPUT_METADATA, target, propertyKey) as
        number[] | undefined) ?? [];

    if (existing.includes(parameterIndex)) {
      return;
    }

    Reflect.defineMetadata(
      REQUEST_INPUT_METADATA,
      [...existing, parameterIndex],
      target,
      propertyKey,
    );
  };

type RouteHandlerResponse = {
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
  contentType?: string;
};

type ResponseValidationOptions = {
  validateResponse?: boolean;
};

const validateResponse = (
  route: RouteDefinition,
  result: RouteHandlerResponse,
  options: ResponseValidationOptions,
) => {
  if (!options.validateResponse) {
    return;
  }

  const schema = route.responses[result.status];

  if (!schema) {
    throw new InternalServerErrorException(
      `Unexpected status ${result.status} for ${route.method} ${route.path}`,
    );
  }

  if (schema.headers) {
    const headers = normalizeHeaders(result.headers ?? {});
    const parsedHeaders = schema.headers.safeParse(headers);
    if (!parsedHeaders.success) {
      throw new InternalServerErrorException({
        message: `Invalid response headers for ${route.method} ${route.path}`,
        issues: parsedHeaders.error.issues,
      });
    }
  }

  if (schema.data) {
    const parsedData = schema.data.safeParse(result.data);
    if (!parsedData.success) {
      throw new InternalServerErrorException({
        message: `Invalid response body for ${route.method} ${route.path}`,
        issues: parsedData.error.issues,
      });
    }
  }
};

const applyResponse = (
  response: any,
  result: RouteHandlerResponse | unknown,
  route: RouteDefinition,
  options: ResponseValidationOptions,
) => {
  if (!result || typeof result !== "object" || !("status" in result)) {
    return result;
  }

  const { status, data, headers, contentType } = result as RouteHandlerResponse;

  validateResponse(route, { status, data, headers, contentType }, options);

  response.status(status);

  if (contentType) {
    response.type(contentType);
  }

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value);
    }
  }

  return data;
};

class ContractResponseInterceptor {
  private readonly route: RouteDefinition;
  private readonly options: ResponseValidationOptions;

  constructor(route: RouteDefinition, options: ResponseValidationOptions) {
    this.route = route;
    this.options = options;
  }

  intercept(context: ExecutionContext, next: { handle: () => any }) {
    const response = context.switchToHttp().getResponse();
    const handlerResult = next.handle();

    if (handlerResult && typeof handlerResult.then === "function") {
      return handlerResult.then((result: unknown) =>
        applyResponse(response, result, this.route, this.options),
      );
    }

    if (
      handlerResult &&
      typeof handlerResult === "object" &&
      "pipe" in handlerResult
    ) {
      const stream = handlerResult as Observable<
        RouteHandlerResponse | unknown
      >;

      return stream.pipe(
        map((result: RouteHandlerResponse | unknown) =>
          applyResponse(response, result, this.route, this.options),
        ),
      );
    }

    return applyResponse(response, handlerResult, this.route, this.options);
  }
}

const methodDecorator = (method: HttpMethod, path: string): MethodDecorator => {
  switch (method) {
    case "GET":
      return Get(path);
    case "POST":
      return Post(path);
    case "PUT":
      return Put(path);
    case "PATCH":
      return Patch(path);
    case "DELETE":
      return Delete(path);
    default:
      throw new InternalServerErrorException(`Unsupported method: ${method}`);
  }
};

type ImplementsOptions = {
  validateResponse?: boolean;
};

export const Implements = (
  route: RouteDefinition,
  options: ImplementsOptions = {},
): MethodDecorator => {
  if (
    route.rateLimit &&
    !route.resolvedRateLimit &&
    !route.resolvedRateLimits
  ) {
    throw new Error(
      "Rate limited routes must be resolved through createContract().defineRoutes()",
    );
  }
  const schemas = {
    params: route?.params,
    query: route?.query,
    headers: route?.headers,
    body: route?.body?.schema,
  };
  const decorator = applyDecorators(
    methodDecorator(route.method, route.path),
    ...(route.resolvedRateLimit || route.resolvedRateLimits?.length
      ? [
          SetMetadata(RATE_LIMIT_METADATA, {
            ...(route.resolvedRateLimit
              ? { policy: route.resolvedRateLimit }
              : { policies: route.resolvedRateLimits }),
            responses: Object.keys(route.responses).map(Number),
            validateErrorResponse: (
              status: number,
              body: unknown,
              headers: Record<string, string>,
            ) => {
              const schema = route.responses[status];
              return (
                !!schema &&
                !!schema.data &&
                schema.data.safeParse(body).success &&
                (!schema.headers ||
                  schema.headers.safeParse(
                    normalizeHeaders(
                      Object.fromEntries(
                        Object.entries(headers).map(([key, value]) => [
                          key.toLowerCase(),
                          value,
                        ]),
                      ),
                    ),
                  ).success)
              );
            },
          }),
          UseInterceptors(RateLimitInterceptor),
        ]
      : []),
    UseInterceptors(new ContractResponseInterceptor(route, options)),
  );

  return (target, propertyKey, descriptor) => {
    const requestInputIndexes =
      (Reflect.getMetadata(REQUEST_INPUT_METADATA, target, propertyKey) as
        number[] | undefined) ?? [];

    for (const index of requestInputIndexes) {
      ContractInput(schemas)(target, propertyKey, index);
    }

    decorator(target, propertyKey, descriptor);
  };
};
