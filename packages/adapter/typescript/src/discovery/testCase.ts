/**
 * Test cases written as nested calls, the style vitest, jest and mocha
 * share: `describe("orders", () => { it("cancels", () => ...) })`. Each
 * case is a unit named by its title path.
 *
 * The unit also records whether the case is skipped and what the test
 * replaces with a mock before it runs, so the intent pass can tell a
 * test that exercised its subject from one that replaced it.
 */

import path from "node:path";

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import { moduleImportedWholeAs, namedImportsOf } from "./importScan.js";
import { functionValueOf, stringValueOf } from "./resolveValue.js";

import type { TestMock } from "@suss/behavioral-ir";
import type { TestCaseMatch } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

/** What the titles in a test's name are joined with. */
export const TITLE_SEPARATOR = " > ";

interface RunnerCall {
  /** A group opens a suite of cases, and a case is one test. */
  role: "group" | "case";
  modifiers: string[];
  /** Set when a modifier such as `each` declares one case per row. */
  perRow: boolean;
}

export function discoverTestCases(
  sourceFile: SourceFile,
  match: TestCaseMatch,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  if (!isListed(sourceFile.getFilePath(), match.files)) {
    return [];
  }
  const spellings = runnerSpellings(sourceFile, match.importModule);
  if (spellings.size === 0) {
    return [];
  }

  const runnerCalls = new Map<CallExpression, RunnerCall>();
  const mockCalls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const runner = runnerCallOf(node, spellings, match);
    if (runner !== null) {
      runnerCalls.set(node, runner);
      return;
    }
    if (isMockCall(node, spellings, match)) {
      mockCalls.push(node);
    }
  });

  const mocks = mockCalls.map((call) => ({
    scope: enclosingRunnerCalls(call, runnerCalls),
    mock: mockOf(call, match, sourceFile, resolution),
  }));

  const units: DiscoveredUnit[] = [];
  for (const [call, runner] of runnerCalls) {
    if (runner.role !== "case") {
      continue;
    }
    units.push(
      caseUnit(call, runner, runnerCalls, mocks, match, kind, resolution),
    );
  }
  return units;
}

interface ScopedMock {
  /** The suites and cases the mock call is written inside. */
  scope: CallExpression[];
  mock: TestMock | null;
}

function caseUnit(
  call: CallExpression,
  runner: RunnerCall,
  runnerCalls: ReadonlyMap<CallExpression, RunnerCall>,
  mocks: readonly ScopedMock[],
  match: TestCaseMatch,
  kind: string,
  resolution: ResolutionStore | undefined,
): DiscoveredUnit {
  const suites = enclosingRunnerCalls(call, runnerCalls);
  const titles = [...suites, call].map((one) => titleOf(one, resolution));
  const skipped = [runner, ...suites.map((one) => runnerCalls.get(one))].some(
    (one) =>
      one?.modifiers.some((modifier) =>
        match.skipModifiers.includes(modifier),
      ) === true,
  );
  // A mock written at module scope, or in a suite around this case, or
  // in this case itself, is in force when the case runs.
  const inScope = new Set<CallExpression>([...suites, call]);
  const applying = mocks
    .filter((one) => one.scope.every((scope) => inScope.has(scope)))
    .map((one) => one.mock)
    .filter((mock): mock is TestMock => mock !== null);

  const unresolvedTitle = unresolvedTitleOf(titles, runner);
  const test = {
    ...(skipped ? { skipped: true } : {}),
    ...(applying.length > 0 ? { mocks: applying } : {}),
    ...(unresolvedTitle !== null ? { unresolvedTitle } : {}),
  };
  const func = caseFunction(call, resolution);
  return {
    ...(func === null ? { func: null, announcedAt: call } : { func }),
    kind,
    name: titles.map((title) => title.text).join(TITLE_SEPARATOR),
    nameKind: "label",
    metadata: { test },
  };
}

interface Title {
  text: string;
  unresolved: boolean;
}

/**
 * The first title that is not a string, or the case's own title when a
 * modifier like `each` fills it in per row. Null when every title reads.
 */
function unresolvedTitleOf(
  titles: readonly Title[],
  runner: RunnerCall,
): string | null {
  const unread = titles.find((title) => title.unresolved);
  if (unread !== undefined) {
    return unread.text;
  }
  if (runner.perRow) {
    return titles[titles.length - 1]?.text ?? null;
  }
  return null;
}

/** Whether the file is on the list, matched on whole segments from the end. */
function isListed(
  file: string,
  listed: readonly string[] | undefined,
): boolean {
  if (listed === undefined) {
    return true;
  }
  const whole = file.split(path.sep).join("/");
  return listed.some((entry) => {
    const tail = entry.split(path.sep).join("/").replace(/^\.\//, "");
    return whole === tail || whole.endsWith(`/${tail}`);
  });
}

/** Local spelling to the name the runner exports it as. */
function runnerSpellings(
  sourceFile: SourceFile,
  importModule: string,
): Map<string, string> {
  const spellings = new Map<string, string>();
  for (const one of namedImportsOf(sourceFile, [importModule])) {
    spellings.set(one.local, one.canonical);
  }
  return spellings;
}

/**
 * Whether this call opens a suite or declares a case, and with which
 * modifiers. `it.each(rows)` on its own returns the case function, so
 * only the call made on its result declares a case.
 */
function runnerCallOf(
  call: CallExpression,
  spellings: ReadonlyMap<string, string>,
  match: TestCaseMatch,
): RunnerCall | null {
  let callee = call.getExpression();
  let perRow = false;
  if (Node.isCallExpression(callee)) {
    const inner = callee.getExpression();
    if (
      !Node.isPropertyAccessExpression(inner) ||
      !takesArguments(inner.getName(), match)
    ) {
      return null;
    }
    perRow = match.rowModifiers.includes(inner.getName());
    callee = inner;
  } else if (
    Node.isPropertyAccessExpression(callee) &&
    takesArguments(callee.getName(), match)
  ) {
    return null;
  }

  const modifiers: string[] = [];
  while (Node.isPropertyAccessExpression(callee)) {
    modifiers.unshift(callee.getName());
    callee = callee.getExpression();
  }
  if (!Node.isIdentifier(callee)) {
    return null;
  }
  const canonical = spellings.get(callee.getText());
  const role = canonical === undefined ? null : roleOf(canonical, match);
  return role === null ? null : { role, modifiers, perRow };
}

function takesArguments(modifier: string, match: TestCaseMatch): boolean {
  return (
    match.argumentModifiers.includes(modifier) ||
    match.rowModifiers.includes(modifier)
  );
}

function roleOf(
  canonical: string,
  match: TestCaseMatch,
): RunnerCall["role"] | null {
  if (match.caseNames.includes(canonical)) {
    return "case";
  }
  if (match.suiteNames.includes(canonical)) {
    return "group";
  }
  return null;
}

/** The suites and cases around this node, outermost first. */
function enclosingRunnerCalls(
  node: Node,
  runnerCalls: ReadonlyMap<CallExpression, RunnerCall>,
): CallExpression[] {
  const found: CallExpression[] = [];
  for (let at = node.getParent(); at !== undefined; at = at.getParent()) {
    if (Node.isCallExpression(at) && runnerCalls.has(at)) {
      found.unshift(at);
    }
  }
  return found;
}

function titleOf(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): Title {
  const first = call.getArguments()[0];
  if (first === undefined) {
    return { text: "", unresolved: true };
  }
  const read = stringValueOf(first, resolution);
  return read === null
    ? { text: first.getText(), unresolved: true }
    : { text: read, unresolved: false };
}

/** The first argument after the title that is a function: `it(title, fn)` or `it(title, options, fn)`. */
function caseFunction(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): ReturnType<typeof functionValueOf> {
  for (const argument of call.getArguments().slice(1)) {
    const func = functionValueOf(argument, resolution);
    if (func !== null) {
      return func;
    }
  }
  return null;
}

/** The mock helper's method this call makes, as in `vi.mock`, or null. */
function mockMethodOf(
  call: CallExpression,
  spellings: ReadonlyMap<string, string>,
  match: TestCaseMatch,
): string | null {
  const callee = call.getExpression();
  if (match.mocks === undefined || !Node.isPropertyAccessExpression(callee)) {
    return null;
  }
  const object = callee.getExpression();
  if (
    !Node.isIdentifier(object) ||
    spellings.get(object.getText()) !== match.mocks.object
  ) {
    return null;
  }
  return callee.getName();
}

function isMockCall(
  call: CallExpression,
  spellings: ReadonlyMap<string, string>,
  match: TestCaseMatch,
): boolean {
  const method = mockMethodOf(call, spellings, match);
  if (method === null || match.mocks === undefined) {
    return false;
  }
  return (
    match.mocks.moduleMethods.includes(method) ||
    match.mocks.memberMethods.includes(method)
  );
}

/**
 * What one mock call replaces: a module given by its specifier, or a
 * member given by name. Null when the arguments are not strings the
 * adapter can read.
 */
function mockOf(
  call: CallExpression,
  match: TestCaseMatch,
  sourceFile: SourceFile,
  resolution: ResolutionStore | undefined,
): TestMock | null {
  const callee = call.getExpression();
  const [first, second] = call.getArguments();
  if (!Node.isPropertyAccessExpression(callee) || first === undefined) {
    return null;
  }
  const written = oneLine(call.getText());
  if (match.mocks?.moduleMethods.includes(callee.getName()) === true) {
    const specifier = stringValueOf(first, resolution);
    return specifier === null
      ? null
      : { module: moduleFileOf(sourceFile, specifier), written };
  }
  const name = second === undefined ? null : stringValueOf(second, resolution);
  if (name === null) {
    return null;
  }
  // A spy on a module imported whole replaces that module's member.
  const module = Node.isIdentifier(first)
    ? moduleImportedWholeAs(sourceFile, first.getText())
    : null;
  return { ...(module !== null ? { module } : {}), name, written };
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
