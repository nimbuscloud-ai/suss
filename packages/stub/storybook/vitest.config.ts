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
