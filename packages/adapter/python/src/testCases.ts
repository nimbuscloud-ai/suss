/**
 * pytest tests as `test` units, so a PRD scenario can say which test
 * covers it. The pack declares which functions and methods pytest
 * collects, and `@suss/recognize` reads them through the module ops,
 * each named by its classes and then its own name, the way a pytest node
 * id writes them.
 *
 * pytest calls the fixtures a test asks for, by parameter name or through
 * a `usefixtures` marker, and the module's and classes' setup, before the
 * test runs. The index reports those as implied calls, so the reach walk
 * follows a test into them the way it follows any call. A test's mocks
 * are the patchers written on it, in its body, and in everything it runs
 * through. DESIGN.md says what is left out.
 */

import path from "node:path";

import { testUnitName } from "@suss/behavioral-ir";
import { caseRuns, collectsFile, discoverTestCases } from "@suss/recognize";
import {
  fileOfKey,
  isObserved,
  noteFileMissing,
  noteKeyRead,
} from "@suss/resolution";
import { constantOf, literalOf } from "@suss/values";

import { children, field, isFunction, parameterNameAndType } from "./ast.js";
import { pythonModuleOps } from "./declaredDiscovery.js";
import { originsOf } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";
import { resolveAbsoluteModule } from "./moduleResolver.js";
import { bodyCalls } from "./paths/effects.js";
import { libraryUnit } from "./reach/closure.js";
import { reachedFunctionOf } from "./reach/resolveCallee.js";
import { resolveName, scopeAt } from "./scope.js";
import { evaluatedValue, nodeOfResolutionKey } from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { TestMetadata, TestMock } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawCodeStructure, ValueOps } from "@suss/extractor";
import type { FoundCase } from "@suss/recognize";
import type { BoundPythonFile } from "./boundFiles.js";
import type { PyTestCases, PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { ImpliedCall, ReachOptions } from "./reach/closure.js";
import type { ReachedFunction } from "./reach/resolveCallee.js";

export interface TestIndexContext {
  readonly filesByPath: ReadonlyMap<string, BoundPythonFile>;
  /** The directories an absolute dotted path is resolved against. */
  readonly roots: string[];
  readonly facts: Database;
}

/** One collected test, with the classes around it, outermost first. */
interface CollectedTest {
  readonly node: PyNode;
  readonly titles: string[];
  readonly pattern: PyTestCases;
}

/** A test the walk reached, with the setup pytest calls before it. */
interface ReachedTest {
  readonly test: CollectedTest;
  readonly setUp: readonly ImpliedCall[];
}

interface Fixture {
  /** The name a test asks for it by, which the decorator can make differ from the function's. */
  readonly name: string;
  readonly target: ReachedFunction;
  readonly autouse: boolean;
}

type UnitOptions = Pick<ReachOptions, "storageFor" | "facts">;

/** The index for a run whose packs describe a test runner, or null when none does. */
export function pythonTestIndex(
  packs: readonly PythonPack[],
  context: TestIndexContext,
): PythonTestIndex | null {
  const patterns = packs.flatMap((pack) => pack.tests ?? []);
  return patterns.length === 0 ? null : new PythonTestIndex(patterns, context);
}

export class PythonTestIndex {
  private readonly reached = new Map<
    string,
    ReadonlyMap<string, ReachedTest>
  >();
  private readonly fixturesByScope = new Map<string, Map<string, Fixture>>();
  private readonly implied = new Map<string, readonly ImpliedCall[]>();

  constructor(
    private readonly patterns: readonly PyTestCases[],
    private readonly context: TestIndexContext,
  ) {}

  /** The tests in one file, when the file is collected and listed. */
  unitsIn(file: BoundPythonFile, options: UnitOptions): RawCodeStructure[] {
    const pattern = this.patternFor(file);
    if (pattern === null) {
      return [];
    }
    // The tests are kept as nodes before any unit is built, so the ops
    // they were read through go before the walk that builds each unit.
    const module = pythonModuleOps(file, this.context.facts);
    const tests = discoverTestCases(pattern.cases, module).flatMap((found) => {
      const test = collectedTest(file, found, pattern, this.context.facts);
      return test === null ? [] : [test];
    });
    return tests.map((test) => this.testUnit(file, test, options));
  }

  /**
   * Every test in one file the walk can reach, with its setup, by its
   * function's key. A file is read once, and only nodes are kept, since
   * the walk asks about each test until the run ends.
   */
  private reachedIn(file: BoundPythonFile): ReadonlyMap<string, ReachedTest> {
    const known = this.reached.get(file.file);
    // A recording cache has to see every file the answer reads, per charge.
    if (known !== undefined && !isObserved(this.context.facts)) {
      return known;
    }
    const found = new Map<string, ReachedTest>();
    this.reached.set(file.file, found);
    const pattern = this.patternFor(file);
    if (pattern === null) {
      return found;
    }
    const runs = caseRuns(pattern.cases, {
      module: pythonModuleOps(file, this.context.facts),
    });
    for (const [key, run] of runs) {
      const test = collectedTest(file, run.found, pattern, this.context.facts);
      if (test !== null) {
        found.set(key, {
          test,
          setUp: run.before.flatMap((fn) => this.impliedCallTo(fn)),
        });
      }
    }
    return found;
  }

  /** What pytest calls before this function runs, when it is a test or a fixture. */
  impliedCalls(source: ReachedFunction): readonly ImpliedCall[] {
    const key = functionKey(source);
    const known = this.implied.get(key);
    // A recording cache has to see every file the answer reads, per charge.
    if (known !== undefined && !isObserved(this.context.facts)) {
      return known;
    }
    const found = this.impliedCallsOf(source);
    this.implied.set(key, found);
    return found;
  }

  private impliedCallsOf(source: ReachedFunction): ImpliedCall[] {
    const reached = this.testAt(source);
    const pattern = reached?.test.pattern ?? this.fixturePatternOf(source);
    if (pattern === null) {
      return [];
    }
    const asked = parameterNames(source.node).filter(
      (name) => !pattern.reservedParameters.includes(name),
    );
    const calls = asked.flatMap((name): ImpliedCall[] => {
      const fixture = this.fixtureFor(source, name, pattern);
      return fixture === null ? [] : [{ callee: name, target: fixture.target }];
    });
    if (reached === null) {
      return calls;
    }
    const autouse = this.autouseFor(source, pattern).filter(
      ({ callee }) => !asked.includes(callee),
    );
    const marked = this.usedFixtures(source, reached.test).filter(
      ({ callee }) =>
        !asked.includes(callee) &&
        !autouse.some((one) => one.callee === callee),
    );
    return [...autouse, ...marked, ...reached.setUp, ...calls];
  }

  /** The fixtures a `usefixtures` marker on the test, a class around it, or a `pytestmark` asks for. */
  private usedFixtures(
    source: ReachedFunction,
    test: CollectedTest,
  ): ImpliedCall[] {
    const names = markersOn(source.file, test)
      .filter(
        (marker) =>
          marker.type === "call" &&
          test.pattern.usesFixtureMarkers.includes(
            dottedOrigin(calleeOf(marker), source.file) ?? "",
          ),
      )
      .flatMap((marker) =>
        positionalArguments(marker).flatMap((arg) => {
          const name = literalOf(evaluatedValue(arg, this.context.facts));
          return name === null ? [] : [name];
        }),
      );
    return [...new Set(names)].flatMap((name): ImpliedCall[] => {
      const fixture = this.fixtureFor(source, name, test.pattern);
      return fixture === null ? [] : [{ callee: name, target: fixture.target }];
    });
  }

  private testUnit(
    file: BoundPythonFile,
    test: CollectedTest,
    options: UnitOptions,
  ): RawCodeStructure {
    const raw = libraryUnit(reachedFunctionOf(file, test.node), {
      ...options,
      tests: this,
    });
    const skipped = this.isSkipped(file, test);
    const mocks = this.mocksOf(file, test);
    const metadata: TestMetadata = {
      ...(skipped ? { skipped: true } : {}),
      ...(mocks.length > 0 ? { mocks } : {}),
    };
    return {
      ...raw,
      identity: {
        ...raw.identity,
        name: testUnitName(test.titles),
        nameKind: "label",
        kind: "test",
        exportName: null,
        exportPath: null,
      },
      boundaryBinding: null,
      test: metadata,
    };
  }

  private patternFor(file: BoundPythonFile): PyTestCases | null {
    return (
      this.patterns.find((pattern) => collectsFile(pattern.cases, file.file)) ??
      null
    );
  }

  /** The project class a base class expression refers to, in this file or through an import. */
  private projectClassOf(
    expr: PyNode,
    file: BoundPythonFile,
  ): { file: BoundPythonFile; node: PyNode } | null {
    if (expr.type !== "identifier") {
      return null;
    }
    const binding = resolveName(scopeAt(expr, file.module), expr.text);
    if (binding?.kind === "classDef") {
      return { file, node: binding.node };
    }
    if (binding?.kind !== "importFrom") {
      return null;
    }
    for (const origin of originsOf(
      this.context.facts,
      `${file.file}#${expr.text}`,
    )) {
      const defining = this.context.filesByPath.get(origin.module);
      const found = defining?.module.moduleScope.bindings.get(origin.name);
      if (defining !== undefined && found?.kind === "classDef") {
        noteKeyRead(this.context.facts, defining.file);
        return { file: defining, node: found.node };
      }
    }
    return null;
  }

  /** The collected test this function is, with the setup pytest calls first, or null. */
  private testAt(source: ReachedFunction): ReachedTest | null {
    return this.reachedIn(source.file).get(functionKey(source)) ?? null;
  }

  /** A function the runner calls, as the walk follows a call to it, under the name it is written with. */
  private impliedCallTo(fn: ValueOps): ImpliedCall[] {
    const key = fn.site?.();
    if (key === undefined) {
      return [];
    }
    const file = this.context.filesByPath.get(fileOfKey(key));
    const node = nodeOfResolutionKey(key, this.context.facts);
    const name = node === null ? undefined : field(node, "name")?.text;
    return file === undefined || node === null || name === undefined
      ? []
      : [{ callee: name, target: reachedFunctionOf(file, node) }];
  }

  /** The pattern whose fixture decorator is on this function, or null when it is not a fixture. */
  private fixturePatternOf(source: ReachedFunction): PyTestCases | null {
    const decorators = decoratorsOf(source.node);
    if (decorators.length === 0) {
      return null;
    }
    return (
      this.patterns.find((pattern) =>
        decorators.some((decorator) =>
          pattern.fixtureDecorators.includes(
            dottedOrigin(calleeOf(decorator), source.file) ?? "",
          ),
        ),
      ) ?? null
    );
  }

  /**
   * The fixture a parameter asks for: one on an enclosing class, then one
   * the module defines or imports, then one in a shared fixture file in
   * each directory from the file's own up. A fixture that asks for its own
   * name gets the next one out, the way pytest overrides a fixture.
   */
  private fixtureFor(
    requester: ReachedFunction,
    name: string,
    pattern: PyTestCases,
  ): Fixture | null {
    const requesterKey = functionKey(requester);
    for (const fixture of this.fixturesInScope(
      requester.file,
      requester.node,
      pattern,
      name,
    )) {
      if (functionKey(fixture.target) !== requesterKey) {
        return fixture;
      }
    }
    return null;
  }

  private *fixturesInScope(
    file: BoundPythonFile,
    node: PyNode,
    pattern: PyTestCases,
    name: string,
  ): Generator<Fixture> {
    for (const classNode of enclosingClasses(node)) {
      const own = this.fixturesDeclaredIn(file, classNode, pattern).get(name);
      if (own !== undefined) {
        yield own;
      }
    }
    for (const module of this.modulesInScope(file, pattern)) {
      const found = this.moduleFixture(module, name, pattern);
      if (found !== null) {
        yield found;
      }
    }
  }

  /** The test's own module, then each shared fixture file from its directory up. */
  private *modulesInScope(
    file: BoundPythonFile,
    pattern: PyTestCases,
  ): Generator<BoundPythonFile> {
    yield file;
    let dir = path.dirname(file.file);
    for (;;) {
      for (const shared of pattern.sharedFixtureFiles) {
        const sharedPath = path.join(dir, shared);
        const found = this.context.filesByPath.get(sharedPath);
        if (found === undefined) {
          noteFileMissing(this.context.facts, sharedPath);
        } else if (found !== file) {
          yield found;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        return;
      }
      dir = parent;
    }
  }

  /** A fixture the module declares, or imports from a project file that declares it. */
  private moduleFixture(
    module: BoundPythonFile,
    name: string,
    pattern: PyTestCases,
  ): Fixture | null {
    const own = this.fixturesDeclaredIn(module, module.root, pattern).get(name);
    if (own !== undefined) {
      return own;
    }
    // pytest registers an imported fixture under the name its decorator
    // gives it, whatever the import calls it, so every import is looked at.
    for (const [local, binding] of module.module.moduleScope.bindings) {
      if (binding.kind !== "importFrom") {
        continue;
      }
      const found = this.importedFixture(module, local, pattern);
      if (found?.name === name) {
        return found;
      }
    }
    return null;
  }

  /** The fixture an imported name is, when a project file declares it. */
  private importedFixture(
    module: BoundPythonFile,
    local: string,
    pattern: PyTestCases,
  ): Fixture | null {
    for (const origin of originsOf(
      this.context.facts,
      `${module.file}#${local}`,
    )) {
      const defining = this.context.filesByPath.get(origin.module);
      if (defining === undefined) {
        continue;
      }
      const declared = this.fixturesDeclaredIn(
        defining,
        defining.root,
        pattern,
      );
      const found = [...declared.values()].find(
        (fixture) => fixture.target.name === origin.name,
      );
      if (found !== undefined) {
        return found;
      }
    }
    return null;
  }

  /** The fixtures a module or class body declares, by the name a test asks for them under. */
  private fixturesDeclaredIn(
    file: BoundPythonFile,
    container: PyNode,
    pattern: PyTestCases,
  ): Map<string, Fixture> {
    // The caller reads this file's syntax, so a cache recording what the
    // caller depends on is told about it each time, cached answer or not.
    noteKeyRead(this.context.facts, file.file);
    const scopeKey = nodeId(file.file, container);
    const known = this.fixturesByScope.get(scopeKey);
    if (known !== undefined) {
      return known;
    }
    const found = new Map<string, Fixture>();
    for (const definition of definitionsIn(container)) {
      const declared = isFunction(definition)
        ? fixtureDeclaration(definition, file, pattern, this.context.facts)
        : null;
      if (declared === null) {
        continue;
      }
      found.set(declared.name, {
        name: declared.name,
        target: reachedFunctionOf(file, definition),
        autouse: declared.autouse,
      });
    }
    this.fixturesByScope.set(scopeKey, found);
    return found;
  }

  /** Every autouse fixture in scope for a test, the nearest of each name. */
  private autouseFor(
    source: ReachedFunction,
    pattern: PyTestCases,
  ): ImpliedCall[] {
    const byName = new Map<string, ImpliedCall>();
    const scopes: Array<[BoundPythonFile, PyNode]> = [
      ...enclosingClasses(source.node).map(
        (classNode): [BoundPythonFile, PyNode] => [source.file, classNode],
      ),
      ...[...this.modulesInScope(source.file, pattern)].map(
        (module): [BoundPythonFile, PyNode] => [module, module.root],
      ),
    ];
    for (const [file, container] of scopes) {
      for (const [name, fixture] of this.fixturesDeclaredIn(
        file,
        container,
        pattern,
      )) {
        if (fixture.autouse && !byName.has(name)) {
          byName.set(name, { callee: name, target: fixture.target });
        }
      }
    }
    return [...byName.values()];
  }

  private isSkipped(file: BoundPythonFile, test: CollectedTest): boolean {
    return markersOn(file, test).some((marker) =>
      test.pattern.skipDecorators.includes(
        dottedOrigin(calleeOf(marker), file) ?? "",
      ),
    );
  }

  /** The mocks written on the test and its classes, in its body, and in each fixture and `setUp` it runs through. */
  private mocksOf(file: BoundPythonFile, test: CollectedTest): TestMock[] {
    const pattern = test.pattern;
    const onTest = [test.node, ...enclosingClasses(test.node)].flatMap((node) =>
      decoratorsOf(node).map((decorator) => ({
        file,
        owner: test.node,
        call: decorator,
      })),
    );
    const inBodies = this.bodiesRunBy(
      reachedFunctionOf(file, test.node),
    ).flatMap((fn) => [
      ...decoratorsOf(fn.node).map((call) => ({
        file: fn.file,
        owner: fn.node,
        call,
      })),
      ...callsIn(fn.node, this.context.facts).map((call) => ({
        file: fn.file,
        owner: fn.node,
        call,
      })),
    ]);
    const mocks: TestMock[] = [];
    const seen = new Set<string>();
    for (const site of [...onTest, ...inBodies]) {
      if (!this.isPatcher(site.call, site.file, site.owner, pattern)) {
        continue;
      }
      const mock = this.mockOf(site.call, site.file);
      if (mock !== null && !seen.has(mock.written)) {
        seen.add(mock.written);
        mocks.push(mock);
      }
    }
    return mocks;
  }

  /** The test itself, then every fixture and `setUp` it runs through, each once. */
  private bodiesRunBy(start: ReachedFunction): ReachedFunction[] {
    const found: ReachedFunction[] = [];
    const seen = new Set<string>();
    const visit = (fn: ReachedFunction): void => {
      const key = functionKey(fn);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      found.push(fn);
      for (const implied of this.impliedCalls(fn)) {
        visit(implied.target);
      }
    };
    visit(start);
    return found;
  }

  /** Whether a call replaces something: a patcher the file imports, or one a fixture handed the function. */
  private isPatcher(
    call: PyNode,
    file: BoundPythonFile,
    owner: PyNode,
    pattern: PyTestCases,
  ): boolean {
    const callee = calleeOf(call);
    const dotted = dottedOrigin(callee, file);
    if (dotted !== null && pattern.mocks.patchers.includes(dotted)) {
      return true;
    }
    const [root, ...rest] = callee.text.split(".");
    const handed = pattern.mocks.fixturePatchers.find(
      (one) => one.fixture === root && one.methods.includes(rest.join(".")),
    );
    return (
      handed !== undefined &&
      call.type === "call" &&
      parameterNames(owner).includes(handed.fixture)
    );
  }

  /**
   * What one patcher replaces. A dotted string is followed to the project
   * file that defines the thing at that path. An object and a member name
   * give the file its module or class is defined in, and the member.
   */
  private mockOf(call: PyNode, file: BoundPythonFile): TestMock | null {
    const [first, second] = positionalArguments(call);
    if (first === undefined) {
      return null;
    }
    const written = oneLine(call.text);
    const target = literalOf(evaluatedValue(first, this.context.facts));
    if (target !== null) {
      return { ...this.dottedTarget(target), written };
    }
    const member =
      second === undefined
        ? null
        : literalOf(evaluatedValue(second, this.context.facts));
    if (member === null) {
      return null;
    }
    const owner = this.objectModule(first, file);
    return {
      ...(owner === null ? {} : { module: owner }),
      name: member,
      written,
    };
  }

  /** `orders.service.cancel`: the module file the longest leading part resolves to, and the name after it. */
  private dottedTarget(dotted: string): { module: string; name?: string } {
    const parts = dotted.split(".");
    for (let at = parts.length; at > 0; at -= 1) {
      const resolved = resolveAbsoluteModule(parts.slice(0, at).join("."), {
        roots: this.context.roots,
      });
      if (resolved.status !== "resolved") {
        continue;
      }
      const rest = parts.slice(at);
      if (rest.length === 0) {
        return { module: this.displayPathOf(resolved.file) };
      }
      return {
        module: this.displayPathOf(this.definingFile(resolved.file, rest[0])),
        name: rest[rest.length - 1],
      };
    }
    // A package outside the project stays as written, the way a mocked package specifier does.
    return parts.length === 1
      ? { module: dotted }
      : { module: parts.slice(0, -1).join("."), name: parts[parts.length - 1] };
  }

  /** The file an object passed to a patcher is defined in: a module, or the file its class is written in. */
  private objectModule(expr: PyNode, file: BoundPythonFile): string | null {
    const local = this.projectClassOf(expr, file);
    if (local !== null) {
      return local.file.displayPath;
    }
    const dotted = dottedOrigin(expr, file);
    return dotted === null ? null : this.dottedTarget(dotted).module;
  }

  /** The file a module-level name is defined in, following an import back to the file that defines it. */
  private definingFile(file: string, name: string): string {
    noteKeyRead(this.context.facts, file);
    const bound = this.context.filesByPath.get(file);
    const binding = bound?.module.moduleScope.bindings.get(name);
    if (binding?.kind !== "importFrom" && binding?.kind !== "import") {
      return file;
    }
    for (const origin of originsOf(this.context.facts, `${file}#${name}`)) {
      if (this.context.filesByPath.has(origin.module)) {
        return origin.module;
      }
    }
    return file;
  }

  /** A file this run read shows the path its summaries use; any other stays absolute for the CLI to make relative. */
  private displayPathOf(file: string): string {
    return this.context.filesByPath.get(file)?.displayPath ?? file;
  }
}

/** The markers that apply to a test: its decorators, each class's around it, and every `pytestmark` in scope. */
function markersOn(file: BoundPythonFile, test: CollectedTest): PyNode[] {
  return [
    ...decoratorsOf(test.node),
    ...enclosingClasses(test.node).flatMap((classNode) => [
      ...decoratorsOf(classNode),
      ...markerVariable(file, classNode, test.pattern),
    ]),
    ...markerVariable(file, file.root, test.pattern),
  ];
}

function functionKey(fn: ReachedFunction): string {
  return nodeId(fn.file.file, fn.node);
}

/** A case the reader found, as a test of this file, or null for one whose function another file writes. */
function collectedTest(
  file: BoundPythonFile,
  found: FoundCase,
  pattern: PyTestCases,
  facts: Database,
): CollectedTest | null {
  const node = nodeOfResolutionKey(found.at, facts);
  return node === null || node.tree !== file.root.tree
    ? null
    : { node, titles: found.titles.map((title) => title.text), pattern };
}

/** The functions and classes written directly in a module or class body, with their decorators taken off. */
function definitionsIn(container: PyNode): PyNode[] {
  const body =
    container.type === "class_definition"
      ? field(container, "body")
      : container;
  return body === null
    ? []
    : children(body).map((statement) => {
        if (statement.type !== "decorated_definition") {
          return statement;
        }
        return field(statement, "definition") ?? statement;
      });
}

/** The decorators written on a definition, each as the expression after `@`. */
function decoratorsOf(definition: PyNode): PyNode[] {
  const parent = definition.parent;
  if (parent === null || parent.type !== "decorated_definition") {
    return [];
  }
  return children(parent)
    .filter((child) => child.type === "decorator")
    .map((decorator) => decorator.namedChild(0) ?? decorator);
}

/** What a marker or a patcher calls: the callee of a call, or the expression itself when it is not called. */
function calleeOf(expr: PyNode): PyNode {
  return expr.type === "call" ? (field(expr, "function") ?? expr) : expr;
}

/** The dotted name an expression resolves to through the file's imports, as in `pytest.mark.skip`. */
function dottedOrigin(expr: PyNode, file: BoundPythonFile): string | null {
  const origin = originOf(expr, file.module);
  return origin === null ? null : `${origin.module}.${origin.name}`;
}

/** The classes around a definition, innermost first, up to the first function. */
function enclosingClasses(node: PyNode): PyNode[] {
  const found: PyNode[] = [];
  for (let up = node.parent; up !== null; up = up.parent) {
    if (isFunction(up)) {
      break;
    }
    if (up.type === "class_definition") {
      found.push(up);
    }
  }
  return found;
}

function parameterNames(definition: PyNode): string[] {
  const parameters = field(definition, "parameters");
  return parameters === null
    ? []
    : children(parameters).flatMap((param) => {
        const named = parameterNameAndType(param);
        return named === null ? [] : [named.name];
      });
}

/** The markers a `pytestmark` variable in a module or class body gives every test under it. */
function markerVariable(
  file: BoundPythonFile,
  container: PyNode,
  pattern: PyTestCases,
): PyNode[] {
  if (pattern.markerVariable === undefined) {
    return [];
  }
  const scope =
    file.module.scopeFor.get(container.id) ?? file.module.moduleScope;
  const binding = scope.bindings.get(pattern.markerVariable);
  if (binding?.kind !== "assignment" || binding.value === null) {
    return [];
  }
  return binding.value.type === "list"
    ? children(binding.value)
    : [binding.value];
}

/** The fixture a decorated function declares, under the name a test asks for it by, or null when it is not one. */
function fixtureDeclaration(
  definition: PyNode,
  file: BoundPythonFile,
  pattern: PyTestCases,
  facts: Database,
): { name: string; autouse: boolean } | null {
  const decorator = decoratorsOf(definition).find((one) =>
    pattern.fixtureDecorators.includes(dottedOrigin(calleeOf(one), file) ?? ""),
  );
  const defName = field(definition, "name")?.text;
  if (decorator === undefined || defName === undefined) {
    return null;
  }
  const renamed = keywordArgument(decorator, pattern.fixtureNameKeyword);
  const autouse = keywordArgument(decorator, pattern.autouseKeyword);
  return {
    name:
      (renamed === null ? null : literalOf(evaluatedValue(renamed, facts))) ??
      defName,
    autouse:
      autouse !== null && constantOf(evaluatedValue(autouse, facts)) === true,
  };
}

function keywordArgument(call: PyNode, name: string): PyNode | null {
  if (call.type !== "call") {
    return null;
  }
  const args = field(call, "arguments");
  if (args === null) {
    return null;
  }
  const found = children(args).find(
    (arg) =>
      arg.type === "keyword_argument" && field(arg, "name")?.text === name,
  );
  return found === undefined ? null : field(found, "value");
}

function positionalArguments(call: PyNode): PyNode[] {
  if (call.type !== "call") {
    return [];
  }
  const args = field(call, "arguments");
  return args === null
    ? []
    : children(args).filter((arg) => arg.type !== "keyword_argument");
}

/** The calls written in a function's own body, nested functions left out. */
function callsIn(definition: PyNode, facts: Database): PyNode[] {
  const body = field(definition, "body");
  return body === null ? [] : bodyCalls(body, facts);
}

/** The call as a finding quotes it, on one line. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ");
}
