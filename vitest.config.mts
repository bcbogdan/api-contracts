import { defineConfig } from "vitest/config";
import ts from "typescript";

export default defineConfig({
  plugins: [
    {
      name: "legacy-typescript-decorators",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith(".ts") || id.includes("/node_modules/")) return;
        const result = ts.transpileModule(code, {
          fileName: id,
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            sourceMap: true,
          },
        });
        return { code: result.outputText, map: result.sourceMapText };
      },
    },
  ],
  resolve: { alias: { "@": new URL("./src", import.meta.url).pathname } },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
