import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configInputs, configSetsGlobals } from "./config.js";
import { vitestFramework } from "./index.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "suss-vitest-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, text: string): void {
  fs.writeFileSync(path.join(dir, name), text);
}

describe("configSetsGlobals", () => {
  it("reads globals from the test block of the config vitest would read", () => {
    write(
      "vitest.config.ts",
      `import { defineConfig } from "vitest/config";
       export default defineConfig({ test: { globals: true, environment: "node" } });`,
    );

    expect(configSetsGlobals({ directory: dir })).toBe(true);
  });

  it("falls back to the vite config, as vitest does", () => {
    write("vite.config.mjs", `export default { test: { "globals": true } };`);

    expect(configSetsGlobals({ directory: dir })).toBe(true);
  });

  it("reads the vitest config ahead of the vite config", () => {
    write("vitest.config.mts", "export default { test: { globals: false } };");
    write("vite.config.ts", "export default { test: { globals: true } };");

    expect(configSetsGlobals({ directory: dir })).toBe(false);
  });

  it("counts only a globals written as true inside a test block", () => {
    write(
      "vitest.config.ts",
      `export default {
         globals: true,
         test: { globals: process.env.GLOBALS === "1" },
       };`,
    );

    expect(configSetsGlobals({ directory: dir })).toBe(false);
  });

  it("finds nothing set in a directory with no config", () => {
    expect(configSetsGlobals({ directory: dir })).toBe(false);
  });

  it("reads a config a package.json script hands vitest", () => {
    fs.mkdirSync(path.join(dir, "test"));
    write(
      "test/vitest.config.mjs",
      "export default defineConfig({ test: { globals: true } });",
    );
    write(
      "package.json",
      JSON.stringify({
        scripts: {
          test: "vitest --config test/vitest.config.mjs",
          lint: "eslint -c eslint.config.mjs",
        },
      }),
    );

    expect(configSetsGlobals({ directory: dir })).toBe(true);
    expect(configInputs({ directory: dir })).toContain(
      path.join(dir, "test/vitest.config.mjs"),
    );
  });

  it("reads the config a script passes quoted or with an equals sign", () => {
    write("unit.config.mjs", "export default { test: { globals: false } };");
    write("e2e.config.mjs", "export default { test: { globals: true } };");
    write(
      "package.json",
      JSON.stringify({
        scripts: {
          unit: "vitest -c 'unit.config.mjs'",
          e2e: 'vitest run --config="e2e.config.mjs"',
        },
      }),
    );

    expect(configSetsGlobals({ directory: dir })).toBe(true);
  });

  it("reads no scripts from a package.json it cannot parse, or one with none", () => {
    write("package.json", "{ not json");
    expect(configSetsGlobals({ directory: dir })).toBe(false);

    write("package.json", JSON.stringify({ name: "app" }));
    expect(configSetsGlobals({ directory: dir })).toBe(false);
  });
});

describe("the pack's globals", () => {
  it("turns on from the config in the directory the run reads, and keys the cache on it", () => {
    write("vitest.config.ts", "export default { test: { globals: true } };");

    const pack = vitestFramework({ configDirectory: dir });
    const match = pack.discovery[0]?.match;

    expect(match?.type === "testCase" && match.globalsIn).toEqual([
      "*.test.*",
      "*.spec.*",
    ]);
    expect(pack.discoveryInputs?.([])).toEqual(
      configInputs({ directory: dir }),
    );
  });

  it("reads only the config it is told to, against the run's directory", () => {
    fs.mkdirSync(path.join(dir, "tools"));
    write("tools/unit.mjs", "export default { test: { globals: true } };");
    write("vitest.config.ts", "export default { test: { globals: false } };");

    const pack = vitestFramework({
      configDirectory: dir,
      config: "tools/unit.mjs",
    });
    const match = pack.discovery[0]?.match;

    expect(match?.type === "testCase" && match.globalsIn).toEqual([
      "*.test.*",
      "*.spec.*",
    ]);
    expect(pack.discoveryInputs?.([])).toEqual([
      path.join(dir, "tools/unit.mjs"),
    ]);
  });

  it("follows the option over the config", () => {
    write("vitest.config.ts", "export default { test: { globals: true } };");

    const match = vitestFramework({ configDirectory: dir, globals: false })
      .discovery[0]?.match;

    expect(match?.type === "testCase" && match.globalsIn).toBe(undefined);
  });
});
