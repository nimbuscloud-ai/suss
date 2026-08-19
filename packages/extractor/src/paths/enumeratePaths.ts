/**
 * The path engine, written against `StructuredStatement` rather than any one
 * language. Every control-flow path from entry to a terminal contributes its
 * own conjunction of conditions, so a terminal you can reach along several
 * paths becomes several entries instead of one branch with an invented
 * conjunction, or none at all.
 *
 * Nothing here touches a language-specific AST node. A language adapter
 * lowers its own tree into `StructuredStatement` and hands that over.
 *
 * Constructs a lowering declines to model come back as thrown
 * `PathBudgetExceeded` or `UnmodeledFlow`, and the caller falls back to
 * enclosure conditions plus an opaque conjunct instead of guessing.
 */

import { CATCH_ENTRY_TEXT } from "@suss/behavioral-ir";

import type {
  CaseGroup,
  ConditionInfo,
  ConditionSource,
  ExitKind,
  StatementBlock,
  StructuredStatement,
} from "./structuredStatement.js";

/** The cap on how many paths to enumerate. Past it the caller falls back to degraded conditions. */
const MAX_PATHS = 256;

/** A construct the lowering step will not model safely, such as switch and case rules the enumeration does not cover. Callers catch this and degrade. */
export class UnmodeledFlow extends Error {}

/** The path budget was exceeded. Callers catch this and degrade. */
export class PathBudgetExceeded extends Error {}

// ---------------------------------------------------------------------------
// Path elements
// ---------------------------------------------------------------------------

/**
 * One condition on a path, before it is classified per terminal. When
 * `branchStmt` is set, how the condition ends up classified (explicit
 * versus earlyReturn or earlyThrow) depends on whether the
 * terminal being recorded is still inside that statement's own subtree.
 * When it is null, the source was already settled when the condition was
 * built: switch groups, catch entry, loop synthesis.
 */
interface PathCond<Cond> {
  readonly info: ConditionInfo<Cond>;
  readonly branchStmt: StructuredStatement<Cond> | null;
  readonly oppositeExit: ExitKind;
}

function branchCond<Cond>(
  branchStmt: StructuredStatement<Cond>,
  condition: { sourceText: string; expression: Cond | null },
  polarity: "positive" | "negative",
  oppositeExit: ExitKind,
): PathCond<Cond> {
  return {
    info: {
      sourceText: condition.sourceText,
      polarity,
      source: "explicit",
      expression: condition.expression,
    },
    branchStmt,
    oppositeExit,
  };
}

/** A condition whose source was settled when it was built: switch groups, catch entry, loop synthesis. */
function fixedCond<Cond>(
  condition: { sourceText: string; expression: Cond | null },
  polarity: "positive" | "negative",
  source: ConditionSource,
): PathCond<Cond> {
  return {
    info: {
      sourceText: condition.sourceText,
      polarity,
      source,
      expression: condition.expression,
    },
    branchStmt: null,
    oppositeExit: null,
  };
}

const loopIterationCond = <Cond>(headerText: string): PathCond<Cond> =>
  fixedCond<Cond>(
    { sourceText: `some iteration of: ${headerText}`, expression: null },
    "positive",
    "explicit",
  );

const loopCompletedCond = <Cond>(
  headerText: string,
  exit: ExitKind,
): PathCond<Cond> =>
  fixedCond<Cond>(
    {
      sourceText: `loop exited via ${exit ?? "return"}: ${headerText}`,
      expression: null,
    },
    "negative",
    exit === "throw" ? "earlyThrow" : "earlyReturn",
  );

/** The catch entry condition, stable across languages so transition IDs stay stable. */
const catchEntryCond = <Cond>(): PathCond<Cond> =>
  fixedCond<Cond>(
    { sourceText: CATCH_ENTRY_TEXT, expression: null },
    "positive",
    "catchBlock",
  );

/**
 * Settle the condition sources for one terminal. A condition whose branch
 * statement encloses the terminal's home statement is an `explicit`
 * ancestor branch. A negative condition passed on the way is an early
 * return or an early throw when the guard it failed would have left the
 * unit; when the other arm ran on and rejoined, nothing returned early
 * and the condition is as explicit as the guard itself.
 */
function classify<Cond>(
  path: PathCond<Cond>[],
  home: StructuredStatement<Cond> | null,
  isAncestorOrSelf: (
    a: StructuredStatement<Cond>,
    b: StructuredStatement<Cond>,
  ) => boolean,
): ConditionInfo<Cond>[] {
  return path.map((cond) => {
    if (cond.branchStmt === null) {
      return cond.info;
    }
    const encloses = home !== null && isAncestorOrSelf(cond.branchStmt, home);
    if (
      encloses ||
      cond.info.polarity === "positive" ||
      cond.oppositeExit === null
    ) {
      return { ...cond.info, source: "explicit" as const };
    }
    const source: ConditionSource =
      cond.oppositeExit === "throw" ? "earlyThrow" : "earlyReturn";
    return { ...cond.info, source };
  });
}

// ---------------------------------------------------------------------------
// Structural helpers over the lowered tree
// ---------------------------------------------------------------------------

/**
 * Every direct statement child, across every construct that has one. A
 * callback body counts: the statements in it belong to this statement,
 * which is what makes a terminal inside one findable and gives its
 * conditions somewhere to hang.
 */
function childrenOf<Cond>(
  stmt: StructuredStatement<Cond>,
): StatementBlock<Cond> {
  return [...ownBlocksOf(stmt), ...(stmt.callbacks ?? []).flat()];
}

function ownBlocksOf<Cond>(
  stmt: StructuredStatement<Cond>,
): StatementBlock<Cond> {
  if (stmt.kind === "if") {
    return stmt.elseBody === null
      ? stmt.thenBody
      : [...stmt.thenBody, ...stmt.elseBody];
  }
  if (stmt.kind === "switch") {
    return stmt.groups.flatMap((g) => g.body);
  }
  if (stmt.kind === "loop") {
    return stmt.body;
  }
  if (stmt.kind === "try") {
    return [
      ...stmt.tryBody,
      ...(stmt.catchBody ?? []),
      ...(stmt.finallyBody ?? []),
    ];
  }
  return [];
}

/**
 * Does this statement's subtree contain a bare `break` that does not belong
 * to a nested loop or switch, since those own their own breaks? Every clause
 * in a switch or match must either end its own path or be the case this
 * check clears, or the whole switch degrades rather than guess where the
 * jump goes.
 */
function hasStrayBreak<Cond>(nodes: StatementBlock<Cond>): boolean {
  return nodes.some((node) => {
    if (node.kind === "exit" && node.exit === "break") {
      return true;
    }
    if (node.kind === "switch" || node.kind === "loop") {
      return false;
    }
    return hasStrayBreak(ownBlocksOf(node));
  });
}

function exitKindOfList<Cond>(stmts: StatementBlock<Cond>): ExitKind {
  let sawReturn = false;
  for (const stmt of stmts) {
    if (stmt.exitKind === "throw") {
      return "throw";
    }
    if (stmt.exitKind === "return") {
      sawReturn = true;
    }
  }
  return sawReturn ? "return" : null;
}

// ---------------------------------------------------------------------------
// Enumeration state
// ---------------------------------------------------------------------------

interface EngineState<Cond, Terminal> {
  byTerminal: Map<Terminal, ConditionInfo<Cond>[][]>;
  fallthrough: ConditionInfo<Cond>[][];
  pathCount: number;
  /**
   * One collector per callback body currently being walked, innermost
   * last. A return or a throw inside a callback leaves the callback and
   * not the unit, so its path goes here and the enclosing flow picks it
   * up again once the callback is done.
   */
  callbackExits: PathCond<Cond>[][][];
}

interface Ctx<Cond, Terminal> {
  readonly terminalsByStmt: ReadonlyMap<
    StructuredStatement<Cond>,
    readonly Terminal[]
  >;
  readonly state: EngineState<Cond, Terminal>;
  readonly isAncestorOrSelf: (
    a: StructuredStatement<Cond>,
    b: StructuredStatement<Cond>,
  ) => boolean;
}

function chargeBudget(
  state: Pick<EngineState<unknown, unknown>, "pathCount">,
): void {
  state.pathCount++;
  if (state.pathCount > MAX_PATHS) {
    throw new PathBudgetExceeded(
      `path budget exceeded, more than ${MAX_PATHS} paths`,
    );
  }
}

function recordTerminal<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  terminal: Terminal,
  home: StructuredStatement<Cond>,
  path: PathCond<Cond>[],
): void {
  chargeBudget(ctx.state);
  const info = classify(path, home, ctx.isAncestorOrSelf);
  const existing = ctx.state.byTerminal.get(terminal) ?? [];
  existing.push(info);
  ctx.state.byTerminal.set(terminal, existing);
}

/** Does this statement's subtree contain any of the terminals the caller gave us? */
function containsTerminal<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  stmt: StructuredStatement<Cond>,
): boolean {
  if ((ctx.terminalsByStmt.get(stmt)?.length ?? 0) > 0) {
    return true;
  }
  return childrenOf(stmt).some((child) => containsTerminal(ctx, child));
}

// ---------------------------------------------------------------------------
// Per-kind step handlers
// ---------------------------------------------------------------------------

function stepIf<Cond, Terminal>(
  stmt: Extract<StructuredStatement<Cond>, { kind: "if" }>,
  path: PathCond<Cond>[],
  ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  const thenExit = exitKindOfList(stmt.thenBody);
  const elseExit =
    stmt.elseBody === null ? null : exitKindOfList(stmt.elseBody);

  const thenPath = [
    ...path,
    branchCond(stmt, stmt.condition, "positive", elseExit),
  ];
  // An else somebody wrote is an arm rather than the path left over
  // after a guard, so failing the test is not an early return there.
  const elsePath = [
    ...path,
    branchCond(
      stmt,
      stmt.condition,
      "negative",
      stmt.elseBody === null ? thenExit : null,
    ),
  ];

  const out: PathCond<Cond>[][] = [];
  out.push(...enumerate(ctx, stmt.thenBody, thenPath));
  if (stmt.elseBody !== null) {
    out.push(...enumerate(ctx, stmt.elseBody, elsePath));
  } else {
    out.push(elsePath);
  }
  return out;
}

function stepSwitch<Cond, Terminal>(
  stmt: Extract<StructuredStatement<Cond>, { kind: "switch" }>,
  path: PathCond<Cond>[],
  ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  const out: PathCond<Cond>[][] = [];
  const negations: PathCond<Cond>[] = [];
  let defaultRanBody = false;

  for (let i = 0; i < stmt.groups.length; i++) {
    const group: CaseGroup<Cond> = stmt.groups[i] as CaseGroup<Cond>;
    const fallthroughSafe = i === stmt.groups.length - 1;

    if (hasStrayBreak(group.body)) {
      throw new UnmodeledFlow("non-trailing break in switch clause");
    }

    const groupPath =
      group.condition === null
        ? [...path, ...negations]
        : [...path, fixedCond(group.condition, "positive", "explicit")];
    const conts = enumerate(ctx, group.body, groupPath);
    if (conts.length > 0) {
      if (!group.hasTrailingBreak && !fallthroughSafe) {
        throw new UnmodeledFlow("fallthrough into a non-empty switch clause");
      }
      out.push(...conts);
    }

    if (group.condition === null) {
      defaultRanBody = true;
    } else {
      const exit = exitKindOfList(group.body);
      const negationSource: ConditionSource =
        exit === "throw"
          ? "earlyThrow"
          : exit === "return"
            ? "earlyReturn"
            : "explicit";
      negations.push(fixedCond(group.condition, "negative", negationSource));
    }
  }

  if (!defaultRanBody) {
    // No default body ran: values matching no bodied group fall
    // through the switch unchanged.
    out.push([...path, ...negations]);
  }
  return out;
}

function stepLoop<Cond, Terminal>(
  stmt: Extract<StructuredStatement<Cond>, { kind: "loop" }>,
  path: PathCond<Cond>[],
  ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  const bodyExit = exitKindOfList(stmt.body);

  if (containsTerminal(ctx, stmt)) {
    // A terminal inside the body sees the path so far, plus "some
    // iteration" (opaque, because a run may never enter the loop), plus its
    // own in-body branching. The continuations are not collected
    // here; the recursive enumerate call records them through its own
    // side effects on ctx.state.
    enumerate(ctx, stmt.body, [
      ...path,
      loopIterationCond(stmt.condition.sourceText),
    ]);
  }

  if (bodyExit !== null) {
    return [[...path, loopCompletedCond(stmt.condition.sourceText, bodyExit)]];
  }
  return [path];
}

function stepTry<Cond, Terminal>(
  stmt: Extract<StructuredStatement<Cond>, { kind: "try" }>,
  path: PathCond<Cond>[],
  ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  // A `finally` is only allowed to be cleanup. One that exits the unit, or
  // that contains a terminal the caller gave us, degrades instead: how a
  // return from a finally interleaves is not something to guess at.
  if (stmt.finallyBody !== null) {
    const finallyHasTerminal = stmt.finallyBody.some((s) =>
      containsTerminal(ctx, s),
    );
    if (exitKindOfList(stmt.finallyBody) !== null || finallyHasTerminal) {
      throw new UnmodeledFlow("finally block with exits or terminals");
    }
  }

  const out: PathCond<Cond>[][] = [];
  out.push(...enumerate(ctx, stmt.tryBody, path));
  if (stmt.catchBody !== null) {
    const catchPath = [...path, catchEntryCond<Cond>()];
    out.push(...enumerate(ctx, stmt.catchBody, catchPath));
  }
  return out;
}

/**
 * Return, throw, break, and continue all end their path. Inside a
 * callback, a return or a throw ends the callback rather than the unit,
 * so the path is handed to the callback's collector and the enclosing
 * flow resumes from it.
 */
function stepExit<Cond, Terminal>(
  stmt: Extract<StructuredStatement<Cond>, { kind: "exit" }>,
  path: PathCond<Cond>[],
  ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  const collector = ctx.state.callbackExits[ctx.state.callbackExits.length - 1];
  if (
    collector !== undefined &&
    (stmt.exit === "return" || stmt.exit === "throw")
  ) {
    collector.push(path);
  }
  return [];
}

/** Anything else is a pass-through, because it does not branch the path. */
function stepOpaque<Cond, Terminal>(
  _stmt: Extract<StructuredStatement<Cond>, { kind: "opaque" }>,
  path: PathCond<Cond>[],
  _ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  return [path];
}

// A dispatch table with the generics erased, the same way the RawEffect and
// RawTerminal converters do it: build once against `unknown`, narrow each
// key with `Extract`, and cast at the single call site below.
// Cond and Terminal are erased at runtime, so that cast is exact.
type AnyStructuredStatement = StructuredStatement<unknown>;
type AnyPathCond = PathCond<unknown>;
type AnyCtx = Ctx<unknown, unknown>;

type StepHandlers = {
  [K in AnyStructuredStatement["kind"]]: (
    stmt: Extract<AnyStructuredStatement, { kind: K }>,
    path: AnyPathCond[],
    ctx: AnyCtx,
  ) => AnyPathCond[][];
};

const stepHandlers: StepHandlers = {
  if: stepIf,
  switch: stepSwitch,
  loop: stepLoop,
  try: stepTry,
  exit: stepExit,
  opaque: stepOpaque,
};

/**
 * Walk one callback body and give back every path through it: the ones
 * that ran off its end, plus the ones a return or a throw ended, since
 * neither ends the unit. An empty result would mean nothing gets past
 * the statement, which is never true of a callback.
 */
function stepCallback<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  body: StatementBlock<Cond>,
  path: PathCond<Cond>[],
): PathCond<Cond>[][] {
  const exits: PathCond<Cond>[][] = [];
  ctx.state.callbackExits.push(exits);
  let fellThrough: PathCond<Cond>[][];
  try {
    fellThrough = enumerate(ctx, body, path);
  } finally {
    ctx.state.callbackExits.pop();
  }
  const out = [...fellThrough, ...exits];
  return out.length === 0 ? [path] : out;
}

function stepStatement<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  stmt: StructuredStatement<Cond>,
  path: PathCond<Cond>[],
): PathCond<Cond>[][] {
  // The callbacks run first, so a statement that ends the path, such as
  // `return chain.then(cb)`, still gets what the callback decided.
  let paths: PathCond<Cond>[][] = [path];
  for (const body of stmt.callbacks ?? []) {
    paths = paths.flatMap((each) => stepCallback(ctx, body, each));
  }

  const ownTerminals = ctx.terminalsByStmt.get(stmt) ?? [];
  for (const each of withRejoined(paths)) {
    for (const terminal of ownTerminals) {
      recordTerminal(ctx, terminal, stmt, each);
    }
  }

  const handler = stepHandlers[stmt.kind] as (
    stmt: AnyStructuredStatement,
    path: AnyPathCond[],
    ctx: AnyCtx,
  ) => AnyPathCond[][];
  return paths.flatMap(
    (each) =>
      handler(
        stmt as AnyStructuredStatement,
        each as AnyPathCond[],
        ctx as AnyCtx,
      ) as PathCond<Cond>[][],
  );
}

/**
 * Enumerate paths through a statement list. Returns the condition prefixes
 * of every path that falls through past the end, which are the continuations
 * the caller resumes from.
 */
/**
 * The one position where two paths disagree about the same branch, or null
 * when they disagree about nothing or about more than that. Conditions from a
 * shared prefix are the same objects, so this compares by identity.
 */
function soleDisagreement<Cond>(
  left: PathCond<Cond>[],
  right: PathCond<Cond>[],
): number | null {
  if (left.length !== right.length) {
    return null;
  }
  let found: number | null = null;
  for (let at = 0; at < left.length; at++) {
    const one = left[at];
    const other = right[at];
    if (one === other) {
      continue;
    }
    if (found !== null) {
      return null;
    }
    if (
      one === undefined ||
      other === undefined ||
      one.branchStmt === null ||
      one.branchStmt !== other.branchStmt ||
      one.info.polarity === other.info.polarity
    ) {
      return null;
    }
    found = at;
  }
  return found;
}

/**
 * Two paths that reach the next statement differing only over one branch
 * reach it whether that branch fired or not, so the two become one path
 * without it. The arms recorded their own terminals on the way through
 * and keep their conditions. This is what stops a run of guards
 * multiplying: nine that each rejoin are one path into the next
 * statement rather than five hundred and twelve. Nothing asks it of the
 * paths a body hands back, since no statement follows those, and what
 * they still say about the branch is the body's last word.
 */
function mergeRejoined<Cond>(paths: PathCond<Cond>[][]): PathCond<Cond>[][] {
  let current = paths;
  for (let round = 0; round < current.length; round++) {
    const out: PathCond<Cond>[][] = [];
    const taken = new Set<number>();
    let mergedAny = false;
    for (let i = 0; i < current.length; i++) {
      if (taken.has(i)) {
        continue;
      }
      let combined = current[i] as PathCond<Cond>[];
      for (let j = i + 1; j < current.length; j++) {
        if (taken.has(j)) {
          continue;
        }
        const at = soleDisagreement(combined, current[j] as PathCond<Cond>[]);
        if (at === null) {
          continue;
        }
        combined = [...combined.slice(0, at), ...combined.slice(at + 1)];
        taken.add(j);
        mergedAny = true;
        break;
      }
      out.push(combined);
    }
    current = out;
    if (!mergedAny) {
      break;
    }
  }
  return current;
}

/**
 * The paths as walked, and, when some of them rejoined, what they come
 * to with the branch they disagreed over taken back off. Both are true
 * of the code: each arm of a closing `if`/`else` says what it did, and
 * the rejoined path says the unit got here whichever arm ran, which is
 * what makes it the default. Nothing is added when nothing rejoined,
 * so a guard that ended one arm early leaves no such claim behind.
 */
function withRejoined<Cond>(paths: PathCond<Cond>[][]): PathCond<Cond>[][] {
  const merged = mergeRejoined(paths);
  return merged.length === paths.length ? paths : [...merged, ...paths];
}

function enumerate<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  stmts: StatementBlock<Cond>,
  prefix: PathCond<Cond>[],
): PathCond<Cond>[][] {
  let frontiers: PathCond<Cond>[][] = [[...prefix]];

  for (const stmt of stmts) {
    const nextFrontiers: PathCond<Cond>[][] = [];
    for (const path of mergeRejoined(frontiers)) {
      nextFrontiers.push(...stepStatement(ctx, stmt, path));
    }
    frontiers = nextFrontiers;
    if (frontiers.length > MAX_PATHS) {
      throw new PathBudgetExceeded(
        `path budget exceeded, more than ${MAX_PATHS} paths`,
      );
    }
    if (frontiers.length === 0) {
      break; // every path exited, the rest is unreachable
    }
  }
  return frontiers;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface StructuredPathConditionsInput<Cond, Terminal> {
  /** The unit's top-level statements, in source order. */
  statements: StatementBlock<Cond>;
  /**
   * Every StructuredStatement reachable from `statements`, mapped to the
   * terminals the caller gave us that sit directly at that node: its own
   * position (a return, throw, or opaque leaf) or, for a branching
   * construct, its header or test expression. A lowering builds this at the
   * same time as the tree, so the engine never walks a raw source AST to
   * find where a terminal lives.
   */
  terminalsByStmt: ReadonlyMap<StructuredStatement<Cond>, readonly Terminal[]>;
}

export interface StructuredPathConditionsResult<Cond, Terminal> {
  /** The paths to each terminal, keyed by the caller's own terminal handle. */
  byTerminal: Map<Terminal, ConditionInfo<Cond>[][]>;
  /** Condition lists for paths that fall through the end of the body. */
  fallthrough: ConditionInfo<Cond>[][];
}

function buildParentMap<Cond>(
  statements: StatementBlock<Cond>,
): Map<StructuredStatement<Cond>, StructuredStatement<Cond> | null> {
  const parentOf = new Map<
    StructuredStatement<Cond>,
    StructuredStatement<Cond> | null
  >();
  const visit = (
    stmt: StructuredStatement<Cond>,
    parent: StructuredStatement<Cond> | null,
  ): void => {
    parentOf.set(stmt, parent);
    for (const child of childrenOf(stmt)) {
      visit(child, stmt);
    }
  };
  for (const stmt of statements) {
    visit(stmt, null);
  }
  return parentOf;
}

/**
 * Work out the conditions on each path, for every StructuredStatement
 * reachable from `input.statements`. Throws `PathBudgetExceeded` when the
 * path count crosses the cap, or `UnmodeledFlow` when a switch or match
 * turns up that the enumeration does not cover (a stray break, an unsafe
 * fallthrough). The caller catches both and degrades to enclosure conditions
 * plus an opaque conjunct, rather than claiming something it did not read.
 */
export function enumerateStructuredPaths<Cond, Terminal>(
  input: StructuredPathConditionsInput<Cond, Terminal>,
): StructuredPathConditionsResult<Cond, Terminal> {
  const parentOf = buildParentMap(input.statements);
  const isAncestorOrSelf = (
    a: StructuredStatement<Cond>,
    b: StructuredStatement<Cond>,
  ): boolean => {
    let current: StructuredStatement<Cond> | null = b;
    while (current !== null) {
      if (current === a) {
        return true;
      }
      current = parentOf.get(current) ?? null;
    }
    return false;
  };

  const state: EngineState<Cond, Terminal> = {
    byTerminal: new Map(),
    fallthrough: [],
    pathCount: 0,
    callbackExits: [],
  };
  const ctx: Ctx<Cond, Terminal> = {
    terminalsByStmt: input.terminalsByStmt,
    state,
    isAncestorOrSelf,
  };

  const continuations = withRejoined(enumerate(ctx, input.statements, []));
  for (const path of continuations) {
    chargeBudget(state);
    state.fallthrough.push(classify(path, null, isAncestorOrSelf));
  }

  return { byTerminal: state.byTerminal, fallthrough: state.fallthrough };
}

/**
 * Enumerate, and when the engine gives up say so instead of throwing. Each
 * terminal comes back reachable under one condition nobody can read, which
 * keeps everything the caller already knew about it. A caller that can do
 * better, by walking the terminal's own ancestors for the conditions that
 * enclose it, should.
 */
export function enumerateOrDegrade<Cond, Terminal>(
  input: StructuredPathConditionsInput<Cond, Terminal>,
  terminals: Iterable<Terminal>,
): StructuredPathConditionsResult<Cond, Terminal> & {
  /** Why the engine gave up, or null when it read the whole body. */
  degraded: string | null;
} {
  try {
    return { ...enumerateStructuredPaths(input), degraded: null };
  } catch (error) {
    const reason = reasonToDegrade(error);
    if (reason === null) {
      throw error;
    }
    const marker: ConditionInfo<Cond> = {
      sourceText: `unmodeled control flow (${reason})`,
      polarity: "positive",
      source: "explicit",
      expression: null,
    };
    const byTerminal = new Map<Terminal, ConditionInfo<Cond>[][]>();
    for (const terminal of terminals) {
      byTerminal.set(terminal, [[marker]]);
    }
    return { byTerminal, fallthrough: [[marker]], degraded: reason };
  }
}

/** What to say about an error the engine threw, or null when it is not one of its own. */
function reasonToDegrade(error: unknown): string | null {
  if (error instanceof PathBudgetExceeded) {
    return error.message === "" ? "path budget exceeded" : error.message;
  }
  if (error instanceof UnmodeledFlow) {
    return error.message;
  }
  return null;
}
