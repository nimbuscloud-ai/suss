import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 90_000,
    include: ["src/**/*.test.ts"],
    isolate: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts"],
      thresholds: {
        lines: 76,
        functions: 80,
        branches: 72,
        statements: 76,
      },
    },
  },
});
