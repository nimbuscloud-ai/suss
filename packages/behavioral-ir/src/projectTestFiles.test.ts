// Which files on disk a run reads as test code, measured from the top
// of each project a file is in.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  isTestFileIn,
  readTestFilesFrom,
  testFilesUnder,
} from "./projectTestFiles.js";

const made: string[] = [];

/** A folder with these files in it, each empty. */
function folderWith(...files: string[]): string {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "suss-test-files-")),
  );
  made.push(root);
  for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  }
  return root;
}

afterEach(() => {
  for (const root of made.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("testFilesUnder", () => {
  it("reads a test folder at the top of the run's root", () => {
    const root = folderWith("package.json");
    const isTest = testFilesUnder(root);

    expect(isTest(path.join(root, "test/app.js"))).toBe(true);
    expect(isTest(path.join(root, "src/routes.ts"))).toBe(false);
    expect(isTest(path.join(root, "app/api/test/route.ts"))).toBe(false);
  });

  it("reads a relative path from the run's root", () => {
    const isTest = testFilesUnder(folderWith("package.json"));

    expect(isTest("test/app.js")).toBe(true);
    expect(isTest("app/api/test/route.ts")).toBe(false);
  });

  it("reads the run's root as the top of a project with no manifest", () => {
    const root = folderWith();

    expect(testFilesUnder(root)(path.join(root, "tests/factories.py"))).toBe(
      true,
    );
  });

  it.each([
    ["packages/api/package.json", "packages/api/test/app.js"],
    ["services/api/pyproject.toml", "services/api/tests/factories.py"],
    ["engines/billing/billing.gemspec", "engines/billing/spec/support/a.rb"],
    ["modules/auth/Gemfile", "modules/auth/spec/spec_helper.rb"],
    ["tools/cli/setup.cfg", "tools/cli/tests/utils.py"],
  ])(
    "reads a test folder at the top of a project under %s",
    (manifest, file) => {
      const root = folderWith("package.json", manifest);

      expect(testFilesUnder(root)(path.join(root, file))).toBe(true);
    },
  );

  it("keeps a sample app under a test folder as test code", () => {
    const root = folderWith(
      "package.json",
      "packages/api/package.json",
      "packages/api/test/fixtures/app/package.json",
    );
    const isTest = testFilesUnder(root);

    expect(
      isTest(path.join(root, "packages/api/test/fixtures/app/src/routes.ts")),
    ).toBe(true);
    expect(isTest(path.join(root, "packages/api/src/routes.ts"))).toBe(false);
  });

  it("leaves out a folder named like a test folder above the run's root", () => {
    const outer = folderWith("package.json");
    const root = path.join(outer, "testing", "app");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), "");

    expect(testFilesUnder(root)(path.join(root, "src/routes.ts"))).toBe(false);
  });

  it("reads a file outside the root from the projects above it", () => {
    const repository = folderWith(
      ".git",
      "package.json",
      "api/package.json",
      "shared/package.json",
    );
    const isTest = testFilesUnder(path.join(repository, "api"));

    expect(isTest(path.join(repository, "shared/test/helpers.ts"))).toBe(true);
    expect(isTest(path.join(repository, "shared/src/helpers.ts"))).toBe(false);
  });

  it("stops at the top of the repository a file outside the root is in", () => {
    const outer = folderWith("package.json", "test/repo/.git");
    const repository = path.join(outer, "test", "repo");
    const isTest = testFilesUnder(path.join(repository, "api"));

    expect(isTest(path.join(repository, "shared/src/helpers.ts"))).toBe(false);
  });
});

describe("isTestFileIn", () => {
  it("measures from the root a run was given", () => {
    const root = folderWith("package.json");
    const run = {};
    readTestFilesFrom(run, root);

    expect(isTestFileIn(run, path.join(root, "test/app.js"))).toBe(true);
  });

  it("reads the path as given for a run with no root", () => {
    expect(isTestFileIn({}, "/repo/test/app.js")).toBe(false);
    expect(isTestFileIn({}, "/repo/src/app.test.ts")).toBe(true);
  });
});
