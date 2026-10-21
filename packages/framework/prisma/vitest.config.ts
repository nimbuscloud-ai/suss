import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The schema tests build a ts-morph project each and take 3 to 8 seconds
    // on a CI runner, past vitest's default of 5.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        // Many recognizer branches are defensive null/shape checks for
        // malformed AST inputs that real ts-morph never produces.
        branches: 70,
        statements: 80,
      },
    },
  },
});
