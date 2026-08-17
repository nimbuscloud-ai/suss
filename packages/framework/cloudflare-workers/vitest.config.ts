import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Discovery tests build ts-morph projects, and the default 5s
    // ceiling flakes when the whole workspace suite runs in parallel on
    // a loaded runner.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        // Malformed-AST branches are defensive checks against shapes
        // ts-morph never produces; 70% covers the meaningful ones.
        branches: 70,
        statements: 80,
      },
    },
  },
});
