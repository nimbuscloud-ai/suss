import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // storybook-integration.test runs the full extract + stub + check
    // pipeline for each case — ~3s locally, several seconds slower on CI
    // runners. Default 5s timeout busts on CI; 30s gives headroom.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // bin.ts is the side-effect entry point that wires runCli to
      // process.exit — exercised in production but not in vitest because
      // importing it would terminate the test process. The dispatch logic
      // is fully covered via runCli in run.ts.
      exclude: ["**/*.test.ts", "**/dist/**", "**/*.config.ts", "src/bin.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
