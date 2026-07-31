import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Discovery tests build real ts-morph projects with on-disk
    // template fixtures and take 1.5-3s each on an idle machine. The
    // default 5s ceiling flakes when the full workspace suite runs in
    // parallel on a loaded CI runner; the margin covers contention,
    // not slower code.
    testTimeout: 20000,
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
