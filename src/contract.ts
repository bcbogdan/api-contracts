import type { z } from "zod";
import type {
  RateLimitDefaults,
  RouteRateLimit,
  ResolvedRouteRateLimit,
  NamedRateLimitDefaults,
  NamedRouteRateLimit,
  ResolvedNamedRateLimit,
} from "./rate-limit/types";
import { resolveRateLimits } from "./resolve-rate-limits";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type InferZod<T> = T extends z.ZodType ? z.infer<T> : never;

type ExtractPathParams<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractPathParams<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

export type PathParams<Path extends string> = [
  ExtractPathParams<Path>,
] extends [never]
  ? {}
  : {
      [Key in ExtractPathParams<Path>]: string;
    };

export type BodySchema = Readonly<{
  schema: z.ZodType;
  contentType?: string;
}>;

export type StatusCode = number;

export type ResponseSchema = Readonly<{
  data?: z.ZodTypeAny;
  headers?: z.ZodTypeAny;
  contentType?: string;
}>;

export type RouteResponses = Readonly<Record<StatusCode, ResponseSchema>>;

export type RouteDefinition<
  Scope extends string = string,
  Subject extends string = string,
> = Readonly<{
  method: HttpMethod;
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  headers?: z.ZodType;
  body?: BodySchema;
  scope?: readonly Scope[];
  responses: RouteResponses;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  auth?: string | string[];
  rateLimit?:
    | ([Subject] extends [never]
        ? never
        : RouteRateLimit<Subject> | NamedRouteRateLimit<Subject>)
    | false;
  resolvedRateLimit?: ResolvedRouteRateLimit<Subject>;
  resolvedRateLimits?: readonly ResolvedNamedRateLimit<Subject>[];
  /** Supported request content types for OpenAPI/docs. */
  consumes?: string[];
  /** Supported response content types for OpenAPI/docs. */
  produces?: string[];
}>;

export type ApiContract<
  Routes extends Record<string, RouteDefinition<string>> = Record<
    string,
    RouteDefinition
  >,
  Scope extends string = string,
  Subject extends string = string,
> = Readonly<{
  name: string;
  description?: string;
  basePath: string;
  version?: string;
  scopes?: readonly Scope[];
  rateLimitSubjects?: readonly Subject[];
  routes: Routes;
}>;

type ScopeFromList<Scopes extends readonly string[] | undefined> =
  Scopes extends readonly (infer Scope extends string)[] ? Scope : string;

type SubjectVocabulary = readonly [] | readonly [string, ...string[]];

type SubjectFromList<Subjects extends SubjectVocabulary | undefined> =
  Subjects extends readonly string[] ? Subjects[number] : never;

type VocabularyConfig<Subjects extends SubjectVocabulary | undefined> =
  Subjects extends SubjectVocabulary
    ? Readonly<{
        rateLimitSubjects: Subjects;
        rateLimit?:
          | RateLimitDefaults<NoInfer<Subjects[number]>>
          | NamedRateLimitDefaults<NoInfer<Subjects[number]>>;
      }>
    : Readonly<{ rateLimitSubjects?: undefined; rateLimit?: never }>;

type ContractConfig<
  Scopes extends readonly string[] | undefined,
  Subjects extends SubjectVocabulary | undefined,
  Defaults extends RouteResponses,
> = Readonly<{
  name: string;
  description?: string;
  basePath: string;
  version?: string;
  scopes?: Scopes;
  rateLimitSubjects?: Subjects;
  defaultResponses?: Defaults;
}> &
  VocabularyConfig<Subjects>;

type ResolvedContract<
  Routes extends Record<string, RouteDefinition>,
  Scopes extends readonly string[] | undefined,
  Subjects extends SubjectVocabulary | undefined,
  Defaults extends RouteResponses,
> = Omit<
  ApiContract<
    {
      [Key in keyof Routes]: Omit<Routes[Key], "responses"> & {
        responses: Omit<Defaults, keyof Routes[Key]["responses"]> &
          Routes[Key]["responses"];
      } & Pick<
          RouteDefinition<string, SubjectFromList<Subjects>>,
          "resolvedRateLimit" | "resolvedRateLimits"
        >;
    },
    ScopeFromList<Scopes>,
    SubjectFromList<Subjects>
  >,
  "rateLimitSubjects"
> &
  Pick<VocabularyConfig<Subjects>, "rateLimitSubjects">;

type ContractBuilder<
  ConfigScopes extends readonly string[] | undefined,
  Subjects extends SubjectVocabulary | undefined,
  Defaults extends RouteResponses,
> = Readonly<{
  defineRoutes: <
    Routes extends Record<
      string,
      RouteDefinition<ScopeFromList<ConfigScopes>, SubjectFromList<Subjects>>
    >,
  >(
    routes: Routes,
  ) => ResolvedContract<Routes, ConfigScopes, Subjects, Defaults>;
}>;

export const createContract = <
  const Scopes extends readonly string[] | undefined = undefined,
  const Subjects extends SubjectVocabulary | undefined = undefined,
  const Defaults extends RouteResponses = {},
>(
  config: ContractConfig<Scopes, Subjects, Defaults>,
): ContractBuilder<Scopes, Subjects, Defaults> => {
  return {
    defineRoutes: <
      Routes extends Record<
        string,
        RouteDefinition<ScopeFromList<Scopes>, SubjectFromList<Subjects>>
      >,
    >(
      routes: Routes,
    ) => {
      const resolved = Object.fromEntries(
        Object.entries(routes).map(([key, route]) => {
          const fullPath =
            `/${config.basePath}/${route.path}`
              .replace(/\/+/g, "/")
              .replace(/\/$/, "") || "/";
          return [
            key,
            {
              ...route,
              responses: config.defaultResponses
                ? { ...config.defaultResponses, ...route.responses }
                : route.responses,
              ...resolveRateLimits(
                config.rateLimit,
                route.rateLimit,
                `${route.method} ${fullPath}`,
                config.rateLimitSubjects ?? [],
              ),
            },
          ];
        }),
      );
      return {
        ...config,
        routes: resolved,
      } as ResolvedContract<Routes, Scopes, Subjects, Defaults>;
    },
  };
};

export type ResponseData<Schema extends ResponseSchema> =
  Schema["data"] extends z.ZodTypeAny ? InferZod<Schema["data"]> : undefined;

export type ResponseHeaders<Schema extends ResponseSchema> =
  Schema["headers"] extends z.ZodTypeAny
    ? InferZod<Schema["headers"]>
    : undefined;

export type ResponseStatus<Route extends RouteDefinition> =
  keyof Route["responses"] & number;

export const normalizeHeaders = (headers: Record<string, unknown>) => {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      Array.isArray(value)
        ? value.join(",")
        : value === undefined
          ? undefined
          : String(value),
    ]),
  );
};
