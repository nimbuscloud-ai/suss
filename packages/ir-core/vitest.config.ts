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
        branches: 75,
        statements: 80,
        // The branches in these files are the tool's claims about
        // boundary identity, so each file carries its own floor and
        // cannot hide behind the package aggregate (#124).
        "src/boundaryKey.ts": {
          branches: 90,
          lines: 95,
        },
      },
    },
  },
});
