/**
 * RSpec examples as `test` units, so a PRD scenario can list the test
 * that covers it under `coveredBy` and the intent check can ask what the
 * test reaches. The rspec pack declares its groups, examples, shared
 * groups and hooks, and `@suss/recognize` finds them through the module
 * ops. An example also runs every `before` hook and `let!` around it and
 * each `let` or `subject` it reads by name, worked out from its block
 * alone so a scan the cache replays reads the same blocks. What a group's
 * `let` and `subject` give is stated here over the parse tree, before
 * the value facts exist. The adapter's DESIGN.md says more.
 */

import { testUnitName } from "@suss/behavioral-ir";
import { isListedTestFile } from "@suss/extractor";
import {
  callCaseRuns,
  caseAt,
  collectsFile,
  isRunnerCall,
  mockRead,
} from "@suss/recognize";
import { factCallOps, factValueOps } from "@suss/recognize/ops";
import { fileOfKey, isObserved } from "@suss/resolution";
import { literalOf } from "@suss/values";

import {
  bodyStatements,
  children,
  field,
  rangeOf,
  spanOf,
  symbolValue,
} from "./ast.js";
import { classBehind } from "./baseClass.js";
import { rubyModuleOps } from "./declaredDiscovery.js";
import { factSourceOf } from "./factSource.js";
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
import { evaluatedValue, nodeOfResolutionKey } from "./values/evaluator.js";

import type { TestMetadata, TestMock } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallCases,
  CallOps,
  MockRule,
  RawCodeStructure,
  SharedInclude,
  ValueOps,
} from "@suss/extractor";
import type {
  CaseRun,
  CaseRunsWith,
  CaseTitle,
  MockRead,
} from "@suss/recognize";
import type { GroupNames } from "./facts/specNames.js";
import type { RbExpectations, RbTestCases, RubyPack } from "./pack.js";
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

/** Whether the pattern reads the file's examples: the runner collects it, and the PRDs list it when they list any. */
function readsFile(pattern: RbTestCases, file: string): boolean {
  return (
    collectsFile(pattern.cases, file) &&
    isListedTestFile(file, pattern.cases.files.listed)
  );
}

export function exampleReads(
  patterns: readonly RbTestCases[],
  facts: Database,
  shared: SharedGroupIndex | undefined,
  classTests: ((node: RbNode, file: string) => ExampleRun | null) | null,
): ExampleReads | undefined {
  if (patterns.length === 0 && classTests === null) {
    return undefined;
  }
  const examples = new ExampleRuns(patterns, facts, shared);
  return {
    runOf: (node, file) =>
      examples.runOf(node, file) ?? classTests?.(node, file) ?? null,
  };
}

/** One example as nodes: its block, the groups it runs through and the blocks that run before it. */
interface Example {
  readonly block: RbNode;
  /** The file the block is written in, which a shared example's includer is not. */
  readonly file: string;
  /** Each group around it, outermost first, followed by the shared groups it includes in place. */
  readonly groups: readonly RbNode[];
  readonly before: readonly RbNode[];
}

/**
 * The run of each example block the reach walk asks about. A block is
 * read once, unless a recording cache has to see every read the answer
 * makes.
 */
class ExampleRuns {
  private readonly known = new Map<string, ExampleRun | null>();

  constructor(
    private readonly patterns: readonly RbTestCases[],
    private readonly facts: Database,
    private readonly shared: SharedGroupIndex | undefined,
  ) {}

  runOf(node: RbNode, file: string): ExampleRun | null {
    const call = node.parent;
    const method =
      BLOCK_TYPES.has(node.type) && call?.type === "call"
        ? calleeMethodName(call)
        : undefined;
    const patterns =
      method === undefined
        ? []
        : this.patterns.filter((pattern) => declaresExample(pattern, method));
    if (patterns.length === 0) {
      return null;
    }
    const key = nodeId(file, node);
    const observed = isObserved(this.facts);
    const known = observed ? undefined : this.known.get(key);
    if (known !== undefined) {
      return known;
    }
    const found = this.read(node, file, key, patterns);
    if (!observed) {
      this.known.set(key, found);
    }
    return found;
  }

  private read(
    node: RbNode,
    file: string,
    key: string,
    patterns: readonly RbTestCases[],
  ): ExampleRun | null {
    const source = factSourceOf(this.facts);
    const root = node.tree.rootNode as RbNode;
    const module = rubyModuleOps(root, file, this.facts, source);
    const block = factValueOps(key, source);
    for (const pattern of patterns) {
      const run = caseAt(pattern.cases, block, {
        module,
        ...(this.shared === undefined ? {} : { shared: this.shared }),
      });
      const example =
        run === null ? null : exampleOf(node, file, run, this.facts);
      if (example !== null) {
        return exampleRun(example, pattern, this.shared, this.facts);
      }
    }
    return null;
  }
}

/** Whether the pattern's examples are declared with this method, which the reader then asks about. */
function declaresExample(pattern: RbTestCases, method: string): boolean {
  const cases = pattern.cases.calls?.cases;
  return (
    cases !== undefined &&
    (cases.names.includes(method) || (cases.skipped ?? []).includes(method))
  );
}

/** The example as nodes, or null when something it runs has no node in the run. */
function exampleOf(
  block: RbNode,
  file: string,
  run: CaseRunsWith,
  facts: Database,
): Example | null {
  const groups = nodesAt(run.groups ?? [], facts);
  const before = nodesAt(run.before, facts);
  return groups === null || before === null
    ? null
    : { block, file, groups, before };
}

function nodesAt(
  written: readonly (CallOps | ValueOps)[],
  facts: Database,
): RbNode[] | null {
  const nodes: RbNode[] = [];
  for (const one of written) {
    const site = one.site?.();
    const node = site === undefined ? null : nodeOfResolutionKey(site, facts);
    if (node === null) {
      return null;
    }
    nodes.push(node);
  }
  return nodes;
}

/** One `let`, `subject` or hook written directly in a group. */
interface GroupBlock {
  readonly block: RbNode;
  /** The names an example reads it through, empty for a hook. */
  readonly names: readonly string[];
  /** The names that give back the block's value, which `is_expected` does not. */
  readonly values: readonly string[];
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
  const named = firstSymbol(call);
  const values = [...pattern.lazyValues, ...pattern.eagerValues];
  if (values.includes(method) && named !== null) {
    return { block, names: [named], values: [named] };
  }
  const subjects = [
    ...pattern.subjectNames.lazy,
    ...pattern.subjectNames.eager,
  ];
  if (subjects.includes(method)) {
    // Every way the library spells a read of the subject reaches this block.
    const extra = named === null ? [] : [named];
    return {
      block,
      names: [...pattern.subjectReads, ...extra],
      values: [pattern.subjectValue, pattern.expectations.onSubject, ...extra],
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
  /** Whether the group's body includes a shared group. */
  readonly includes: boolean;
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
    scopeRoleOf(group, pattern) === "opensGroup" &&
    first !== null &&
    CLASS_TYPES.has(first.type)
      ? first
      : null;
  return {
    values,
    described,
    includes: groupStatements(group).some(
      (statement) => sharedIncludeOf(statement, pattern) !== null,
    ),
  };
}

function groupStatements(group: RbNode): RbNode[] {
  const groupBlock = field(group, "block");
  const body = groupBlock === null ? null : field(groupBlock, "body");
  return body === null ? [] : bodyStatements(body);
}

type ScopeRole = "opensGroup" | "sharedGroup" | null;

/**
 * Whether a call opens a group or writes a shared group, read off the
 * parse tree for the name scope, which is stated before the facts the
 * reader asks exist. A group may be opened on the runner's global.
 */
function scopeRoleOf(node: RbNode, pattern: RbTestCases): ScopeRole {
  const calls = pattern.cases.calls;
  if (
    calls === undefined ||
    node.type !== "call" ||
    field(node, "block") === null
  ) {
    return null;
  }
  const method = calleeMethodName(node);
  const receiver = field(node, "receiver");
  if (
    method === undefined ||
    (receiver !== null && !globalsOf(calls).includes(receiver.text))
  ) {
    return null;
  }
  const groups = [...calls.groups.names, ...(calls.groups.skipped ?? [])];
  if (groups.includes(method)) {
    return "opensGroup";
  }
  return (calls.shared?.names ?? []).includes(method) ? "sharedGroup" : null;
}

function globalsOf(calls: CallCases): readonly string[] {
  return "paths" in calls.from ? calls.from.paths : [];
}

/** How this call includes a shared group, or null when it includes none. */
function sharedIncludeOf(
  node: RbNode,
  pattern: RbTestCases,
): SharedInclude | null {
  if (node.type !== "call" || field(node, "receiver") !== null) {
    return null;
  }
  const method = calleeMethodName(node);
  const includes = pattern.cases.calls?.shared?.includes ?? [];
  return includes.find((one) => one.method === method) ?? null;
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
      const role = scopeRoleOf(up, pattern);
      if (role === null) {
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
      if (including === null && scope.includes) {
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
    patterns.find((one) => readsFile(one, file)) ??
    patterns.find((one) => definesSharedGroups(root, one)) ??
    null;
  registerGroupNames(root, pattern === null ? null : groupNamesIn(pattern));
  return pattern;
}

/** Whether a file defines a shared group at its top level, or as a statement of a group. */
function definesSharedGroups(root: RbNode, pattern: RbTestCases): boolean {
  const visit = (node: RbNode): boolean =>
    children(node).some((child) => {
      const role = scopeRoleOf(child, pattern);
      if (role === "sharedGroup") {
        return true;
      }
      if (role === "opensGroup") {
        const block = field(child, "block");
        return block !== null && visit(block);
      }
      return (
        (child.type === "body_statement" || child.type === "block_body") &&
        visit(child)
      );
    });
  return visit(root);
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
      const opensScope =
        scopeRoleOf(child, pattern) !== null ||
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
 * The blocks an example runs: its own, then each value it reads by name
 * from the nearest group that defines it, followed through the values
 * those read, then the hooks and eager values that run before it.
 */
function exampleRun(
  example: Example,
  pattern: RbTestCases,
  shared: SharedGroupIndex | undefined,
  facts: Database,
): ExampleRun {
  const byName = new Map<string, RbNode>();
  for (const group of example.groups) {
    for (const one of groupBlocks(group, pattern)) {
      for (const name of one.names) {
        byName.set(name, one.block);
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
  for (const block of example.before) {
    include(block);
  }
  const valueNames = new Set([
    ...byName.keys(),
    ...pattern.subjectReads,
    pattern.describedClass,
  ]);
  const fileOf = (node: RbNode): string =>
    node.tree === example.block.tree
      ? example.file
      : (shared?.fileOf(node) ?? example.file);
  const source = factSourceOf(facts);
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
      const ops = factCallOps(nodeId(fileOf(call), call), source);
      return ops !== null && isRunnerCall(pattern.cases, ops);
    },
    predicateOf: (call) => predicateCallOf(call, pattern),
    fileOf,
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
    (pattern.cases.runner?.names ?? []).includes(name)
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
  const facts = options.facts;
  if (facts === undefined) {
    return [];
  }
  return patterns.flatMap((pattern) => {
    if (!readsFile(pattern, options.absoluteFile)) {
      return [];
    }
    const source = factSourceOf(facts);
    const module = rubyModuleOps(root, options.absoluteFile, facts, source);
    const runs = callCaseRuns(pattern.cases, {
      module,
      ...(options.shared === undefined ? {} : { shared: options.shared }),
    });
    return runs.flatMap((run) => {
      const raw = exampleUnit(run, pattern, facts, options);
      return raw === null ? [] : [raw];
    });
  });
}

export type Title = CaseTitle;

/** The unit for one example the reader found, or null when its block or where it is recorded has no node in the run. */
function exampleUnit(
  run: CaseRun,
  pattern: RbTestCases,
  facts: Database,
  options: TestUnitOptions,
): RawCodeStructure | null {
  const site = run.found.runs?.site?.();
  const block = site === undefined ? null : nodeOfResolutionKey(site, facts);
  const anchor = nodeOfResolutionKey(run.found.at, facts);
  const example =
    site === undefined || block === null
      ? null
      : exampleOf(block, fileOfKey(site), run, facts);
  if (example === null || anchor === null) {
    return null;
  }
  const running = exampleRun(example, pattern, options.shared, facts);
  const rules = pattern.cases.mocks ?? [];
  const raw = testUnitOf({
    titles: run.found.titles,
    run: running,
    // A pack that writes no mock rule needs no ops for its calls.
    mocks:
      rules.length === 0
        ? []
        : running.blocks.flatMap((one) =>
            mocksIn(one, rules, facts, {
              ...options,
              absoluteFile: options.shared?.fileOf(one) ?? options.absoluteFile,
            }),
          ),
    skipped: run.found.skipped,
    anchor,
    body: example.block,
    options,
  });
  options.onSeed(raw, example.block, example.file);
  return raw;
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
 * Every mock a block sets up, in source order: each call written in it,
 * however deep, read against the runner's mock rules. A lambda or a
 * block inside it counts, since a mock there runs with it.
 */
function mocksIn(
  block: RbNode,
  rules: readonly MockRule[],
  facts: Database,
  options: TestUnitOptions,
): TestMock[] {
  const source = factSourceOf(facts);
  const found: TestMock[] = [];
  const visit = (node: RbNode): void => {
    for (const child of children(node)) {
      const ops =
        child.type === "call"
          ? factCallOps(nodeId(options.absoluteFile, child), source)
          : null;
      const read = ops === null ? null : mockRead(rules, ops, takesNothing);
      if (read !== null) {
        found.push(...mocksOf(child, read, options));
      }
      visit(child);
    }
  };
  visit(block);
  return found;
}

/** A call written in an example takes no fixture, so no patcher is handed one. */
function takesNothing(): boolean {
  return false;
}

function noMocks(): TestMock[] {
  return [];
}

function mocksOf(
  call: RbNode,
  read: MockRead,
  options: TestUnitOptions,
): TestMock[] {
  return (
    MOCKS[read.replaces] as (
      call: RbNode,
      read: MockRead,
      options: TestUnitOptions,
    ) => TestMock[]
  )(call, read, options);
}

/**
 * A mock as the checker matches it: the file that defines the class or
 * the constant it replaces, the member's name when it replaces one, and
 * the call on one line. RSpec's rules read members, constants and
 * stand-ins, and no path.
 */
const MOCKS: {
  readonly [K in MockRead["replaces"]]: (
    call: RbNode,
    read: Extract<MockRead, { readonly replaces: K }>,
    options: TestUnitOptions,
  ) => TestMock[];
} = {
  path: noMocks,
  member: noMocks,
  members: (call, read, options) => {
    const target = field(call, "receiver");
    const module =
      target === null
        ? null
        : moduleOfConstant(argumentAt(target, read.receiverArgument), options);
    return read.members.map((name) => ({
      ...(module === null ? {} : { module }),
      name,
      written: oneLine(call.text),
    }));
  },
  constant: (call, read, options) => [
    withModule(
      moduleOfConstant(argumentAt(call, read.at), options),
      oneLine(call.text),
    ),
  ],
  standIn: (call, read, options) => [
    withModule(
      read.at === null
        ? null
        : moduleOfConstant(argumentAt(call, read.at), options),
      oneLine(call.text),
    ),
  ],
};

function withModule(module: string | null, written: string): TestMock {
  return module === null ? { written } : { module, written };
}

export function firstArgument(call: RbNode): RbNode | null {
  return argumentAt(call, 0);
}

/** The argument written at this position, a keyword pair included. */
function argumentAt(call: RbNode, at: number): RbNode | null {
  const args = field(call, "arguments");
  return (args === null ? undefined : bodyStatements(args)[at]) ?? null;
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
