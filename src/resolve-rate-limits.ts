import type {
  NamedRateLimitDefaults,
  NamedRouteRateLimit,
  RateLimitDefaults,
  RouteRateLimit,
  ResolvedRouteRateLimit,
  ResolvedNamedRateLimit,
} from "./rate-limit/types";

export function resolveRateLimits(
  defaults: RateLimitDefaults | NamedRateLimitDefaults | undefined,
  override: RouteRateLimit | NamedRouteRateLimit | false | undefined,
  route: string,
  subjects: readonly string[],
): {
  resolvedRateLimit?: ResolvedRouteRateLimit;
  resolvedRateLimits?: readonly ResolvedNamedRateLimit[];
} {
  const fail = (name: string, message: string): never => {
    throw new Error(`Rate limit for ${route} (${name}): ${message}`);
  };
  const named = (
    value:
      | RateLimitDefaults
      | NamedRateLimitDefaults
      | RouteRateLimit
      | NamedRouteRateLimit,
  ) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail("policies", "Declaration must be an object");
    if (!Object.prototype.hasOwnProperty.call(value, "policies")) return false;
    if (
      ["subject", "id", "failureMode", "algorithm", "bucket", "windows"].some(
        (key) => Object.prototype.hasOwnProperty.call(value, key),
      )
    )
      fail("policies", "Cannot mix singular and named declarations");
    if (
      !value.policies ||
      typeof value.policies !== "object" ||
      Array.isArray(value.policies)
    )
      fail("policies", "Policies must be a named map");
    return true;
  };
  const resolve = (
    base: RouteRateLimit | undefined,
    entry: RouteRateLimit,
    name: string,
    id: string,
  ) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return fail(name, "Policy must be an object");
    if (Object.prototype.hasOwnProperty.call(entry, "policies"))
      return fail(name, "Policies cannot be nested");
    const subject = entry.subject ?? base?.subject;
    const strategy =
      entry.algorithm !== undefined ||
      entry.bucket !== undefined ||
      entry.windows !== undefined
        ? entry
        : base;
    if (
      typeof subject !== "string" ||
      !subject.trim() ||
      !subjects.includes(subject) ||
      !strategy ||
      (strategy.algorithm === "sliding-window-log"
        ? !strategy.windows ||
          !Object.keys(strategy.windows).length ||
          strategy.bucket !== undefined
        : !strategy.bucket ||
          strategy.windows !== undefined ||
          (strategy.algorithm !== undefined &&
            strategy.algorithm !== "token-bucket"))
    )
      return fail(name, "Incomplete strategy or unknown subject");
    return {
      ...(strategy.algorithm === "sliding-window-log"
        ? {
            algorithm: "sliding-window-log" as const,
            windows: strategy.windows,
          }
        : { algorithm: "token-bucket" as const, bucket: strategy.bucket! }),
      subject,
      failureMode: entry.failureMode ?? base?.failureMode,
      id: entry.id ?? base?.id ?? id,
    };
  };
  const defaultsNamed = defaults && named(defaults);
  // Validate defaults even when every route disables admission.
  if (defaultsNamed) {
    const entries = Object.entries(
      (defaults as NamedRateLimitDefaults).policies,
    );
    if (!entries.length) fail("policies", "Defaults must contain a policy");
    for (const [name, entry] of entries) {
      validateName(name);
      resolve(undefined, entry, name, "");
    }
  }
  function validateName(name: string) {
    if (!name.trim() || !Number.isNaN(Number(name)))
      fail(name, "Policy names must be nonblank and nonnumeric");
  }
  if (override === false || (!defaults && override === undefined))
    return { resolvedRateLimit: undefined };
  const overrideNamed = override !== undefined && named(override);
  if (defaults && override !== undefined && !!defaultsNamed !== overrideNamed)
    fail("policies", "Cannot inherit between singular and named declarations");
  if (!defaultsNamed && !overrideNamed)
    return {
      resolvedRateLimit: resolve(
        defaults as RateLimitDefaults | undefined,
        (override ?? {}) as RouteRateLimit,
        "default",
        route,
      ),
    };

  const entries = new Map<string, RouteRateLimit>(
    Object.entries(
      (defaults as NamedRateLimitDefaults | undefined)?.policies ?? {},
    ),
  );
  for (const [name, entry] of Object.entries(
    (override as NamedRouteRateLimit | undefined)?.policies ?? {},
  )) {
    validateName(name);
    if (entry === false) {
      if (!entries.delete(name)) fail(name, "Cannot disable an unknown policy");
    } else {
      const base = entries.get(name);
      entries.set(
        name,
        resolve(
          base,
          entry,
          name,
          `rate-limit:${JSON.stringify([route, name])}`,
        ),
      );
    }
  }
  const ids = new Set<string>();
  const policies = Array.from(entries, ([name, entry]) => {
    const policy = resolve(
      undefined,
      entry,
      name,
      `rate-limit:${JSON.stringify([route, name])}`,
    );
    if (ids.has(policy.id))
      fail(name, `Duplicate effective policy ID: ${policy.id}`);
    ids.add(policy.id);
    return { ...policy, name };
  });
  return { resolvedRateLimits: policies };
}
