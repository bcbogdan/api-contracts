import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("browser boundaries", () => {
  it.each(["src/contract.ts", "src/client.ts"])(
    "bundles %s without server dependencies",
    (entry) => {
      const output = execFileSync("bun", ["build", entry, "--target=browser"], {
        encoding: "utf8",
      });
      expect(output).not.toMatch(
        /@nestjs|@opentelemetry|RateLimitInterceptor|RateLimitError|node:|createClient\(.*redis/,
      );
    },
  );
});
