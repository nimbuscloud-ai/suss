import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/setup.ts"],
    // Every test spawns the built binary at least once, and a cold
    // first spawn pays for loading the adapter and its WASM grammars.
    testTimeout: 120_000,
    // No coverage config: nothing here imports a source file, so there
    // is nothing for v8 to measure. What this package covers is the
    // binary, and a subprocess records no coverage for its parent.
  },
});
