import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The storybook and prisma tests run the whole extract, contract, and
    // check pipeline once per case. A few seconds each on their own, over
    // a minute with v8 coverage instrumentation on and every test file
    // competing for cores, which is the slowest this ever gets.
    testTimeout: 180_000,
    // The prisma tests generate a client in beforeAll, which outruns the
    // 10s default hook timeout on a loaded machine.
    hookTimeout: 180_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      // bin.ts is the side-effect entry point that wires runCli to
      // process.exit: exercised in production but not in vitest because
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
