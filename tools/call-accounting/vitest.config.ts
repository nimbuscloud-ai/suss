import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The self-run parses every TypeScript file this workspace ships.
    testTimeout: 120_000,
  },
});
