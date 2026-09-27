import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        // Many branches are defensive null/shape checks for AST inputs
        // ts-morph never actually produces; testing them adds little value.
        branches: 70,
        statements: 80,
      },
    },
  },
});
