/**
 * Tests written as a class, the way Minitest and Rails' test cases write
 * them. A class whose ancestry reaches one of the pack's base classes is
 * a test class, and each `def test_*` method or `test "..." do` block in
 * it is a `test` unit named by the class and the method name the runner
 * gives the test, so `test "cancels twice"` is `test_cancels_twice`.
 *
 * A test runs its class's `setup` blocks and `setup` method first, so
 * their calls count as the test's own. The runner's assertions call no
 * project code and are left out. A stub, `Order.stub(:cancel, 1)` or
 * mocha's `Order.expects(:cancel)`, is recorded against the file that
 * defines the class it replaces a method on.
 */

import { isListedTestFile, matchesTestFileName } from "@suss/extractor";
import { literalOf } from "@suss/values";

import { bodyStatements, children, field, symbolValue } from "./ast.js";
import { reachesBase } from "./baseClass.js";
import { nodeId } from "./facts/values.js";
import { calleeMethodName } from "./paths/effects.js";
import { walkClasses } from "./scope.js";
import {
  firstArgument,
  moduleOfConstant,
  oneLine,
  skipsAsItRuns,
  testUnitOf,
} from "./testCases.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { TestMock } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawCodeStructure } from "@suss/extractor";
import type { RbTestClasses, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { ClassInfo } from "./scope.js";
import type { ExampleRun, TestUnitOptions } from "./testCases.js";

const BLOCK_TYPES = new Set(["block", "do_block"]);

export function testClassPatternsIn(
  packs: readonly RubyPack[],
): RbTestClasses[] {
  return packs.flatMap((pack) => pack.testClasses ?? []);
}

/** One test in a test class: a method, or a block given to a test call. */
interface ClassTest {
  readonly node: RbNode;
  readonly name: string;
}

/** One `test` unit per test in each test class the file defines, when a pack reads it. */
export function testClassUnits(
  root: RbNode,
  patterns: readonly RbTestClasses[],
  options: TestUnitOptions & {
    readonly onClassSeed: (
      raw: RawCodeStructure,
      node: RbNode,
      qualifiedName: string,
    ) => void;
  },
): RawCodeStructure[] {
  const facts = options.facts;
  if (facts === undefined) {
    return [];
  }
  return patterns.flatMap((pattern) => {
    if (!readsFile(options.absoluteFile, pattern)) {
      return [];
    }
    return testClassesIn(root, options.absoluteFile, pattern, facts).flatMap(
      (info) =>
        testsIn(info, pattern, facts).map((test) => {
          const run = classTestRun(
            test.node,
            info,
            pattern,
            options.absoluteFile,
          );
          const raw = testUnitOf({
            titles: [
              { text: info.qualifiedName, unresolved: false },
              { text: test.name, unresolved: false },
            ],
            run,
            mocks: run.blocks.flatMap((block) =>
              stubsIn(block, pattern, options),
            ),
            skipped: skipsAsItRuns(test.node, pattern.skipStatements),
            anchor: anchorOf(test.node),
            body: test.node,
            options,
          });
          options.onClassSeed(raw, test.node, info.qualifiedName);
          return raw;
        }),
    );
  });
}

function readsFile(file: string, pattern: RbTestClasses): boolean {
  return (
    matchesTestFileName(file, pattern.filePatterns) &&
    isListedTestFile(file, pattern.files)
  );
}

function testClassesIn(
  root: RbNode,
  file: string,
  pattern: RbTestClasses,
  facts: Database,
): ClassInfo[] {
  const found: ClassInfo[] = [];
  walkClasses(root, (info) => {
    if (reachesBase(facts, nodeId(file, info.node), pattern.baseClassNames)) {
      found.push(info);
    }
  });
  return found;
}

function testsIn(
  info: ClassInfo,
  pattern: RbTestClasses,
  facts: Database,
): ClassTest[] {
  return classStatements(info).flatMap((statement): ClassTest[] => {
    const method = testMethodName(statement, pattern);
    if (method !== null) {
      return [{ node: statement, name: method }];
    }
    const block = testBlockOf(statement, pattern);
    const description = block === null ? null : descriptionOf(statement, facts);
    if (block === null || description === null) {
      return [];
    }
    const { prefix, spacesAs } = pattern.blockTestName;
    return [
      {
        node: block,
        name: `${prefix}${description.trim().split(/\s+/).join(spacesAs)}`,
      },
    ];
  });
}

function classStatements(info: ClassInfo): RbNode[] {
  return info.bodyNode === null ? [] : bodyStatements(info.bodyNode);
}

function testMethodName(
  statement: RbNode,
  pattern: RbTestClasses,
): string | null {
  const name = statement.type === "method" ? field(statement, "name") : null;
  return name !== null && name.text.startsWith(pattern.testMethodPrefix)
    ? name.text
    : null;
}

/** The block of a `test "..." do` call, or null when the statement is none. */
function testBlockOf(statement: RbNode, pattern: RbTestClasses): RbNode | null {
  if (
    statement.type !== "call" ||
    field(statement, "receiver") !== null ||
    !pattern.testBlockMethods.includes(calleeMethodName(statement) ?? "")
  ) {
    return null;
  }
  return field(statement, "block");
}

function descriptionOf(call: RbNode, facts: Database): string | null {
  const first = firstArgument(call);
  return first === null ? null : literalOf(evaluatedValue(first, facts));
}

/** A method is recorded where it is written, and a block where its `test` call is. */
function anchorOf(node: RbNode): RbNode {
  return BLOCK_TYPES.has(node.type) ? (node.parent ?? node) : node;
}

/** What one test runs: its own body, then its class's setup blocks and setup method. */
function classTestRun(
  node: RbNode,
  info: ClassInfo,
  pattern: RbTestClasses,
  file: string,
): ExampleRun {
  const setup = classStatements(info).flatMap((statement): RbNode[] => {
    const name = statement.type === "method" ? field(statement, "name") : null;
    if (name !== null && pattern.setupMethodNames.includes(name.text)) {
      return [statement];
    }
    const block = field(statement, "block");
    const isSetupCall =
      statement.type === "call" &&
      field(statement, "receiver") === null &&
      pattern.setupBlockMethods.includes(calleeMethodName(statement) ?? "");
    return isSetupCall && block !== null ? [block] : [];
  });
  return {
    blocks: [node, ...setup],
    isRunnerCall: (call) => isAssertion(call, pattern),
    fileOf: () => file,
  };
}

/** A check the runner gives a test, `assert_equal a, b`, written on self. */
function isAssertion(call: RbNode, pattern: RbTestClasses): boolean {
  if (call.type !== "call" || field(call, "receiver") !== null) {
    return false;
  }
  const method = calleeMethodName(call) ?? "";
  return (
    pattern.assertionPrefixes.some((prefix) => method.startsWith(prefix)) ||
    pattern.skipStatements.includes(method)
  );
}

/**
 * The run of a test in a test class, for the reach walk, when this node
 * is one: a test method, or the block of a test call, in a class that
 * reaches one of the pattern's bases.
 */
export function classTestRunAt(
  node: RbNode,
  file: string,
  patterns: readonly RbTestClasses[],
  facts: Database,
): ExampleRun | null {
  for (const pattern of patterns) {
    if (!readsFile(file, pattern)) {
      continue;
    }
    const statement = BLOCK_TYPES.has(node.type) ? node.parent : node;
    const isTest =
      statement !== null &&
      (testMethodName(statement, pattern) !== null ||
        testBlockOf(statement, pattern)?.id === node.id);
    const info = isTest && statement !== null ? classAround(statement) : null;
    if (
      info !== null &&
      reachesBase(facts, nodeId(file, info.node), pattern.baseClassNames)
    ) {
      return classTestRun(node, info, pattern, file);
    }
  }
  return null;
}

/** The class a statement is written directly in, read the way `walkClasses` reads it. */
function classAround(statement: RbNode): ClassInfo | null {
  const body = statement.parent;
  const classNode = body?.parent ?? null;
  if (classNode === null || classNode.type !== "class") {
    return null;
  }
  let found: ClassInfo | null = null;
  walkClasses(classNode.tree.rootNode as RbNode, (info) => {
    if (info.node.id === classNode.id) {
      found = info;
    }
  });
  return found;
}

/**
 * The methods a test replaces with a stub. `Order.stub(:cancel, 1)` and
 * `Order.expects(:cancel)` replace `cancel` on `Order`, and
 * `Order.any_instance.stubs(:cancel)` on its instances, which the checker
 * matches the same way.
 */
function stubsIn(
  block: RbNode,
  pattern: RbTestClasses,
  options: TestUnitOptions,
): TestMock[] {
  const found: TestMock[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const mock =
        child.type === "call" ? stubOf(child, pattern, options) : null;
      if (mock !== null) {
        found.push(mock);
      }
      visit(child);
    }
  };
  visit(block);
  return found;
}

function stubOf(
  call: RbNode,
  pattern: RbTestClasses,
  options: TestUnitOptions,
): TestMock | null {
  if (!pattern.stubMethods.includes(calleeMethodName(call) ?? "")) {
    return null;
  }
  const first = firstArgument(call);
  const name = first === null ? null : symbolValue(first);
  if (name === null) {
    return null;
  }
  const module = moduleOfConstant(
    constantBehind(field(call, "receiver")),
    options,
  );
  // The block a stub runs is the test's code, not part of the stub.
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
