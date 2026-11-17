/**
 * Test cases a runner writes as calls, `describe("orders", () => {
 * it("cancels", () => ...) })`, as `@suss/recognize` finds them through
 * this adapter's module ops. Each case becomes a unit named by its
 * titles. The unit also records whether the case is skipped and what the
 * test replaces with a mock before it runs, so the intent pass can tell
 * a test that exercised its subject from one that replaced it.
 *
 * What stays here is TypeScript's module resolution: a mocked specifier
 * becomes the project file the runner loads, and a spy on a module
 * imported whole gives that module.
 */

import path from "node:path";

import { testUnitName } from "@suss/behavioral-ir";
import { discoverTestCases } from "@suss/recognize";

import { moduleOpsFor } from "./declared.js";
import { moduleImportedWholeAs } from "./importScan.js";
import { toFunctionRoot } from "./shared.js";

import type { TestMock } from "@suss/behavioral-ir";
import type { TestCasesMatch } from "@suss/extractor";
import type { FoundCase, FoundMock } from "@suss/recognize";
import type { Node, SourceFile } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

export function discoverTestCasesIn(
  sourceFile: SourceFile,
  match: TestCasesMatch,
  kind: string,
  store: ResolutionStore,
): DiscoveredUnit[] {
  const nodeOf = (key: string): Node | undefined =>
    store.factAccess().nodeOf(key);
  return discoverTestCases(match, moduleOpsFor(sourceFile, store)).map(
    (found) => caseUnit(found, kind, sourceFile, nodeOf),
  );
}

function caseUnit(
  found: FoundCase,
  kind: string,
  sourceFile: SourceFile,
  nodeOf: (key: string) => Node | undefined,
): DiscoveredUnit {
  const mocks = found.mocks.flatMap((mock) => {
    const one = mockOf(mock, sourceFile, nodeOf);
    return one === null ? [] : [one];
  });
  // The first title that is not a string, or a case's own title when a
  // modifier like `each` fills it in per row.
  const unresolvedTitle = found.titles.find((title) => title.unresolved);
  const test = {
    ...(found.skipped ? { skipped: true } : {}),
    ...(mocks.length > 0 ? { mocks } : {}),
    ...(unresolvedTitle !== undefined
      ? { unresolvedTitle: unresolvedTitle.text }
      : {}),
  };
  return {
    ...placeOf(found, nodeOf),
    kind,
    name: testUnitName(found.titles.map((title) => title.text)),
    nameKind: "label",
    metadata: { test },
  };
}

/** The function the case runs, or the call it is written as when it passes none. */
function placeOf(
  found: FoundCase,
  nodeOf: (key: string) => Node | undefined,
): Pick<DiscoveredUnit, "func" | "announcedAt"> {
  const runs = found.runs?.site?.();
  const fn = runs === undefined ? undefined : nodeOf(runs);
  const func = fn === undefined ? null : toFunctionRoot(fn);
  if (func !== null) {
    return { func };
  }
  const call = nodeOf(found.at);
  return call === undefined
    ? { func: null }
    : { func: null, announcedAt: call };
}

/**
 * What one mock call replaces: a module given by its specifier, or a
 * member given by name, with the module when the object is one the file
 * imports whole.
 */
function mockOf(
  { call, read }: FoundMock,
  sourceFile: SourceFile,
  nodeOf: (key: string) => Node | undefined,
): TestMock | null {
  const site = call.site?.();
  const node = site === undefined ? undefined : nodeOf(site);
  if (node === undefined) {
    return null;
  }
  const written = oneLine(node.getText());
  if (read.replaces === "path") {
    return { module: moduleFileOf(sourceFile, read.path), written };
  }
  const object = call.valueAt(read.of);
  const local = object?.form?.() === "name" ? object.source?.() : undefined;
  const module =
    local === undefined ? null : moduleImportedWholeAs(sourceFile, local);
  return {
    ...(module !== null ? { module } : {}),
    name: read.member,
    written,
  };
}

/** The call as a finding quotes it, on one line and without a factory body. */
function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, "");
  const factory = flat.search(/,\s*(async\s*)?\(/);
  return factory === -1 ? flat : `${flat.slice(0, factory)})`;
}

/** What a relative specifier can resolve to, after its extension is dropped. */
const MODULE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/**
 * The project file a specifier points at, relative to the test file, the
 * way the runner resolves a mock. A package specifier, or one no
 * project file matches, stays as written.
 */
function moduleFileOf(sourceFile: SourceFile, specifier: string): string {
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const base = path.resolve(
    path.dirname(sourceFile.getFilePath()),
    specifier.replace(/\.(js|jsx|mjs|cjs)$/, ""),
  );
  const project = sourceFile.getProject();
  for (const suffix of MODULE_SUFFIXES) {
    const found = project.getSourceFile(`${base}${suffix}`);
    if (found !== undefined) {
      return found.getFilePath();
    }
  }
  return specifier;
}
