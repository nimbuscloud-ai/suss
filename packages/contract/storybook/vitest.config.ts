import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Each test spins up a fresh ts-morph Project to parse the CSF file.
    // Locally this is ~250ms; on CI runners it can hit 5-6s, which busts
    // vitest's default 5000ms per-test timeout. Bump to 30s to cover CI.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        // Defensive "return null" branches in the CSF unwrap helpers
        // (AsExpression fallback, undefined-symbol guards) aren't
        // hit by the current fixture set. They exist because ts-morph
        // can hand back any expression kind, and covering them all
        // would require contrived fixtures with no behavioral value.
        branches: 60,
        statements: 80,
      },
    },
  },
});
