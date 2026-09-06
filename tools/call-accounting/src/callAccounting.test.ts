import path from "node:path";

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";

import { testCompilerOptions } from "@suss/test-project";

import {
  accountForProject,
  describeDrops,
  unaccountedCalls,
} from "./callAccounting.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * A dropped call this check has already looked at and decided is not a
 * bug, keyed the way `keyOf` spells one. Empty until one turns up.
 */
const EXEMPT: ReadonlySet<string> = new Set();

function resolveGlob(glob: string): string {
  return glob.startsWith("!")
    ? `!${path.join(REPO_ROOT, glob.slice(1))}`
    : path.join(REPO_ROOT, glob);
}

function projectOver(...globs: string[]): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      ...testCompilerOptions,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  });
  project.addSourceFilesAtPaths(globs.map(resolveGlob));
  return project;
}

describe("call accounting", () => {
  it("accounts for every call the invocation walk visits in the fixtures", () => {
    const project = projectOver("fixtures/**/*.ts", "fixtures/**/*.tsx");
    const results = accountForProject(project.getSourceFiles());
    const dropped = unaccountedCalls(results, EXEMPT);
    expect(dropped, describeDrops(dropped)).toEqual([]);
  });

  it("accounts for every call the invocation walk visits in suss's own packages", () => {
    const project = projectOver(
      "packages/**/src/**/*.ts",
      "!packages/**/src/**/*.test.ts",
      "!packages/**/src/**/*.d.ts",
      "!packages/**/dist/**",
    );
    const results = accountForProject(project.getSourceFiles());
    const dropped = unaccountedCalls(results, EXEMPT);
    expect(dropped, describeDrops(dropped)).toEqual([]);
  });
});
