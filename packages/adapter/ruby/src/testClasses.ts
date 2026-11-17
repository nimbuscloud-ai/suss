/**
 * Minitest's tests as `test` units. The minitest pack declares which
 * classes are test classes, which of their methods are tests, what runs
 * before each, and which calls are the runner's or replace a method, and
 * `@suss/recognize` reads them through the module ops. ActiveSupport's
 * `test "cancels twice" do` is the method `test_cancels_twice`, which the
 * pack's class-body declaration states, and its unit is recorded at the
 * `test` call.
 *
 * Each file is read once and kept as nodes, since the reach walk asks
 * about a test's block or method until the run ends, and keeping the ops
 * would keep every value they read alive with them.
 */

import { isListedTestFile } from "@suss/extractor";
import {
  caseRuns,
  collectsFile,
  isRunnerCall,
  mockRead,
} from "@suss/recognize";
import { factCallOps } from "@suss/recognize/ops";
import { isObserved } from "@suss/resolution";

import { children, field } from "./ast.js";
import { rubyModuleOps } from "./declaredDiscovery.js";
import { factSourceOf } from "./factSource.js";
import { nodeId } from "./facts/values.js";
import { moduleOfConstant, oneLine, testUnitOf } from "./testCases.js";
import { nodeOfResolutionKey } from "./values/evaluator.js";

import type { TestMock } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawCodeStructure, TestCasesMatch } from "@suss/extractor";
import type { CaseRun } from "@suss/recognize";
import type { RbTestClasses, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { ExampleRun, TestUnitOptions, Title } from "./testCases.js";

export function testClassPatternsIn(
  packs: readonly RubyPack[],
): RbTestClasses[] {
  return packs.flatMap((pack) => pack.testClasses ?? []);
}

/** One test as nodes: what it runs first to last, and where its unit is recorded. */
interface ClassTest {
  readonly titles: readonly Title[];
  /** The test's own block or method, then what the runner runs before it. */
  readonly blocks: readonly RbNode[];
  readonly anchor: RbNode;
  readonly skipped: boolean;
  /** The runner that collected the test, which says which calls are its own and which replace a method. */
  readonly cases: TestCasesMatch;
}

/** The tests of every file the run reads, each file read once per pattern, by the key of the block or method the test runs. */
export class ClassTestIndex {
  private readonly byPattern = new Map<
    RbTestClasses,
    Map<string, ReadonlyMap<string, ClassTest>>
  >();

  constructor(
    private readonly patterns: readonly RbTestClasses[],
    private readonly facts: Database,
  ) {}

  /** The tests in one file, in source order, when a pattern collects the file and the PRDs list it. */
  testsIn(file: string, root: RbNode): ClassTest[] {
    return this.patterns.flatMap((pattern) =>
      collectsFile(pattern.cases, file) &&
      isListedTestFile(file, pattern.cases.files.listed)
        ? [...this.readFile(file, root, pattern).values()]
        : [],
    );
  }

  /** The run of the test this block or method is, for the reach walk, or null when it is none. */
  runOf(node: RbNode, file: string): ExampleRun | null {
    const root = node.tree.rootNode as RbNode;
    for (const pattern of this.patterns) {
      if (
        !collectsFile(pattern.cases, file) ||
        !isListedTestFile(file, pattern.cases.files.listed)
      ) {
        continue;
      }
      const test = this.readFile(file, root, pattern).get(nodeId(file, node));
      if (test !== undefined) {
        return this.runFor(test, file);
      }
    }
    return null;
  }

  /** What the runner runs for one test, its runner calls told apart through the ops at each call's key. */
  runFor(test: ClassTest, file: string): ExampleRun {
    const source = factSourceOf(this.facts);
    return {
      blocks: test.blocks,
      isRunnerCall: (call) => {
        const ops = factCallOps(nodeId(file, call), source);
        return ops !== null && isRunnerCall(test.cases, ops);
      },
      fileOf: () => file,
    };
  }

  private readFile(
    file: string,
    root: RbNode,
    pattern: RbTestClasses,
  ): ReadonlyMap<string, ClassTest> {
    const byFile = this.byPattern.get(pattern) ?? new Map();
    this.byPattern.set(pattern, byFile);
    const known = byFile.get(file);
    // A recording cache has to see every file the answer reads, per charge.
    if (known !== undefined && !isObserved(this.facts)) {
      return known;
    }
    const found = new Map<string, ClassTest>();
    const runs = caseRuns(pattern.cases, {
      module: rubyModuleOps(root, file, this.facts),
    });
    for (const [key, run] of runs) {
      const test = classTestOf(run, pattern.cases, this.facts);
      if (test !== null) {
        found.set(key, test);
      }
    }
    byFile.set(file, found);
    return found;
  }
}

/** A case the reader found, as nodes, or null when a function it runs has no node in the run. */
function classTestOf(
  run: CaseRun,
  cases: TestCasesMatch,
  facts: Database,
): ClassTest | null {
  const runs = run.found.runs;
  if (runs === null) {
    return null;
  }
  const blocks = [runs, ...run.before].map((fn) => {
    const key = fn.site?.();
    return key === undefined ? null : nodeOfResolutionKey(key, facts);
  });
  const anchor = nodeOfResolutionKey(run.found.at, facts);
  if (anchor === null || blocks.some((block) => block === null)) {
    return null;
  }
  return {
    titles: run.found.titles,
    blocks: blocks as RbNode[],
    anchor,
    skipped: run.found.skipped,
    cases,
  };
}

/** One `test` unit per test in each test class the file defines, when a pack reads it. */
export function testClassUnits(
  root: RbNode,
  index: ClassTestIndex | undefined,
  options: TestUnitOptions & {
    readonly onClassSeed: (
      raw: RawCodeStructure,
      node: RbNode,
      qualifiedName: string,
    ) => void;
  },
): RawCodeStructure[] {
  const facts = options.facts;
  if (index === undefined || facts === undefined) {
    return [];
  }
  return index.testsIn(options.absoluteFile, root).map((test) => {
    const [body] = test.blocks;
    const raw = testUnitOf({
      titles: test.titles,
      run: index.runFor(test, options.absoluteFile),
      mocks: test.blocks.flatMap((block) =>
        stubsIn(block, test.cases, options),
      ),
      skipped: test.skipped,
      anchor: test.anchor,
      body: body as RbNode,
      options,
    });
    options.onClassSeed(raw, body as RbNode, test.titles[0]?.text ?? "");
    return raw;
  });
}

/**
 * The methods a block replaces with a stub, in the order its calls are
 * written, each call read against the runner's mock rules. A lambda or a
 * block written inside it is read too, since a stub there runs with it.
 */
function stubsIn(
  block: RbNode,
  cases: TestCasesMatch,
  options: TestUnitOptions,
): TestMock[] {
  const rules = cases.mocks ?? [];
  const facts = options.facts;
  if (rules.length === 0 || facts === undefined) {
    return [];
  }
  const source = factSourceOf(facts);
  const found: TestMock[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const ops =
        child.type === "call"
          ? factCallOps(nodeId(options.absoluteFile, child), source)
          : null;
      const read = ops === null ? null : mockRead(rules, ops, () => false);
      if (read?.replaces === "member" && read.of === "receiver") {
        found.push(stubOf(child, read.member, options));
      }
      visit(child);
    }
  };
  visit(block);
  return found;
}

/**
 * A stub as the checker matches it: the file that defines the class whose
 * method it replaces, `Order` in `Order.any_instance.stubs(:cancel)`, and
 * the call as written up to the block it runs, which is the test's code.
 */
function stubOf(
  call: RbNode,
  name: string,
  options: TestUnitOptions,
): TestMock {
  const module = moduleOfConstant(
    constantBehind(field(call, "receiver")),
    options,
  );
  const block = field(call, "block");
  const written = oneLine(
    block === null
      ? call.text
      : call.text.slice(0, block.startIndex - call.startIndex),
  );
  return module === null ? { name, written } : { module, name, written };
}

/** `Order` in `Order` or in `Order.any_instance`. */
function constantBehind(receiver: RbNode | null): RbNode | null {
  let current = receiver;
  while (current !== null && current.type === "call") {
    current = field(current, "receiver");
  }
  return current;
}
