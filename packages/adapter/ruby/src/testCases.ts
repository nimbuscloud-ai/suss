/**
 * RSpec examples as `test` units, so a PRD scenario can list the test
 * that covers it under `coveredBy` and the intent check can ask what the
 * test reaches.
 *
 * An example runs more than its own block: every `before` hook and
 * `let!` in the groups around it, and each `let` or `subject` it reads
 * by name. Their calls count as the example's own. `exampleRun` works
 * that list out from the example's block alone, so a scan the cache
 * replays reads the same blocks. A mocked method is recorded the way the
 * checker matches it: the file that defines its class, and its name.
 */

import { testUnitName } from "@suss/behavioral-ir";
import { isListedTestFile, matchesTestFileName } from "@suss/extractor";
import { fileOfKey } from "@suss/resolution";
import { literalOf } from "@suss/values";

import {
  bodyStatements,
  children,
  field,
  hashKeySymbolName,
  rangeOf,
  spanOf,
  symbolValue,
} from "./ast.js";
import { classBehind } from "./baseClass.js";
import {
  bodyCalls,
  calleeMethodName,
  calleeText,
  EVERY_ARGLESS_CALL,
  invocationEffects,
  methodBody,
} from "./paths/effects.js";
import { evaluatedValue } from "./values/evaluator.js";

import type { TestMetadata, TestMock } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type { RawCodeStructure } from "@suss/extractor";
import type { RbTestCases, RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";
import type { InheritedMethods } from "./paths/effects.js";

const BLOCK_TYPES = new Set(["block", "do_block"]);

/** What an example runs: its own block first, then every block it runs through. */
export interface ExampleRun {
  readonly blocks: readonly RbNode[];
  /**
   * Whether a call in those blocks is the runner's own: a read of a
   * `let` or the subject, or a matcher or mock chain such as
   * `expect(x).to eq(y)`. Neither is a call into project code.
   */
  readonly isRunnerCall: (call: RbNode) => boolean;
}

/** Tells the reach walk which blocks an example runs, from the example's block alone. */
export interface ExampleReads {
  runOf(node: RbNode): ExampleRun | null;
}

/** The run's test patterns, pooled from every pack. */
export function testPatternsIn(packs: readonly RubyPack[]): RbTestCases[] {
  return packs.flatMap((pack) => pack.tests ?? []);
}

export function exampleReads(
  patterns: readonly RbTestCases[],
): ExampleReads | undefined {
  if (patterns.length === 0) {
    return undefined;
  }
  return {
    runOf: (node) => {
      const call = node.parent;
      if (!BLOCK_TYPES.has(node.type) || call === null) {
        return null;
      }
      for (const pattern of patterns) {
        const found = exampleAt(call, pattern);
        if (found !== null) {
          return exampleRun(found, pattern);
        }
      }
      return null;
    },
  };
}

/** One example, with the groups around it, outermost first. */
interface Example {
  readonly call: RbNode;
  readonly block: RbNode;
  readonly groups: readonly RbNode[];
}

type Role = "opensGroup" | "sharedGroup" | "declaresTest" | null;

function roleOf(node: RbNode, pattern: RbTestCases): Role {
  if (node.type !== "call" || field(node, "block") === null) {
    return null;
  }
  const method = calleeMethodName(node);
  const receiver = field(node, "receiver");
  if (method === undefined) {
    return null;
  }
  if (receiver !== null) {
    return receiver.text === pattern.receiver && isGroupName(method, pattern)
      ? "opensGroup"
      : null;
  }
  if (isGroupName(method, pattern)) {
    return "opensGroup";
  }
  if (pattern.sharedGroupNames.includes(method)) {
    return "sharedGroup";
  }
  return isExampleName(method, pattern) ? "declaresTest" : null;
}

function isGroupName(method: string, pattern: RbTestCases): boolean {
  return (
    pattern.groupNames.includes(method) ||
    pattern.skippedGroupNames.includes(method)
  );
}

function isExampleName(method: string, pattern: RbTestCases): boolean {
  return (
    pattern.exampleNames.includes(method) ||
    pattern.skippedExampleNames.includes(method)
  );
}

/** Every example in a file, in source order. */
function examplesIn(root: RbNode, pattern: RbTestCases): Example[] {
  const found: Example[] = [];
  const visit = (node: RbNode, groups: readonly RbNode[]): void => {
    for (const child of children(node)) {
      const role = roleOf(child, pattern);
      const block = field(child, "block");
      if (role === "sharedGroup") {
        continue;
      }
      if (role === "opensGroup" && block !== null) {
        visit(block, [...groups, child]);
        continue;
      }
      if (role === "declaresTest" && block !== null) {
        if (groups.length > 0) {
          found.push({ call: child, block, groups });
        }
        continue;
      }
      visit(child, groups);
    }
  };
  visit(root, []);
  return found;
}

/** The example whose call this is, with its groups, or null when the call declares none. */
function exampleAt(call: RbNode, pattern: RbTestCases): Example | null {
  const block = field(call, "block");
  if (roleOf(call, pattern) !== "declaresTest" || block === null) {
    return null;
  }
  const groups: RbNode[] = [];
  for (let above = call.parent; above !== null; above = above.parent) {
    const role = roleOf(above, pattern);
    if (role === "sharedGroup") {
      return null;
    }
    if (role === "opensGroup") {
      groups.unshift(above);
    }
  }
  return groups.length === 0 ? null : { call, block, groups };
}

/** One `let`, `subject` or hook written directly in a group. */
interface GroupBlock {
  readonly block: RbNode;
  /** The names it defines, empty for a hook. */
  readonly names: readonly string[];
  /** Whether it runs before every example whatever the example reads. */
  readonly always: boolean;
}

/** The first argument's symbol, as in `let(:order)`. */
function firstSymbol(call: RbNode): string | null {
  const first = firstArgument(call);
  return first === null ? null : symbolValue(first);
}

function groupBlocks(group: RbNode, pattern: RbTestCases): GroupBlock[] {
  const groupBlock = field(group, "block");
  const body = groupBlock === null ? null : field(groupBlock, "body");
  if (body === null) {
    return [];
  }
  const found: GroupBlock[] = [];
  for (const statement of bodyStatements(body)) {
    const block = field(statement, "block");
    const method =
      statement.type === "call" && field(statement, "receiver") === null
        ? calleeMethodName(statement)
        : undefined;
    if (block === null || method === undefined) {
      continue;
    }
    const one = groupBlockOf(statement, method, block, pattern);
    if (one !== null) {
      found.push(one);
    }
  }
  return found;
}

function groupBlockOf(
  call: RbNode,
  method: string,
  block: RbNode,
  pattern: RbTestCases,
): GroupBlock | null {
  if (pattern.beforeHooks.includes(method)) {
    return { block, names: [], always: true };
  }
  const named = firstSymbol(call);
  const lazyValue = pattern.lazyValues.includes(method);
  if ((lazyValue || pattern.eagerValues.includes(method)) && named !== null) {
    return { block, names: [named], always: !lazyValue };
  }
  const lazySubject = pattern.subjectNames.lazy.includes(method);
  if (lazySubject || pattern.subjectNames.eager.includes(method)) {
    // Every way the library spells a read of the subject reaches this block.
    const names = [...pattern.subjectReads];
    return {
      block,
      names: named === null ? names : [...names, named],
      always: !lazySubject,
    };
  }
  return null;
}

/**
 * The blocks an example runs: its own, the hooks and eager values of
 * every group around it, and each value it reads by name from the
 * nearest group that defines it, followed through the values those read.
 */
function exampleRun(example: Example, pattern: RbTestCases): ExampleRun {
  const byName = new Map<string, RbNode>();
  const always: RbNode[] = [];
  for (const group of example.groups) {
    for (const one of groupBlocks(group, pattern)) {
      for (const name of one.names) {
        byName.set(name, one.block);
      }
      if (one.always) {
        always.push(one.block);
      }
    }
  }
  const blocks: RbNode[] = [];
  const included = new Set<number>();
  const include = (block: RbNode): void => {
    if (included.has(block.id)) {
      return;
    }
    included.add(block.id);
    blocks.push(block);
    for (const name of namesRead(block)) {
      const defined = byName.get(name);
      if (defined !== undefined) {
        include(defined);
      }
    }
  };
  include(example.block);
  for (const block of always) {
    include(block);
  }
  const valueNames = new Set([...byName.keys(), ...pattern.subjectReads]);
  const isRunnerMethod = (name: string | null): boolean =>
    name !== null &&
    (pattern.runnerMethods.includes(name) ||
      pattern.predicateMatcherPrefixes.some((prefix) =>
        name.startsWith(prefix),
      ));
  return {
    blocks,
    isRunnerCall: (call) => {
      const read = nameReadAt(call);
      if (read !== null && valueNames.has(read)) {
        return true;
      }
      return isRunnerMethod(chainOrigin(call));
    },
  };
}

/**
 * The name a call chain starts from when it starts on self:
 * `expect` in `expect(x).to eq(y)`, `is_expected` in `is_expected.to`,
 * `order` in a bare `order`. Null when the chain starts on anything else.
 */
function chainOrigin(call: RbNode): string | null {
  if (call.type === "identifier") {
    return call.text;
  }
  let current = call;
  for (;;) {
    const receiver = field(current, "receiver");
    if (receiver === null) {
      return calleeMethodName(current) ?? null;
    }
    if (receiver.type === "identifier") {
      return receiver.text;
    }
    if (receiver.type !== "call") {
      return null;
    }
    current = receiver;
  }
}

/** Every name a block reads that could be a `let` or the subject: a bare name, or a call on self with no arguments. */
function namesRead(block: RbNode): string[] {
  const found: string[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const name = nameReadAt(child);
      if (name !== null) {
        found.push(name);
      }
      visit(child);
    }
  };
  visit(block);
  return found;
}

function nameReadAt(node: RbNode): string | null {
  if (node.type === "identifier") {
    return node.text;
  }
  const bare =
    node.type === "call" &&
    field(node, "receiver") === null &&
    field(node, "arguments") === null;
  return bare ? (calleeMethodName(node) ?? null) : null;
}

/** Every call written in the blocks an example runs, the runner's own included. */
export function exampleCalls(
  run: ExampleRun,
  inherited: InheritedMethods | undefined,
): RbNode[] {
  return run.blocks.flatMap((block) => {
    const read = methodBody(block);
    return read === null ? [] : bodyCalls(read, inherited);
  });
}

export interface TestUnitOptions {
  readonly filePath: string;
  readonly absoluteFile: string;
  readonly displayPathOf: (absolute: string) => string;
  readonly facts?: Database | undefined;
  readonly inheritedMethods?: InheritedMethods | undefined;
  /** Called for each example, so the reach walk starts at its block. */
  readonly onSeed: (raw: RawCodeStructure, block: RbNode) => void;
}

/** One `test` unit per example in the file, when a pack in the run reads tests and the file is one of them. */
export function testCaseUnits(
  root: RbNode,
  patterns: readonly RbTestCases[],
  options: TestUnitOptions,
): RawCodeStructure[] {
  return patterns.flatMap((pattern) => {
    if (
      !matchesTestFileName(options.absoluteFile, pattern.filePatterns) ||
      !isListedTestFile(options.absoluteFile, pattern.files)
    ) {
      return [];
    }
    return examplesIn(root, pattern).map((example) => {
      const raw = exampleUnit(example, pattern, options);
      options.onSeed(raw, example.block);
      return raw;
    });
  });
}

interface Title {
  readonly text: string;
  readonly unresolved: boolean;
}

function exampleUnit(
  example: Example,
  pattern: RbTestCases,
  options: TestUnitOptions,
): RawCodeStructure {
  const titles = [...example.groups, example.call].map((call) =>
    titleOf(call, options.facts),
  );
  const run = exampleRun(example, pattern);
  const runnerCallees = new Set(
    exampleCalls(run, options.inheritedMethods)
      .filter(run.isRunnerCall)
      .map(calleeText),
  );
  const effects = run.blocks
    .flatMap((block) =>
      invocationEffects(
        block,
        options.inheritedMethods,
        EVERY_ARGLESS_CALL,
        options.facts,
      ),
    )
    .filter((effect) => !runnerCallees.has(effect.callee));
  const mocks = run.blocks.flatMap((block) =>
    mocksIn(block, pattern.mocks, options),
  );
  const unresolved = titles.find((title) => title.unresolved);
  const test: TestMetadata = {
    ...(isSkipped(example, pattern) ? { skipped: true } : {}),
    ...(mocks.length > 0 ? { mocks } : {}),
    ...(unresolved !== undefined ? { unresolvedTitle: unresolved.text } : {}),
  };
  const range = rangeOf(example.call);
  return {
    identity: {
      name: testUnitName(titles.map((title) => title.text)),
      nameKind: "label",
      kind: "test",
      file: options.filePath,
      range,
      span: spanOf(example.call),
      exportName: null,
      exportPath: null,
    },
    boundaryBinding: null,
    parameters: [],
    branches: [
      {
        conditions: [],
        terminal: {
          kind: "return",
          statusCode: null,
          body: null,
          exceptionType: null,
          message: null,
          component: null,
          renderTree: null,
          delegateTarget: null,
          emitEvent: null,
          location: range,
        },
        effects,
        location: range,
        isDefault: true,
      },
    ],
    bodyContent: field(example.block, "body") === null ? "empty" : "statements",
    dependencyCalls: [],
    declaredContract: null,
    test,
  };
}

/**
 * A group or example's title. A constant is its title as written, as in
 * `describe Order`. A string reads through the evaluator. Anything else,
 * or no title at all, keeps its source text and is recorded as unresolved.
 */
function titleOf(call: RbNode, facts: Database | undefined): Title {
  const first = firstArgument(call);
  if (first === null || first.type === "pair") {
    const block = field(call, "block");
    return { text: oneLine((block ?? call).text), unresolved: true };
  }
  if (first.type === "constant" || first.type === "scope_resolution") {
    return { text: first.text, unresolved: false };
  }
  const read = literalOf(evaluatedValue(first, facts));
  return read === null
    ? { text: first.text, unresolved: true }
    : { text: read, unresolved: false };
}

function isSkipped(example: Example, pattern: RbTestCases): boolean {
  if (
    pattern.skippedExampleNames.includes(calleeMethodName(example.call) ?? "")
  ) {
    return true;
  }
  const skippedGroup = example.groups.some((group) =>
    pattern.skippedGroupNames.includes(calleeMethodName(group) ?? ""),
  );
  const markedSkip = [...example.groups, example.call].some((call) =>
    hasSkipMetadata(call, pattern.skipMetadata),
  );
  if (skippedGroup || markedSkip) {
    return true;
  }
  const hooks = example.groups.flatMap((group) =>
    groupBlocks(group, pattern)
      .filter((one) => one.always && one.names.length === 0)
      .map((one) => one.block),
  );
  return [example.block, ...hooks].some((block) =>
    skipsAsItRuns(block, pattern.skipStatements),
  );
}

/** `it "x", :skip` or `it "x", skip: "not yet"`, with the key the library reads. */
function hasSkipMetadata(call: RbNode, keys: readonly string[]): boolean {
  const args = field(call, "arguments");
  return (args === null ? [] : bodyStatements(args)).some((arg) => {
    const symbol = symbolValue(arg);
    if (symbol !== null) {
      return keys.includes(symbol);
    }
    return arg.type === "pair" && pairSkips(arg, keys);
  });
}

function pairSkips(pair: RbNode, keys: readonly string[]): boolean {
  const name = keyName(field(pair, "key"));
  const value = field(pair, "value");
  return (
    name !== null &&
    keys.includes(name) &&
    value !== null &&
    value.type !== "false" &&
    value.type !== "nil"
  );
}

function keyName(key: RbNode | null): string | null {
  return key === null ? null : (hashKeySymbolName(key) ?? symbolValue(key));
}

/** A `skip` or `pending` written as one of the block's own statements, which stops the example there. */
function skipsAsItRuns(block: RbNode, statements: readonly string[]): boolean {
  const body = field(block, "body");
  return (body === null ? [] : bodyStatements(body)).some((statement) => {
    const onSelf =
      (statement.type === "call" && field(statement, "receiver") === null) ||
      statement.type === "identifier";
    return (
      onSelf &&
      field(statement, "block") === null &&
      statements.includes(calleeMethodName(statement) ?? "")
    );
  });
}

/** Every mock a block sets up, in source order. */
function mocksIn(
  block: RbNode,
  spelled: RbTestCases["mocks"],
  options: TestUnitOptions,
): TestMock[] {
  const found: TestMock[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      if (child.type === "call") {
        found.push(...mockOf(child, spelled, options));
      }
      visit(child);
    }
  };
  visit(block);
  return found;
}

function mockOf(
  call: RbNode,
  spelled: RbTestCases["mocks"],
  options: TestUnitOptions,
): TestMock[] {
  const method = calleeMethodName(call) ?? "";
  const written = oneLine(call.text);
  if (spelled.expectations.includes(method)) {
    return messageMocks(call, spelled, options, written);
  }
  if (spelled.constantStubs.includes(method)) {
    return [
      withModule(moduleOfConstant(firstArgument(call), options), written),
    ];
  }
  if (!spelled.doubles.includes(method)) {
    return [];
  }
  // A double replaces a constant only when the test makes it one.
  const parent = call.parent;
  const stubbed =
    parent !== null &&
    parent.type === "call" &&
    field(parent, "receiver")?.id === call.id &&
    calleeMethodName(parent) === spelled.constantDoubleMethod;
  return [
    withModule(
      stubbed ? moduleOfConstant(firstArgument(call), options) : null,
      written,
    ),
  ];
}

function withModule(module: string | null, written: string): TestMock {
  return module === null ? { written } : { module, written };
}

/**
 * `allow(Order).to receive(:cancel)`: the target is the argument of the
 * receiver call, and the method is the symbol at the start of the chain
 * passed to `to`. `receive_messages(cancel: 1, refund: 2)` replaces each key.
 */
function messageMocks(
  call: RbNode,
  spelled: RbTestCases["mocks"],
  options: TestUnitOptions,
  written: string,
): TestMock[] {
  const target = field(call, "receiver");
  if (
    target === null ||
    target.type !== "call" ||
    !spelled.targets.includes(calleeMethodName(target) ?? "")
  ) {
    return [];
  }
  const message = chainStart(firstArgument(call));
  if (
    message === null ||
    !spelled.messages.includes(calleeMethodName(message) ?? "")
  ) {
    return [];
  }
  const module = moduleOfConstant(firstArgument(target), options);
  return messageNames(message).map((name) => ({
    ...(module !== null ? { module } : {}),
    name,
    written,
  }));
}

function messageNames(message: RbNode): string[] {
  const args = field(message, "arguments");
  return (args === null ? [] : bodyStatements(args)).flatMap((arg) => {
    const symbol = symbolValue(arg);
    if (symbol !== null) {
      return [symbol];
    }
    const pairs =
      arg.type === "pair"
        ? [arg]
        : arg.type === "hash"
          ? bodyStatements(arg)
          : [];
    return pairs.flatMap((pair) => {
      const name = keyName(field(pair, "key"));
      return name === null ? [] : [name];
    });
  });
}

/** The innermost receiver of a chain: `receive(:x)` in `receive(:x).and_return(1)`. */
function chainStart(node: RbNode | null): RbNode | null {
  let current = node;
  while (current !== null && current.type === "call") {
    const receiver = field(current, "receiver");
    if (receiver === null || receiver.type !== "call") {
      return current;
    }
    current = receiver;
  }
  return null;
}

function firstArgument(call: RbNode): RbNode | null {
  const args = field(call, "arguments");
  return (args === null ? undefined : bodyStatements(args)[0]) ?? null;
}

/**
 * The file that defines the class or module a mock replaces, as the
 * summaries of its methods record it, or null when the target is no
 * constant the run defines. A name given as a string, as `stub_const`
 * takes it, is looked up by its qualified name.
 */
function moduleOfConstant(
  node: RbNode | null,
  options: TestUnitOptions,
): string | null {
  const facts = options.facts;
  if (node === null || facts === undefined) {
    return null;
  }
  if (node.type === "constant" || node.type === "scope_resolution") {
    const key = classBehind(facts, options.absoluteFile, node);
    return key === undefined ? null : options.displayPathOf(fileOfKey(key));
  }
  const name = literalOf(evaluatedValue(node, facts));
  const keys =
    name === null
      ? []
      : facts
          .lookup("rbConstantName", 1, name.replace(/^::/, ""))
          .map((row) => String(row[0]));
  const files = [...new Set(keys.map(fileOfKey))];
  return files.length === 1 ? options.displayPathOf(files[0] as string) : null;
}

/** The call as a finding quotes it, on one line. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}
