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
import { registerGroupNames } from "./facts/specNames.js";
import { nodeId, readKey } from "./facts/values.js";
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
import type { GroupNames } from "./facts/specNames.js";
import type {
  RbExpectations,
  RbSharedInclude,
  RbTestCases,
  RubyPack,
} from "./pack.js";
import type { RbNode } from "./parser.js";
import type { InheritedMethods } from "./paths/effects.js";
import type { SharedGroupIndex } from "./testSharedGroups.js";

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
  /** The file a node in those blocks is written in. */
  readonly fileOf: (node: RbNode) => string;
  /** The predicate a matcher in those blocks calls, and on what, or null. */
  readonly predicateOf?: (call: RbNode) => PredicateCall | null;
}

/** A predicate a matcher calls: `local?` on `account`. */
export interface PredicateCall {
  readonly target: RbNode;
  readonly method: string;
}

/** Tells the reach walk which blocks an example runs, from the example's block alone. */
export interface ExampleReads {
  /** `file` is the file the node is written in. */
  runOf(node: RbNode, file: string): ExampleRun | null;
}

/** The run's test patterns, pooled from every pack. */
export function testPatternsIn(packs: readonly RubyPack[]): RbTestCases[] {
  return packs.flatMap((pack) => pack.tests ?? []);
}

export function exampleReads(
  patterns: readonly RbTestCases[],
  shared: SharedGroupIndex | undefined,
  classTests: ((node: RbNode, file: string) => ExampleRun | null) | null,
): ExampleReads | undefined {
  if (patterns.length === 0 && classTests === null) {
    return undefined;
  }
  return {
    runOf: (node, file) => {
      const call = node.parent;
      if (BLOCK_TYPES.has(node.type) && call !== null) {
        for (const pattern of patterns) {
          const found = exampleAt(call, file, pattern, shared);
          if (found !== null) {
            return exampleRun(found, pattern, shared);
          }
        }
      }
      return classTests?.(node, file) ?? null;
    },
  };
}

/**
 * One example, with the calls around it whose blocks it runs through,
 * outermost first: its groups, and for an example a shared group gives
 * an including group, the include and the shared group too.
 */
interface Example {
  readonly call: RbNode;
  readonly block: RbNode;
  readonly groups: readonly RbNode[];
  /** The file the example is written in, which a shared example's includer is not. */
  readonly file: string;
}

type Role = "opensGroup" | "sharedGroup" | "declaresTest" | null;

export function roleOf(node: RbNode, pattern: RbTestCases): Role {
  if (node.type !== "call" || field(node, "block") === null) {
    return null;
  }
  const method = calleeMethodName(node);
  const receiver = field(node, "receiver");
  if (method === undefined) {
    return null;
  }
  if (receiver !== null && receiver.text !== pattern.receiver) {
    return null;
  }
  if (isGroupName(method, pattern)) {
    return "opensGroup";
  }
  if (pattern.sharedGroupNames.includes(method)) {
    return "sharedGroup";
  }
  return receiver === null && isExampleName(method, pattern)
    ? "declaresTest"
    : null;
}

/** How this call includes a shared group, or null when it includes none. */
export function sharedIncludeOf(
  node: RbNode,
  pattern: RbTestCases,
): RbSharedInclude | null {
  if (node.type !== "call" || field(node, "receiver") !== null) {
    return null;
  }
  const method = calleeMethodName(node);
  return pattern.sharedIncludes.find((one) => one.method === method) ?? null;
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

/**
 * Every example in a file, in source order. An include of a shared group
 * reads the shared group's examples as though they were written there,
 * so each includer gets its own.
 */
function examplesIn(
  root: RbNode,
  file: string,
  pattern: RbTestCases,
  shared: SharedGroupIndex | undefined,
): Example[] {
  const found: Example[] = [];
  const visit = (
    node: RbNode,
    groups: readonly RbNode[],
    written: string,
  ): void => {
    for (const child of children(node)) {
      const role = roleOf(child, pattern);
      const block = field(child, "block");
      if (role === "sharedGroup") {
        continue;
      }
      if (role === "opensGroup" && block !== null) {
        visit(block, [...groups, child], written);
        continue;
      }
      if (role === "declaresTest" && block !== null) {
        if (groups.length > 0) {
          found.push({ call: child, block, groups, file: written });
        }
        continue;
      }
      const included = groups.length === 0 ? null : shared?.includedAt(child);
      if (included !== null && included !== undefined) {
        const through = included.nested ? [child] : [];
        const definition = included.definition;
        const body = field(definition.call, "block");
        if (body !== null && !groups.includes(definition.call)) {
          visit(
            body,
            [...groups, ...through, definition.call],
            definition.file,
          );
        }
        continue;
      }
      visit(child, groups, written);
    }
  };
  visit(root, [], file);
  return found;
}

/**
 * The example whose call this is, with its groups, or null when the call
 * declares none. An example in a shared group runs through its includer's
 * groups when one group includes it; with several, which one ran is not
 * known, so it runs through the shared group's own blocks alone.
 */
function exampleAt(
  call: RbNode,
  file: string,
  pattern: RbTestCases,
  shared: SharedGroupIndex | undefined,
): Example | null {
  const block = field(call, "block");
  if (roleOf(call, pattern) !== "declaresTest" || block === null) {
    return null;
  }
  const groups: RbNode[] = [];
  for (let above = call.parent; above !== null; above = above.parent) {
    const role = roleOf(above, pattern);
    if (role === "sharedGroup") {
      const definition = shared?.definitionAt(above);
      if (definition === undefined || definition === null) {
        return null;
      }
      const [only, ...others] = shared?.includersOf(definition) ?? [];
      const outer =
        only === undefined || others.length > 0
          ? []
          : [...only.groups, ...(only.nested ? [only.call] : [])];
      return { call, block, groups: [...outer, above, ...groups], file };
    }
    if (role === "opensGroup") {
      groups.unshift(above);
    }
  }
  return groups.length === 0 ? null : { call, block, groups, file };
}

/** One `let`, `subject` or hook written directly in a group. */
interface GroupBlock {
  readonly block: RbNode;
  /** The names an example reads it through, empty for a hook. */
  readonly names: readonly string[];
  /** The names that give back the block's value, which `is_expected` does not. */
  readonly values: readonly string[];
  /** Whether it runs before every example whatever the example reads. */
  readonly always: boolean;
}

/** The first argument's symbol, as in `let(:order)`. */
function firstSymbol(call: RbNode): string | null {
  const first = firstArgument(call);
  return first === null ? null : symbolValue(first);
}

function groupBlocks(group: RbNode, pattern: RbTestCases): GroupBlock[] {
  const found: GroupBlock[] = [];
  for (const statement of groupStatements(group)) {
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
    return { block, names: [], values: [], always: true };
  }
  const named = firstSymbol(call);
  const lazyValue = pattern.lazyValues.includes(method);
  if ((lazyValue || pattern.eagerValues.includes(method)) && named !== null) {
    return { block, names: [named], values: [named], always: !lazyValue };
  }
  const lazySubject = pattern.subjectNames.lazy.includes(method);
  if (lazySubject || pattern.subjectNames.eager.includes(method)) {
    // Every way the library spells a read of the subject reaches this block.
    const extra = named === null ? [] : [named];
    return {
      block,
      names: [...pattern.subjectReads, ...extra],
      values: [pattern.subjectValue, pattern.expectations.onSubject, ...extra],
      always: !lazySubject,
    };
  }
  return null;
}

/** What one group defines for the examples inside it. */
export interface GroupScope {
  /** Each value the group defines, by the name that reads it, with the block that gives it. */
  readonly values: ReadonlyMap<string, RbNode>;
  /** The class the group is given, as in `describe Order`, or null. */
  readonly described: RbNode | null;
  /** The calls in the group's body that include a shared group. */
  readonly includes: readonly RbNode[];
}

const CLASS_TYPES = new Set(["constant", "scope_resolution"]);

export function groupScope(group: RbNode, pattern: RbTestCases): GroupScope {
  const values = new Map<string, RbNode>();
  for (const one of groupBlocks(group, pattern)) {
    for (const name of one.values) {
      values.set(name, one.block);
    }
  }
  const first = firstArgument(group);
  const described =
    roleOf(group, pattern) === "opensGroup" &&
    first !== null &&
    CLASS_TYPES.has(first.type)
      ? first
      : null;
  return {
    values,
    described,
    includes: groupStatements(group).filter(
      (statement) => sharedIncludeOf(statement, pattern) !== null,
    ),
  };
}

function groupStatements(group: RbNode): RbNode[] {
  const groupBlock = field(group, "block");
  const body = groupBlock === null ? null : field(groupBlock, "body");
  return body === null ? [] : bodyStatements(body);
}

/** The test pattern that reads this file, or null when none does or the file is not on its list. */
export function patternForFile(
  file: string,
  patterns: readonly RbTestCases[],
): RbTestCases | null {
  return (
    patterns.find(
      (pattern) =>
        matchesTestFileName(file, pattern.filePatterns) &&
        isListedTestFile(file, pattern.files),
    ) ?? null
  );
}

/**
 * Which group a name read at a node belongs to. The nearest group that
 * defines the name wins. `described_class` and an implicit subject come
 * from the nearest group given a class, which RSpec reads the same way.
 * Past those, a name belongs to the nearest group that includes a shared
 * group, which may define it, and inside a shared group to the shared
 * group, whose includers supply it. The run binds both once every file
 * is in.
 */
function groupNamesIn(pattern: RbTestCases): GroupNames {
  const scopes = new Map<number, GroupScope>();
  const scopeOf = (group: RbNode): GroupScope => {
    const known = scopes.get(group.id);
    if (known !== undefined) {
      return known;
    }
    const found = groupScope(group, pattern);
    scopes.set(group.id, found);
    return found;
  };
  const fromClass = new Set([
    pattern.describedClass,
    pattern.subjectValue,
    pattern.expectations.onSubject,
  ]);
  const owner = (node: RbNode, name: string): RbNode | null => {
    let classGroup: RbNode | null = null;
    let including: RbNode | null = null;
    for (let up = node.parent; up !== null; up = up.parent) {
      const role = roleOf(up, pattern);
      if (role !== "opensGroup" && role !== "sharedGroup") {
        continue;
      }
      const scope = scopeOf(up);
      if (scope.values.has(name)) {
        return up;
      }
      if (role === "sharedGroup" && name === pattern.describedClass) {
        return classGroup ?? up;
      }

      if (role === "sharedGroup") {
        return including ?? up;
      }
      if (classGroup === null && scope.described !== null) {
        classGroup = up;
      }
      if (including === null && scope.includes.length > 0) {
        including = up;
      }
    }
    if (fromClass.has(name) && classGroup !== null) {
      return classGroup;
    }
    return including;
  };
  return {
    owner,
    classRead: (node) => {
      const name = node.text;
      if (name !== pattern.describedClass) {
        return null;
      }
      const group = owner(node, name);
      return group === null ? null : scopeOf(group).described;
    },
    readsClass: (node) =>
      node.text === pattern.describedClass && owner(node, node.text) !== null,
  };
}

/**
 * Registers which group each name in a test file belongs to, before the
 * file's value facts are emitted, and clears it for any other file. A
 * file that defines shared groups, as a support file does, counts too.
 */
export function registerTestFileNames(
  file: string,
  root: RbNode,
  patterns: readonly RbTestCases[],
): RbTestCases | null {
  const pattern =
    patternForFile(file, patterns) ??
    patterns.find((one) => definesSharedGroups(root, one)) ??
    null;
  registerGroupNames(root, pattern === null ? null : groupNamesIn(pattern));
  return pattern;
}

/** Whether a file defines a shared group at its top level. */
function definesSharedGroups(root: RbNode, pattern: RbTestCases): boolean {
  return sharedGroupsIn(root, pattern).length > 0;
}

/** The shared group definitions written at the top of a file, or inside a group. */
export function sharedGroupsIn(root: RbNode, pattern: RbTestCases): RbNode[] {
  const found: RbNode[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const role = roleOf(child, pattern);
      if (role === "sharedGroup") {
        found.push(child);
        continue;
      }
      if (role === "opensGroup" || child.type === "program") {
        const block = field(child, "block");
        if (block !== null) {
          visit(block);
        }
        continue;
      }
      if (child.type === "body_statement" || child.type === "block_body") {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

/**
 * The facts that give each group's values to the names that read them.
 * A `let` or `subject` block is a function its name runs, and a group
 * given a class with no subject of its own has one of that class as its
 * subject. `described_class` needs no fact, since it reads as the class.
 */
export function emitGroupFacts(
  db: Database,
  file: string,
  root: RbNode,
  pattern: RbTestCases,
): void {
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const role = roleOf(child, pattern);
      const opensScope =
        role === "opensGroup" ||
        role === "sharedGroup" ||
        (sharedIncludeOf(child, pattern) !== null &&
          field(child, "block") !== null);
      if (opensScope) {
        emitOneGroup(db, file, child, pattern);
      }
      visit(child);
    }
  };
  visit(root);
}

function emitOneGroup(
  db: Database,
  file: string,
  group: RbNode,
  pattern: RbTestCases,
): void {
  const scope = groupScope(group, pattern);
  const groupKey = nodeId(file, group);
  for (const [name, block] of scope.values) {
    const blockKey = nodeId(file, block);
    db.add("func", [blockKey]);
    db.add("binds", [`${groupKey}#${name}`, blockKey]);
  }
  if (scope.described === null) {
    return;
  }
  const classKey = readKey(file, scope.described, null);
  const described = `${groupKey}:${pattern.describedClass}`;
  db.add("func", [described]);
  db.add("returnsValue", [described, classKey]);
  db.add("binds", [`${groupKey}#${pattern.describedClass}`, described]);
  if (scope.values.has(pattern.subjectValue)) {
    return;
  }
  const subject = `${groupKey}:${pattern.subjectValue}`;
  const made = `${subject}:new`;
  db.add("func", [subject]);
  db.add("returnsValue", [subject, made]);
  db.add("instanceOf", [made, classKey]);
  db.add("binds", [`${groupKey}#${pattern.subjectValue}`, subject]);
  db.add("binds", [`${groupKey}#${pattern.expectations.onSubject}`, subject]);
}

/**
 * The groups an example runs through, each followed by the shared groups
 * it includes in place, whose hooks and values run as its own.
 */
function withInlineIncludes(
  groups: readonly RbNode[],
  pattern: RbTestCases,
  shared: SharedGroupIndex | undefined,
): RbNode[] {
  return groups.flatMap((group) => [
    group,
    ...groupScope(group, pattern).includes.flatMap((call) => {
      const included = shared?.includedAt(call);
      return included === null || included === undefined || included.nested
        ? []
        : [included.definition.call];
    }),
  ]);
}

/** Nodes from any number of files, each counted once. */
class NodesSeen {
  private readonly byTree = new WeakMap<object, Set<number>>();

  /** Adds the node, and says whether it was new. */
  add(node: RbNode): boolean {
    const seen = this.byTree.get(node.tree) ?? new Set<number>();
    this.byTree.set(node.tree, seen);
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  }
}

/**
 * The blocks an example runs: its own, the hooks and eager values of
 * every group around it, and each value it reads by name from the
 * nearest group that defines it, followed through the values those read.
 */
function exampleRun(
  example: Example,
  pattern: RbTestCases,
  shared: SharedGroupIndex | undefined,
): ExampleRun {
  const byName = new Map<string, RbNode>();
  const always: RbNode[] = [];
  for (const group of withInlineIncludes(example.groups, pattern, shared)) {
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
  const included = new NodesSeen();
  const include = (block: RbNode): void => {
    if (!included.add(block)) {
      return;
    }
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
  const valueNames = new Set([
    ...byName.keys(),
    ...pattern.subjectReads,
    pattern.describedClass,
  ]);
  const isRunnerMethod = (name: string | null): boolean =>
    name !== null &&
    (pattern.runnerMethods.includes(name) ||
      pattern.predicateMatchers.some((one) => name.startsWith(one.prefix)));
  return {
    blocks,
    isRunnerCall: (call) => {
      const read = nameReadAt(call);
      if (read !== null && valueNames.has(read)) {
        return true;
      }
      if (predicateCallOf(call, pattern) !== null) {
        return false;
      }
      return isRunnerMethod(chainOrigin(call));
    },
    predicateOf: (call) => predicateCallOf(call, pattern),
    fileOf: (node) =>
      node.tree === example.block.tree
        ? example.file
        : (shared?.fileOf(node) ?? example.file),
  };
}

/**
 * The predicate a matcher calls, and the value it calls it on:
 * `be_local` in `expect(account).to be_local` calls `local?` on
 * `account`, and in `is_expected.to be_local` on the subject, which
 * `is_expected` reads as. Null for any other call.
 */
function predicateCallOf(
  call: RbNode,
  pattern: RbTestCases,
): PredicateCall | null {
  const name = calleeMethodName(call);
  if (
    name === undefined ||
    field(call, "receiver") !== null ||
    pattern.runnerMethods.includes(name)
  ) {
    return null;
  }
  const matcher = pattern.predicateMatchers.find(
    (one) => name.startsWith(one.prefix) && name.length > one.prefix.length,
  );
  const run = expectationRunOf(call, pattern.expectations);
  const target =
    run === null ? null : expectationTarget(run, pattern.expectations);
  if (matcher === undefined || target === null) {
    return null;
  }
  const predicate = name.slice(matcher.prefix.length);
  return {
    target,
    method: `${matcher.methodPrefix}${predicate}${matcher.methodSuffix}`,
  };
}

/** The `to` call a matcher is the first argument of, or null. */
function expectationRunOf(
  matcher: RbNode,
  expectations: RbExpectations,
): RbNode | null {
  const list = matcher.parent;
  const run = list?.type === "argument_list" ? list.parent : null;
  return run !== null &&
    run !== undefined &&
    run.type === "call" &&
    expectations.runs.includes(calleeMethodName(run) ?? "") &&
    firstArgument(run)?.id === matcher.id
    ? run
    : null;
}

/** What an expectation is about: the argument of `expect(x)`, or `is_expected` itself. */
function expectationTarget(
  run: RbNode,
  expectations: RbExpectations,
): RbNode | null {
  const start = field(run, "receiver");
  if (start === null) {
    return null;
  }
  const name = calleeMethodName(start);
  if (name === expectations.onSubject && field(start, "receiver") === null) {
    return start;
  }
  return name !== undefined &&
    expectations.starts.includes(name) &&
    field(start, "receiver") === null &&
    field(start, "block") === null
    ? firstArgument(start)
    : null;
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
  /** Called for each example, so the reach walk starts at its block, in the file the block is written in. */
  readonly onSeed: (raw: RawCodeStructure, block: RbNode, file: string) => void;
  /** The run's shared groups, so an include reads the shared examples. */
  readonly shared?: SharedGroupIndex | undefined;
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
    return examplesIn(root, options.absoluteFile, pattern, options.shared).map(
      (example) => {
        const raw = exampleUnit(example, pattern, root, options);
        options.onSeed(raw, example.block, example.file);
        return raw;
      },
    );
  });
}

export interface Title {
  readonly text: string;
  readonly unresolved: boolean;
}

/**
 * Each title in an example's name. A shared group adds none of its own,
 * and an include adds one only when it nests the examples, as
 * `it_behaves_like "x"` adds "behaves like x".
 */
function titlesOf(
  example: Example,
  pattern: RbTestCases,
  facts: Database | undefined,
): Title[] {
  return [...example.groups, example.call].flatMap((call): Title[] => {
    if (roleOf(call, pattern) === "sharedGroup") {
      return [];
    }
    const include = sharedIncludeOf(call, pattern);
    if (include === null) {
      return [titleOf(call, facts)];
    }
    if (include.nestedTitle === undefined) {
      return [];
    }
    const name = titleOf(call, facts);
    return [{ ...name, text: `${include.nestedTitle} ${name.text}` }];
  });
}

/** Where the unit is recorded: the example, or for a shared example, the include that brought it here. */
function anchorOf(example: Example, root: RbNode): RbNode {
  if (example.call.tree === root.tree) {
    return example.call;
  }
  return (
    [...example.groups].reverse().find((one) => one.tree === root.tree) ??
    example.call
  );
}

function exampleUnit(
  example: Example,
  pattern: RbTestCases,
  root: RbNode,
  options: TestUnitOptions,
): RawCodeStructure {
  const run = exampleRun(example, pattern, options.shared);
  return testUnitOf({
    titles: titlesOf(example, pattern, options.facts),
    run,
    mocks: run.blocks.flatMap((block) =>
      mocksIn(block, pattern.mocks, {
        ...options,
        absoluteFile: options.shared?.fileOf(block) ?? options.absoluteFile,
      }),
    ),
    skipped: isSkipped(example, pattern),
    anchor: anchorOf(example, root),
    body: example.block,
    options,
  });
}

/** What a test unit is built from, whichever runner declared the test. */
export interface TestUnitParts {
  readonly titles: readonly Title[];
  readonly run: ExampleRun;
  readonly mocks: readonly TestMock[];
  readonly skipped: boolean;
  /** Where the unit is recorded in the file being read. */
  readonly anchor: RbNode;
  /** The test's own block or method, whose body says whether it is empty. */
  readonly body: RbNode;
  readonly options: TestUnitOptions;
}

/** A `test` unit: its calls are every call the blocks it runs make, less the runner's own. */
export function testUnitOf(parts: TestUnitParts): RawCodeStructure {
  const { titles, run, mocks, anchor, options } = parts;
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
  const unresolved = titles.find((title) => title.unresolved);
  const test: TestMetadata = {
    ...(parts.skipped ? { skipped: true } : {}),
    ...(mocks.length > 0 ? { mocks: [...mocks] } : {}),
    ...(unresolved !== undefined ? { unresolvedTitle: unresolved.text } : {}),
  };
  const range = rangeOf(anchor);
  return {
    identity: {
      name: testUnitName(titles.map((title) => title.text)),
      nameKind: "label",
      kind: "test",
      file: options.filePath,
      range,
      span: spanOf(anchor),
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
    bodyContent: field(parts.body, "body") === null ? "empty" : "statements",
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
export function skipsAsItRuns(
  block: RbNode,
  statements: readonly string[],
): boolean {
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

export function firstArgument(call: RbNode): RbNode | null {
  const args = field(call, "arguments");
  return (args === null ? undefined : bodyStatements(args)[0]) ?? null;
}

/**
 * The file that defines the class or module a mock replaces, as the
 * summaries of its methods record it, or null when the target is no
 * constant the run defines. A name given as a string, as `stub_const`
 * takes it, is looked up by its qualified name.
 */
export function moduleOfConstant(
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
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}
