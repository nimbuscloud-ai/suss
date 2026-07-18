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
        // Filesystem-walk and malformed-template branches are defensive
        // paths that the fixture doesn't exercise; 70% covers the
        // meaningful discovery + extraction logic.
        branches: 70,
        statements: 80,
      },
    },
  },
});
