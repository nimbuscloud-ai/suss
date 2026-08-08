import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Property-based extraction runs build a fresh ts-morph project per
    // generated program; give the fuzz suites generous headroom.
    testTimeout: 120_000,
    coverage: {
      provider: "v8",
      // text only: no json-summary. This package deliberately stays out
      // of the committed-coverage / badge / regression-gate machinery
      // (scripts/coverage-packages.mjs); emitting coverage-summary.json
      // would get it auto-committed by CI's refresh step.
      reporter: ["text"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts"],
    },
  },
});
