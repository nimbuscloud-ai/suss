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
import {
  caseRuns,
  collectsFile,
  decoratorIsFrom,
  discoverTestCases,
  global,
  mockRead,
} from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import {
  fileOfKey,
  isObserved,
  noteFileMissing,
  noteKeyRead,
} from "@suss/resolution";

import { children, field, isFunction, parameterNameAndType } from "./ast.js";
import { pythonModuleOps } from "./declaredDiscovery.js";
import { factSourceOf } from "./factSource.js";
import { originsOf } from "./facts/resolve.js";
import { nodeId } from "./facts/values.js";
import { resolveAbsoluteModule } from "./moduleResolver.js";
import { bodyCalls } from "./paths/effects.js";
import { libraryUnit } from "./reach/closure.js";
import { reachedFunctionOf } from "./reach/resolveCallee.js";
import { resolveName, scopeAt } from "./scope.js";
import { nodeOfResolutionKey } from "./values/evaluator.js";
import { originOf } from "./values/origin.js";

import type { TestMetadata, TestMock } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { Decorator, RawCodeStructure, ValueOps } from "@suss/extractor";
import type { FoundCase, MockRead } from "@suss/recognize";
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
  readonly skipped: boolean;
  /** The fixtures a `usefixtures` marker on the test, a class around it or a marker variable lists, in the order written. */
  readonly markedFixtures: readonly string[];
}

/** A fixture decorator on a function, as one pattern reads it. */
interface FixtureMark {
  readonly pattern: PyTestCases;
  /** The name the decorator gives the fixture, or null for the function's own. */
  readonly name: string | null;
  readonly autouse: boolean;
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
  private readonly decoratorCalls = new Map<
    string,
    ReadonlyMap<string, readonly string[]>
  >();
  private readonly fixtureMarks = new Map<
    string,
    ReadonlyMap<string, readonly FixtureMark[]>
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
    return [...new Set(test.markedFixtures)].flatMap((name): ImpliedCall[] => {
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
    const mocks = this.mocksOf(file, test);
    const metadata: TestMetadata = {
      ...(test.skipped ? { skipped: true } : {}),
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
    const marks = this.fixtureMarksIn(source.file).get(functionKey(source));
    return marks?.[0]?.pattern ?? null;
  }

  /**
   * The fixture decorators in one file, by the key of the function each
   * is written on, read once through the module ops and kept as names.
   * The walk asks of every function it reaches.
   */
  private fixtureMarksIn(
    file: BoundPythonFile,
  ): ReadonlyMap<string, readonly FixtureMark[]> {
    const known = this.fixtureMarks.get(file.file);
    if (known !== undefined && !isObserved(this.context.facts)) {
      return known;
    }
    const found = new Map<string, readonly FixtureMark[]>();
    this.fixtureMarks.set(file.file, found);
    const module = pythonModuleOps(file, this.context.facts);
    // A file whose text never writes a decorator's last name declares no
    // fixture with it, and listing its decorators walks the whole file.
    const patterns = this.patterns.filter((pattern) =>
      pattern.fixtureDecorators.some((dotted) =>
        module.mentions(dotted.slice(dotted.lastIndexOf(".") + 1)),
      ),
    );
    if (patterns.length === 0) {
      return found;
    }
    for (const { definition, decorators } of module.decorated()) {
      const key = definition.site?.();
      const marks = fixtureMarksOf(decorators, patterns);
      if (key !== undefined && marks.length > 0) {
        found.set(key, marks);
      }
    }
    return found;
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
    const marks = this.fixtureMarksIn(file);
    for (const definition of definitionsIn(container)) {
      const mark = isFunction(definition)
        ? marks
            .get(nodeId(file.file, definition))
            ?.find((one) => one.pattern === pattern)
        : undefined;
      const defName = field(definition, "name")?.text;
      if (mark === undefined || defName === undefined) {
        continue;
      }
      const name = mark.name ?? defName;
      found.set(name, {
        name,
        target: reachedFunctionOf(file, definition),
        autouse: mark.autouse,
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

  /** The mocks written on the test and its classes, in its body, and in each fixture and `setUp` it runs through. */
  private mocksOf(file: BoundPythonFile, test: CollectedTest): TestMock[] {
    const decoratorsOn = (
      on: BoundPythonFile,
      node: PyNode,
    ): readonly string[] =>
      this.decoratorCallsIn(on).get(nodeId(on.file, node)) ?? [];
    const onTest = [test.node, ...enclosingClasses(test.node)].flatMap((node) =>
      decoratorsOn(file, node).map((call) => ({
        file,
        owner: test.node,
        call,
      })),
    );
    const inBodies = this.bodiesRunBy(
      reachedFunctionOf(file, test.node),
    ).flatMap((fn) =>
      [
        ...decoratorsOn(fn.file, fn.node),
        ...callsIn(fn.node, this.context.facts).map((call) =>
          nodeId(fn.file.file, call),
        ),
      ].map((call) => ({ file: fn.file, owner: fn.node, call })),
    );
    const rules = test.pattern.cases.mocks ?? [];
    const source = factSourceOf(this.context.facts);
    const mocks: TestMock[] = [];
    const seen = new Set<string>();
    for (const site of [...onTest, ...inBodies]) {
      const ops = factCallOps(site.call, source);
      const read =
        ops === null
          ? null
          : mockRead(rules, ops, (name) =>
              parameterNames(site.owner).includes(name),
            );
      const mock =
        read === null ? null : this.mockOf(read, site.call, site.file);
      if (mock !== null && !seen.has(mock.written)) {
        seen.add(mock.written);
        mocks.push(mock);
      }
    }
    return mocks;
  }

  /**
   * The keys of the decorator calls on each function and class in one
   * file, by the key of what each is written on, read once through the
   * module ops. A decorator that is no call patches nothing.
   */
  private decoratorCallsIn(
    file: BoundPythonFile,
  ): ReadonlyMap<string, readonly string[]> {
    const known = this.decoratorCalls.get(file.file);
    if (known !== undefined && !isObserved(this.context.facts)) {
      return known;
    }
    const found = new Map<string, string[]>();
    this.decoratorCalls.set(file.file, found);
    for (const { definition, decorators } of pythonModuleOps(
      file,
      this.context.facts,
    ).decorated()) {
      const key = definition.site?.();
      const calls = decorators.flatMap((one) => {
        const site = one.form === "call" ? one.call.site?.() : undefined;
        return site === undefined ? [] : [site];
      });
      if (key !== undefined && calls.length > 0) {
        found.set(key, calls);
      }
    }
    return found;
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

  /**
   * What one patcher replaces, as the mock rules read it. A dotted path is
   * followed to the project file that defines the thing at that path. A
   * member gives the file the object's module or class is defined in.
   */
  private mockOf(
    read: MockRead,
    callKey: string,
    file: BoundPythonFile,
  ): TestMock | null {
    const call = nodeOfResolutionKey(callKey, this.context.facts);
    if (call === null) {
      return null;
    }
    const written = oneLine(call.text);
    if (read.replaces === "path") {
      return { ...this.dottedTarget(read.path), written };
    }
    const object = positionalArguments(call)[read.of];
    const owner = object === undefined ? null : this.objectModule(object, file);
    return {
      ...(owner === null ? {} : { module: owner }),
      name: read.member,
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
    : {
        node,
        titles: found.titles.map((title) => title.text),
        pattern,
        skipped: found.skipped,
        markedFixtures: markedFixtures(found.markers, pattern),
      };
}

/** The string arguments of each `usefixtures` marker, in order. */
function markedFixtures(
  markers: readonly Decorator[],
  pattern: PyTestCases,
): string[] {
  const origins = [global(...pattern.usesFixtureMarkers)];
  return markers.flatMap((marker) => {
    if (marker.form !== "call" || !decoratorIsFrom(marker, origins)) {
      return [];
    }
    const count =
      marker.call.positionalCount?.() ?? marker.call.argumentCount();
    return Array.from({ length: count }, (_, at) =>
      marker.call.valueAt(at)?.evaluated?.(),
    ).flatMap((name) => (typeof name === "string" ? [name] : []));
  });
}

/** The fixture decorator of each pattern on a definition, with the name and autouse its keywords give. */
function fixtureMarksOf(
  decorators: readonly Decorator[],
  patterns: readonly PyTestCases[],
): FixtureMark[] {
  return patterns.flatMap((pattern): FixtureMark[] => {
    const origins = [global(...pattern.fixtureDecorators)];
    const decorator = decorators.find((one) => decoratorIsFrom(one, origins));
    if (decorator === undefined) {
      return [];
    }
    const keyword = (name: string) =>
      decorator.form === "call"
        ? (decorator.call.keywordAt?.(name)?.evaluated?.() ?? null)
        : null;
    const renamed = keyword(pattern.fixtureNameKeyword);
    return [
      {
        pattern,
        name: typeof renamed === "string" ? renamed : null,
        autouse: keyword(pattern.autouseKeyword) === true,
      },
    ];
  });
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
