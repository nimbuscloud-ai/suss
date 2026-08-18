import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The sweep runs four thousand fixpoints in one case.
    testTimeout: 300_000,
  },
});
