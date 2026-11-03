// What every workspace package's vitest.config.ts starts from. A package that
// reports coverage calls packageConfig. The tools and plugins call toolConfig,
// which leaves coverage at vitest's defaults.

import {
  defineConfig,
  type TestUserConfig,
  type ViteUserConfig,
} from "vitest/config";

type Coverage = NonNullable<TestUserConfig["coverage"]>;
type Thresholds = NonNullable<Coverage["thresholds"]>;

// A test that extracts a fixture takes 5 to 7 seconds on a slow CI runner,
// which is past vitest's default of 5.
const TEST_TIMEOUT_MS = 20_000;

const DEFAULT_THRESHOLDS: Thresholds = {
  lines: 80,
  functions: 80,
  branches: 75,
  statements: 80,
};

interface PackageOptions extends Omit<TestUserConfig, "coverage"> {
  // Replaces single numbers in the default thresholds. A file path as a key
  // adds a floor for that file.
  thresholds?: Thresholds;
  // Added to the files coverage already leaves out.
  coverageExclude?: string[];
}

export function toolConfig(test: TestUserConfig = {}): ViteUserConfig {
  return defineConfig({
    test: {
      include: ["src/**/*.test.ts"],
      testTimeout: TEST_TIMEOUT_MS,
      ...test,
    },
  });
}

export function packageConfig(options: PackageOptions = {}): ViteUserConfig {
  const { thresholds, coverageExclude = [], ...test } = options;
  return toolConfig({
    ...test,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/dist/**",
        "**/*.config.ts",
        ...coverageExclude,
      ],
      thresholds: { ...DEFAULT_THRESHOLDS, ...thresholds },
    },
  });
}
