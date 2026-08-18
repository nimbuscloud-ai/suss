import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Every case runs a whole extraction, and the first one in a worker
    // pays for parsing the default libraries.
    testTimeout: 60_000,
  },
});
