/**
 * Test cases a runner writes as calls: vitest's
 * `describe("orders", () => { it("cancels", () => ...) })`, and RSpec's
 * `describe Order do it "cancels" do ... end end`.
 *
 * Each runner call the file writes is walked up to the nearest runner
 * call around it, which puts them in a tree, and the cases are read off
 * it from the top the way the runner collects them. An include reads its
 * shared group's cases in its place, through the table of the run's
 * shared groups the adapter hands in, since a shared group is often
 * written in another file. The recognize DESIGN.md says what the walk
 * reads at each step.
 */

import { matchesTestFileName } from "@suss/extractor";
import { bySourceOrder } from "@suss/resolution";

import { isWrittenOnSelf } from "./classBody.js";
import { mockRead, skipsAsItRuns, symbolAt } from "./testCases.js";

import type {
  CallCases,
  CallOps,
  ModuleOps,
  SharedInclude,
  TestCasesMatch,
  ValueOps,
} from "@suss/extractor";
import type {
  CaseReading,
  CaseRun,
  CaseTitle,
  FoundCase,
  FoundMock,
  MockRead,
} from "./testCases.js";

type Role = "group" | "case" | "shared" | "include";

/** One call the runner reads as a group, a case, a shared group or an include of one. */
interface RunnerCall {
  readonly call: CallOps;
  readonly site: string;
  readonly role: Role;
  /** Whether its own name, a modifier written after it, or metadata it is given skips it. */
  readonly skipped: boolean;
  /** Whether a modifier such as `each` declares one case per row, each titled by its row. */
  readonly perRow: boolean;
  /** How it includes a shared group, for an include. */
  readonly include?: SharedInclude;
}

/** What the runner runs with a case: the runner calls whose bodies it runs through, and the blocks that run first. */
export type CaseRunsWith = Pick<CaseRun, "before" | "groups">;

/** The cases the runner writes as calls in the module, in the order the runner collects them. */
export function callCases(
  match: TestCasesMatch,
  module: ModuleOps,
): FoundCase[] {
  return callCaseRuns(match, { module }).map((run) => run.found);
}

/**
 * The same, each with what the runner runs with it. An include reads the
 * cases of the shared group `read.shared` says it includes in its place,
 * and a case it reads from another file is recorded at the include, or
 * at the innermost group around the include, in this file.
 */
export function callCaseRuns(
  match: TestCasesMatch,
  read: CaseReading,
): CaseRun[] {
  const calls = match.calls;
  const names = calls === undefined ? null : runnerNamesIn(calls, read.module);
  if (calls === undefined || names === null) {
    return [];
  }
  return new CaseCalls(match, calls, names, read).cases();
}

/**
 * What the runner runs with the case whose body this is, read from the
 * body up, so a file the cache replays reads the same blocks. A case in
 * a shared group runs through the groups around its one include; with
 * more than one, which ran is not known, and it runs through the shared
 * group's own. Null when the body is no case's, or the case is in a
 * shared group the run does not read.
 */
export function caseAt(
  match: TestCasesMatch,
  body: ValueOps,
  read: CaseReading,
): CaseRunsWith | null {
  const calls = match.calls;
  const names = calls === undefined ? null : runnerNamesIn(calls, read.module);
  const call = calls === undefined ? null : caseCallOf(body, calls);
  if (calls === undefined || names === null || call === null) {
    return null;
  }
  const reading = new CaseCalls(match, calls, names, read);
  if (reading.runnerOf(call)?.role !== "case") {
    return null;
  }
  const groups: CallOps[] = [];
  for (let at = stepUp({ call }); at !== null; at = stepUp(at)) {
    const runner = "call" in at ? reading.runnerOf(at.call) : null;
    if (runner?.role === "shared") {
      const outer = reading.aroundOnlyInclude(runner.site);
      return outer === null
        ? null
        : reading.runsWith([...outer, runner.call, ...groups]);
    }
    if (runner?.role === "group") {
      groups.unshift(runner.call);
    }
  }
  return groups.length === 0 && calls.topLevelCases === false
    ? null
    : reading.runsWith(groups);
}

/** The shared groups a module writes, and where it includes one, which the adapter keeps as the run's table. */
export interface SharedGroupsWritten {
  /** Each shared group written at the top of the file or as a statement of a group, by its title. */
  readonly definitions: readonly {
    readonly call: CallOps;
    readonly title: string;
  }[];
  /** Each include inside a group or a shared group, by the title it includes, with the groups and shared groups around it, outermost first. */
  readonly includes: readonly {
    readonly call: CallOps;
    readonly title: string;
    readonly groups: readonly CallOps[];
    /** Whether it runs the shared cases in a group of their own. */
    readonly nests: boolean;
  }[];
}

export function sharedGroupsWritten(
  match: TestCasesMatch,
  module: ModuleOps,
): SharedGroupsWritten {
  const calls = match.calls;
  const names =
    calls?.shared === undefined ? null : runnerNamesIn(calls, module);
  if (calls === undefined || names === null) {
    return { definitions: [], includes: [] };
  }
  const reading = new CaseCalls(match, calls, names, { module });
  return {
    definitions: reading.definitionsIn(module.bodyCalls()),
    includes: reading.includesIn(),
  };
}

/** The call whose body this is, as the match says a body is written. */
function caseCallOf(body: ValueOps, calls: CallCases): CallOps | null {
  if (calls.body === "block") {
    return body.blockCall?.() ?? null;
  }
  const passed = body.passedTo?.() ?? null;
  const fn = passed === null ? null : caseFunction(passed.call);
  return fn !== null && fn.site?.() === body.site?.()
    ? (passed?.call ?? null)
    : null;
}

/** One case the walk reached, with the runner calls around it, outermost first. */
interface Reached {
  readonly runner: RunnerCall;
  readonly around: readonly RunnerCall[];
}

/** A mock call, what it replaces, and the nearest runner call around it. */
interface MockAt {
  readonly mock: FoundMock;
  readonly scope: string | null;
}

/** One reading of the calls form over one module, and over the shared groups its includes read. */
class CaseCalls {
  /** The tree of each body already read, by the site of the shared group it is, or `null` for the module. */
  private readonly trees = new Map<string | null, RunnerTree>();

  constructor(
    private readonly match: TestCasesMatch,
    private readonly calls: CallCases,
    private readonly names: RunnerNames,
    private readonly read: CaseReading,
  ) {}

  runnerOf(call: CallOps): RunnerCall | null {
    const site = call.site?.();
    const runner =
      site === undefined
        ? null
        : runnerCallOf(call, this.names, this.calls, this.match);
    return site === undefined || runner === null
      ? null
      : { ...runner, call, site };
  }

  cases(): CaseRun[] {
    const tree = this.moduleTree();
    const reached: Reached[] = [];
    this.collect(tree, null, [], reached);
    return reached.map(({ runner, around }) => {
      const inScope = new Set([...around.map((one) => one.site), runner.site]);
      const runs = this.bodyOf(runner.call);
      const found: FoundCase = {
        titles: [...around.flatMap(titlesOf), ownTitle(runner)],
        runs,
        at: this.recordedAt(runner, around),
        markers: [],
        skipped:
          [...around, runner].some((one) => one.skipped) ||
          [runs, ...around.flatMap((one) => this.beforeBlocks(one.call))].some(
            (fn) => skipsAsItRuns(this.match.skips, fn),
          ),
        mocks: tree.mocks
          .filter((one) => one.scope === null || inScope.has(one.scope))
          .map((one) => one.mock),
      };
      return { found, ...this.runsWith(around.map((one) => one.call)) };
    });
  }

  /** The runner calls a case runs through, each followed by the shared groups it includes in place, and the blocks that run first. */
  runsWith(around: readonly CallOps[]): CaseRunsWith {
    const groups = around.flatMap((call) => [call, ...this.inPlace(call)]);
    return {
      groups,
      before: groups.flatMap((call) => this.beforeBlocks(call)),
    };
  }

  /**
   * The groups and shared groups around the one include of the shared
   * group defined at this site, and the include when it nests its cases,
   * or none when the shared group has another number of includes. Null
   * when the run does not read the shared group.
   */
  aroundOnlyInclude(definition: string): CallOps[] | null {
    const shared = this.read.shared;
    if (shared === undefined || !shared.defines(definition)) {
      return null;
    }
    const [only, ...others] = shared.includersOf(definition);
    if (only === undefined || others.length > 0) {
      return [];
    }
    const nests = this.runnerOf(only.call)?.include?.nestedTitle;
    return [...only.groups, ...(nests === undefined ? [] : [only.call])];
  }

  definitionsIn(
    statements: readonly CallOps[],
  ): SharedGroupsWritten["definitions"] {
    return ownStatements(statements).flatMap((call) => {
      const runner = this.runnerOf(call);
      if (runner?.role === "shared") {
        const title = stringAt(call, 0);
        return title === null ? [] : [{ call, title }];
      }
      if (runner?.role === "group") {
        return this.definitionsIn(this.bodyOf(call)?.bodyCalls?.() ?? []);
      }
      return [];
    });
  }

  /** Every include with a group or a shared group around it, the walk stopping at each one it records. */
  includesIn(): SharedGroupsWritten["includes"] {
    const tree = this.moduleTree();
    const found: SharedGroupsWritten["includes"][number][] = [];
    const visit = (parent: string | null, around: CallOps[]): void => {
      for (const runner of tree.children(parent)) {
        if (runner.role === "include" && around.length > 0) {
          const title = stringAt(runner.call, 0);
          if (title !== null) {
            found.push({
              call: runner.call,
              title,
              groups: around,
              nests: runner.include?.nestedTitle !== undefined,
            });
          }
          continue;
        }
        const opens = runner.role === "group" || runner.role === "shared";
        visit(runner.site, opens ? [...around, runner.call] : around);
      }
    };
    visit(null, []);
    return found;
  }

  private moduleTree(): RunnerTree {
    const known = this.trees.get(null);
    if (known !== undefined) {
      return known;
    }
    const tree = this.treeOver(this.read.module.calls("file"), []);
    this.trees.set(null, tree);
    return tree;
  }

  /** The tree inside a shared group: this module's when it writes the group, else one over the calls the group's body writes. */
  private sharedTree(definition: RunnerCall): RunnerTree {
    const module = this.moduleTree();
    if (module.has(definition.site)) {
      return module;
    }
    const known = this.trees.get(definition.site);
    if (known !== undefined) {
      return known;
    }
    const tree = this.treeOver(this.bodyOf(definition.call)?.calls?.() ?? [], [
      definition,
    ]);
    this.trees.set(definition.site, tree);
    return tree;
  }

  private treeOver(
    written: readonly CallOps[],
    roots: readonly RunnerCall[],
  ): RunnerTree {
    const runners = new Map(roots.map((one) => [one.site, one]));
    const mocks: (KeyedCall & { readonly read: MockRead })[] = [];
    for (const { call, site } of keyedCalls(written)) {
      const runner = runnerCallOf(call, this.names, this.calls, this.match);
      if (runner !== null) {
        runners.set(site, { ...runner, call, site });
        continue;
      }
      // A case written as a call takes no fixture, so no patcher is handed one.
      const read = mockRead(this.match.mocks ?? [], call, takesNoFixture);
      if (read !== null) {
        mocks.push({ call, site, read });
      }
    }
    return new RunnerTree(runners, mocks);
  }

  /**
   * The cases under one runner call, or at the top of the module when it
   * is null, as the runner collects them from the top: nothing inside a
   * case is read, and a shared group only through an include.
   */
  private collect(
    tree: RunnerTree,
    parent: string | null,
    around: readonly RunnerCall[],
    reached: Reached[],
  ): void {
    for (const runner of tree.children(parent)) {
      if (runner.role === "group") {
        this.collect(tree, runner.site, [...around, runner], reached);
        continue;
      }
      if (runner.role === "case") {
        if (around.length > 0 || this.calls.topLevelCases !== false) {
          reached.push({ runner, around });
        }
        continue;
      }
      if (runner.role === "include") {
        this.collectIncluded(tree, runner, around, reached);
      }
    }
  }

  /**
   * An include with no group around it, or whose title is no shared
   * group the run reads, is read through as though it were not there.
   * One that includes a shared group the walk is already inside reads
   * nothing.
   */
  private collectIncluded(
    tree: RunnerTree,
    include: RunnerCall,
    around: readonly RunnerCall[],
    reached: Reached[],
  ): void {
    const definition =
      around.length === 0
        ? null
        : (this.read.shared?.includedAt(include.site) ?? null);
    const shared = definition === null ? null : this.runnerOf(definition);
    if (shared === null) {
      this.collect(tree, include.site, around, reached);
      return;
    }
    if (around.some((one) => one.site === shared.site)) {
      return;
    }
    const nests = include.include?.nestedTitle !== undefined;
    this.collect(
      this.sharedTree(shared),
      shared.site,
      [...around, ...(nests ? [include] : []), shared],
      reached,
    );
  }

  /** The case's call when this module writes it, or else the innermost runner call around it that the module writes. */
  private recordedAt(
    runner: RunnerCall,
    around: readonly RunnerCall[],
  ): string {
    const path = this.read.module.path();
    const here = [...around, runner]
      .reverse()
      .find((one) => (one.call.file?.() ?? path) === path);
    return (here ?? runner).site;
  }

  private bodyOf(call: CallOps): ValueOps | null {
    return this.calls.body === "block"
      ? (call.block?.() ?? null)
      : caseFunction(call);
  }

  /** The blocks of the `before.calls` calls a group writes on self as its own statements, in order. */
  private beforeBlocks(group: CallOps): ValueOps[] {
    const names = this.match.before?.calls ?? [];
    if (names.length === 0) {
      return [];
    }
    return this.statementsOf(group).flatMap((call) => {
      const block = names.includes(call.calleeText())
        ? (call.block?.() ?? null)
        : null;
      return block === null ? [] : [block];
    });
  }

  /** The shared groups a group includes in place, with no group of their own, as its own statements. */
  private inPlace(group: CallOps): CallOps[] {
    const shared = this.read.shared;
    if (shared === undefined) {
      return [];
    }
    return this.statementsOf(group).flatMap((call) => {
      const include = this.runnerOf(call)?.include;
      const definition =
        include === undefined || include.nestedTitle !== undefined
          ? null
          : shared.includedAt(call.site?.() ?? "");
      return definition === null ? [] : [definition];
    });
  }

  /** The calls a group's body writes on self as its own statements. */
  private statementsOf(group: CallOps): CallOps[] {
    return ownStatements(this.bodyOf(group)?.bodyCalls?.() ?? []).filter(
      isWrittenOnSelf,
    );
  }
}

/** Calls a body writes as its own statements, and not inside another statement such as an `if`. */
function ownStatements(statements: readonly CallOps[]): CallOps[] {
  return statements.filter((call) => call.nestedBodyCall?.() !== true);
}

/** A call and its key. */
interface KeyedCall {
  readonly call: CallOps;
  readonly site: string;
}

/** The calls the adapter keys, since a runner call is kept by its key. */
function keyedCalls(written: readonly CallOps[]): KeyedCall[] {
  return written.flatMap((call) => {
    const site = call.site?.();
    return site === undefined ? [] : [{ call, site }];
  });
}

/**
 * The runner calls one body writes, each under the nearest runner call
 * around it, and the mocks it writes. A mock applies to a case when the
 * nearest runner call around the mock is the case or one around it.
 */
class RunnerTree {
  private readonly under = new Map<string | null, RunnerCall[]>();
  /** The nearest runner call above each step a walk passed, so a walk up stops where another one already went. */
  private readonly above = new Map<string, RunnerCall | null>();
  readonly mocks: readonly MockAt[];

  constructor(
    private readonly runners: ReadonlyMap<string, RunnerCall>,
    mocks: readonly (KeyedCall & { readonly read: MockRead })[],
  ) {
    for (const runner of runners.values()) {
      const parent = this.nearestAbove({ call: runner.call })?.site ?? null;
      const siblings = this.under.get(parent) ?? [];
      siblings.push(runner);
      this.under.set(parent, siblings);
    }
    for (const siblings of this.under.values()) {
      siblings.sort((a, b) => bySourceOrder(a.site, b.site));
    }
    this.mocks = mocks.map(({ call, read }) => ({
      mock: { call, read },
      scope: this.nearestAbove({ call })?.site ?? null,
    }));
  }

  has(site: string): boolean {
    return this.runners.has(site);
  }

  children(parent: string | null): readonly RunnerCall[] {
    return this.under.get(parent) ?? [];
  }

  /** The code a call is written in nests, so the walk ends at the top of the file. */
  private nearestAbove(from: Step): RunnerCall | null {
    const passed: string[] = [];
    let found: RunnerCall | null = null;
    for (let at = stepUp(from); at !== null; at = stepUp(at)) {
      const site = siteOf(at);
      const known = site === undefined ? undefined : this.knownAt(at, site);
      if (known !== undefined) {
        found = known;
        break;
      }
      passed.push(...(site === undefined ? [] : [site]));
    }
    for (const site of passed) {
      this.above.set(site, found);
    }
    return found;
  }

  /** The runner call a step is, or the one a walk already found above it. */
  private knownAt(at: Step, site: string): RunnerCall | null | undefined {
    const runner = "call" in at ? this.runners.get(site) : undefined;
    return runner ?? this.above.get(site);
  }
}

/** A call, or a function or block, as a walk up passes it. */
type Step = { readonly call: CallOps } | { readonly body: ValueOps };

function siteOf(step: Step): string | undefined {
  return "call" in step ? step.call.site?.() : step.body.site?.();
}

/**
 * One step up: to the call the code is passed to in place, or for a
 * block to the call it is written with, or else to the body it is
 * written in. Null at the top of the file.
 */
function stepUp(from: Step): Step | null {
  const written = "call" in from ? from.call : from.body;
  const passed = written.passedTo?.()?.call ?? null;
  if (passed !== null) {
    return { call: passed };
  }
  const blockCall = "body" in from ? (from.body.blockCall?.() ?? null) : null;
  if (blockCall !== null) {
    return { call: blockCall };
  }
  const body = written.enclosingBody?.() ?? null;
  return body === null ? null : { body };
}

function takesNoFixture(): boolean {
  return false;
}

/** How one module spells the runner's functions: a call to the runner's name it starts from and the modifiers after it, or null. */
type RunnerNames = (call: CallOps) => Chain | null;

/** A callee as the runner's name it starts from and the modifiers written after it. */
interface Chain {
  readonly root: string;
  readonly modifiers: readonly string[];
  readonly perRow: boolean;
}

/** How each kind of `from` spells the runner's functions in a module, or null when the module spells none of them. */
const SPELLINGS: {
  readonly [K in CallCases["from"]["origin"]]: (
    calls: CallCases & { readonly from: { readonly origin: K } },
    module: ModuleOps,
  ) => RunnerNames | null;
} = {
  imported: (calls, module) => {
    const spelled = importedSpellings(calls, module);
    if (spelled.size === 0) {
      return null;
    }
    return (call) => {
      const callee = runnerCallee(call, calls);
      const root = callee === null ? undefined : spelled.get(callee.root);
      return callee === null || root === undefined ? null : { ...callee, root };
    };
  },
  // A method of the global as the source spells it, or one written on self.
  global: (calls) => {
    const names = new Set(runnerNames(calls));
    return (call) => {
      const name = isWrittenOnSelf(call) ? call.calleeText() : call.method();
      const onGlobal =
        name !== null &&
        names.has(name) &&
        (isWrittenOnSelf(call) ||
          calls.from.paths.includes(call.receiverValue?.()?.source?.() ?? ""));
      return name === null || !onGlobal
        ? null
        : { root: name, modifiers: [], perRow: false };
    };
  },
};

function runnerNamesIn(
  calls: CallCases,
  module: ModuleOps,
): RunnerNames | null {
  const spell = SPELLINGS[calls.from.origin] as (
    calls: CallCases,
    module: ModuleOps,
  ) => RunnerNames | null;
  return spell(calls, module);
}

/**
 * The local spelling of each runner function to the name the runner
 * exports it as: the file's imports from `from`, and in a file where the
 * runner's functions are globals, every one the file does not bind at its
 * top level.
 */
function importedSpellings(
  calls: CallCases & { readonly from: { readonly origin: "imported" } },
  module: ModuleOps,
): Map<string, string> {
  const names = runnerNames(calls);
  const spelled = new Map<string, string>();
  for (const [local, exported] of module.importedNames(
    calls.from.importedFrom,
  )) {
    if (names.includes(exported)) {
      spelled.set(local, exported);
    }
  }
  const globals = calls.globalsIn?.matching ?? [];
  if (!matchesTestFileName(module.path(), globals)) {
    return spelled;
  }
  for (const name of names) {
    if (!spelled.has(name) && module.bindsAtTopLevel?.(name) !== true) {
      spelled.set(name, name);
    }
  }
  return spelled;
}

function runnerNames(calls: CallCases): string[] {
  return ROLES.flatMap((one) => one.names(calls));
}

/**
 * Whether the call opens a group, declares a case, defines a shared group
 * or includes one, and how its name, its modifiers and its metadata mark
 * it. A call written with no block opens and declares nothing when the
 * runner writes its bodies as blocks.
 */
function runnerCallOf(
  call: CallOps,
  names: RunnerNames,
  calls: CallCases,
  match: TestCasesMatch,
): Omit<RunnerCall, "call" | "site"> | null {
  const callee = names(call);
  const role = callee === null ? null : roleOf(callee.root, calls);
  const bodiless =
    calls.body === "block" &&
    role !== "include" &&
    (call.block?.() ?? null) === null;
  if (callee === null || role === null || bodiless) {
    return null;
  }
  const skipModifiers = calls.modifiers?.skip ?? [];
  const skipped =
    callee.modifiers.some((modifier) => skipModifiers.includes(modifier)) ||
    (calls.groups.skipped ?? []).includes(callee.root) ||
    (calls.cases.skipped ?? []).includes(callee.root) ||
    givenSkipMetadata(call, match.skips?.metadata ?? []);
  const include = calls.shared?.includes.find(
    (one) => one.method === callee.root,
  );
  return {
    role,
    skipped,
    perRow: callee.perRow,
    ...(include === undefined ? {} : { include }),
  };
}

/** Each role and the runner's names for it, a case's first, so a name listed twice reads as a case. */
const ROLES: readonly {
  readonly role: Role;
  readonly names: (calls: CallCases) => readonly string[];
}[] = [
  {
    role: "case",
    names: (calls) => [...calls.cases.names, ...(calls.cases.skipped ?? [])],
  },
  {
    role: "group",
    names: (calls) => [...calls.groups.names, ...(calls.groups.skipped ?? [])],
  },
  { role: "shared", names: (calls) => calls.shared?.names ?? [] },
  {
    role: "include",
    names: (calls) => (calls.shared?.includes ?? []).map((one) => one.method),
  },
];

function roleOf(name: string, calls: CallCases): Role | null {
  return ROLES.find((one) => one.names(calls).includes(name))?.role ?? null;
}

/** `it "x", :skip`, or `it "x", skip: "not yet"` with a value written as anything but false or nil. */
function givenSkipMetadata(call: CallOps, keys: readonly string[]): boolean {
  if (keys.length === 0) {
    return false;
  }
  for (let at = 0; at < call.argumentCount(); at++) {
    const symbol = symbolAt(call.valueAt(at));
    if (symbol !== null && keys.includes(symbol)) {
      return true;
    }
  }
  return keys.some((key) => {
    const value = call.keywordAt?.(key) ?? null;
    return (
      value !== null &&
      value.literal?.() !== false &&
      value.nothing?.() !== true
    );
  });
}

/**
 * The callee's chain, and whether a modifier declares a case per row. A
 * call made on a call, `it.each(rows)("t", fn)`, reads the inner call's
 * chain, which has to end in a modifier that takes arguments. A call
 * written with one of those and nothing after it, `it.each(rows)`, only
 * hands back the function to call, and is no case.
 */
function runnerCallee(call: CallOps, calls: CallCases): Chain | null {
  const direct = chainOf(call);
  if (direct !== null) {
    return takesArguments(lastOf(direct), calls)
      ? null
      : { ...direct, perRow: false };
  }
  const inner = calledOn(call);
  const chain = inner === null ? null : chainOf(inner);
  const last = chain === null ? undefined : lastOf(chain);
  if (chain === null || last === undefined || !takesArguments(last, calls)) {
    return null;
  }
  return { ...chain, perRow: (calls.modifiers?.perRow ?? []).includes(last) };
}

/**
 * The name the callee starts from and the members read after it. A
 * callee written as a name is its own root. A method comes after what
 * its receiver gives: the receiver's spelling when it is written as a
 * name, or else the chain of the member read it is.
 */
function chainOf(call: CallOps): Omit<Chain, "perRow"> | null {
  if (call.namedCallee?.() === true) {
    return { root: call.calleeText(), modifiers: [] };
  }
  const method = call.method();
  if (method === null) {
    return null;
  }
  const receiver = call.receiverValue?.() ?? null;
  if (receiver?.form?.() === "name") {
    const root = receiver.source?.();
    return root === undefined ? null : { root, modifiers: [method] };
  }
  const member = call.member?.() ?? null;
  const inner = member === null ? null : chainOf(member);
  return inner === null
    ? null
    : { root: inner.root, modifiers: [...inner.modifiers, method] };
}

/** The call the callee is written as in place, when the callee is neither a name nor a method. */
function calledOn(call: CallOps): CallOps | null {
  if (call.namedCallee?.() === true || call.method() !== null) {
    return null;
  }
  return call.callee();
}

function lastOf(chain: Omit<Chain, "perRow">): string | undefined {
  return chain.modifiers[chain.modifiers.length - 1];
}

function takesArguments(
  modifier: string | undefined,
  calls: CallCases,
): boolean {
  const modifiers = calls.modifiers;
  return (
    modifier !== undefined &&
    modifiers !== undefined &&
    (modifiers.takingArguments.includes(modifier) ||
      modifiers.perRow.includes(modifier))
  );
}

/**
 * The titles a runner call around a case adds to the case's name. A
 * shared group adds none, and an include adds one only when it runs the
 * shared cases in a group of their own, `behaves like x`.
 */
const TITLES: Readonly<Record<Role, (runner: RunnerCall) => CaseTitle[]>> = {
  group: ownTitles,
  case: ownTitles,
  shared: () => [],
  include: (runner) => {
    const nested = runner.include?.nestedTitle;
    const title = titleOf(runner.call);
    return nested === undefined
      ? []
      : [{ ...title, text: `${nested} ${title.text}` }];
  },
};

function ownTitles(runner: RunnerCall): CaseTitle[] {
  return [titleOf(runner.call)];
}

function titlesOf(runner: RunnerCall): CaseTitle[] {
  return TITLES[runner.role](runner);
}

/**
 * A title written as a constant is its text, as in `describe Order`, and
 * one the source writes as a string is that string. Anything else keeps
 * its text as written, unresolved, and a call with no title takes its
 * block's text on one line.
 */
function titleOf(call: CallOps): CaseTitle {
  const first = call.valueAt(0);
  if (first === null) {
    const block = call.block?.()?.source?.() ?? "";
    return { text: oneLine(block), unresolved: true };
  }
  const constant = first.constantPath?.() ?? null;
  if (constant !== null) {
    return { text: constant, unresolved: false };
  }
  const value = first.evaluated?.() ?? null;
  return typeof value === "string"
    ? { text: value, unresolved: false }
    : { text: first.source?.() ?? "", unresolved: true };
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

/** A case declared once per row keeps its title as written, and that title is the unresolved one. */
function ownTitle(runner: RunnerCall): CaseTitle {
  const title = titleOf(runner.call);
  return runner.perRow ? { text: title.text, unresolved: true } : title;
}

function stringAt(call: CallOps, at: number): string | null {
  const value = call.valueAt(at)?.evaluated?.() ?? null;
  return typeof value === "string" ? value : null;
}

/** The first function passed after the title: `it(title, fn)` or `it(title, options, fn)`. */
function caseFunction(call: CallOps): ValueOps | null {
  for (let at = 1; at < call.argumentCount(); at++) {
    const fn = call.valueAt(at)?.function?.() ?? null;
    if (fn !== null) {
      return fn;
    }
  }
  return null;
}
