import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/setup.ts"],
    // A cold first spawn pays for loading the adapter and its WASM grammars.
    testTimeout: 120_000,
    // Nothing here imports a source file, so there is no coverage to collect.
  },
});
