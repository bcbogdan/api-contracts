import {
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type FactoryProvider,
  type ModuleMetadata,
  type OnModuleInit,
  type Provider,
} from "@nestjs/common";
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
} from "@nestjs/core";
import { RateLimitError } from "../errors";
import {
  RATE_LIMIT_METADATA,
  RATE_LIMIT_OPTIONS,
} from "../rate-limit.constants";
import type { RouteRateLimitMetadata } from "../types";
import { RateLimitInterceptor } from "./rate-limit.interceptor";
import {
  RateLimitService,
  type RateLimitModuleOptions,
} from "./rate-limit.service";

@Injectable()
class RateLimitBindings implements OnModuleInit {
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(RateLimitService) private readonly service: RateLimitService | null,
  ) {}
  onModuleInit() {
    const policies = new Map<string, string>();
    const scanner = new MetadataScanner();
    for (const controller of this.discovery.getControllers()) {
      if (!controller.instance) continue;
      const prototype = Object.getPrototypeOf(controller.instance) as Record<
        string,
        object
      >;
      for (const method of scanner.getAllMethodNames(prototype)) {
        const metadata = Reflect.getMetadata(
          RATE_LIMIT_METADATA,
          prototype[method],
        ) as RouteRateLimitMetadata | undefined;
        if (!metadata) continue;
        if (!this.service)
          throw new RateLimitError(
            "CONFIGURATION",
            "Rate limited routes require a configured store",
          );
        const bound = this.service.validateRoute(metadata);
        for (const policy of "policy" in bound
          ? [bound.policy]
          : bound.policies) {
          // Compare route-defined settings: a shared policy ID must represent the same quota on every route.
          const signature = JSON.stringify([
            policy.subject,
            policy.algorithm,
            policy.algorithm === "sliding-window-log"
              ? Object.entries(policy.windows)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([name, window]) => [
                    name,
                    window.limit,
                    window.windowSeconds,
                  ])
              : [
                  policy.bucket.capacity,
                  policy.bucket.refill.tokens,
                  policy.bucket.refill.intervalSeconds,
                ],
            policy.failureMode ?? this.service.options.failureMode ?? "closed",
          ]);
          if (
            policies.has(policy.id) &&
            policies.get(policy.id) !== signature
          ) {
            throw new RateLimitError(
              "CONFIGURATION",
              `Inconsistent shared policy: ${policy.id}`,
            );
          }
          policies.set(policy.id, signature);
        }
      }
    }
  }
}

@Module({})
export class RateLimitModule {
  static register<Request, Subject extends string>(
    // The vocabulary must come from the contract, never from whichever resolvers happen to be supplied.
    options: RateLimitModuleOptions<Request, NoInfer<Subject>> &
      (string extends Subject ? never : unknown),
  ): DynamicModule {
    return this.configure({ provide: RATE_LIMIT_OPTIONS, useValue: options });
  }

  static registerAsync<Request, Subject extends string>(
    options: Pick<
      FactoryProvider<RateLimitModuleOptions<Request, NoInfer<Subject>> | null>,
      "inject" | "useFactory"
    > &
      Pick<ModuleMetadata, "imports"> &
      (string extends Subject ? never : unknown),
  ): DynamicModule {
    return this.configure(
      {
        provide: RATE_LIMIT_OPTIONS,
        inject: options.inject,
        useFactory: options.useFactory,
      },
      options.imports,
    );
  }

  private static configure(
    optionsProvider: Provider,
    imports: ModuleMetadata["imports"] = [],
  ): DynamicModule {
    return {
      module: RateLimitModule,
      global: true,
      imports: [DiscoveryModule, ...imports],
      providers: [
        optionsProvider,
        {
          provide: RateLimitService,
          inject: [RATE_LIMIT_OPTIONS],
          useFactory: (
            options: RateLimitModuleOptions<unknown, string> | null,
          ) => (options === null ? null : new RateLimitService(options)),
        },
        RateLimitInterceptor,
        RateLimitBindings,
      ],
      exports: [RateLimitService, RateLimitInterceptor],
    };
  }
}
