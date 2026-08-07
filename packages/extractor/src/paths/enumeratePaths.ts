// enumeratePaths.ts: the CFG-semantics path engine, generic over
// StructuredStatement. Every entry-to-terminal control-flow path
// contributes its own condition conjunction, so a terminal reached
// along several paths becomes several path entries instead of one
// branch with a fabricated (or missing) conjunction.
//
// This module never touches a language-specific AST node. A language
// adapter lowers its own tree into StructuredStatement (see
// structuredStatement.ts) and hands the result here; everything below
// walks that shape alone. Shapes a lowering declines to model degrade
// at the caller, by catching PathBudgetExceeded or UnmodeledFlow and
// falling back to enclosure conditions plus an opaque conjunct, sound
// under-specification rather than a fabricated claim.
//
// Ported from the TypeScript adapter's original paths/pathConditions.ts,
// unchanged in behavior: same per-path enumeration, same case-group
// and loop-opacification treatment, same budget.

import type {
  CaseGroup,
  ConditionInfo,
  ConditionSource,
  ExitKind,
  StatementBlock,
  StructuredStatement,
} from "./structuredStatement.js";

/** Path-count cap; beyond it the caller falls back to degraded conditions. */
const MAX_PATHS = 256;

/** A shape the lowering step declines to model soundly (switch/case rules the enumeration doesn't cover). Callers degrade on catch. */
export class UnmodeledFlow extends Error {}

/** The path budget was exceeded. Callers degrade on catch. */
export class PathBudgetExceeded extends Error {}

// ---------------------------------------------------------------------------
// Path elements
// ---------------------------------------------------------------------------

/**
 * One condition on a path, before per-terminal source classification.
 * `branchStmt` non-null means the condition's final classification
 * (explicit vs. earlyReturn/earlyThrow) depends on whether the
 * terminal it's being recorded for still sits inside that statement's
 * own subtree; null means the source was already decided at
 * construction time (switch groups, catch entry, loop synthesis).
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

/** A pre-classified condition (source decided at construction time): switch groups, catch entry, loop synthesis. */
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
    { sourceText: "catch", expression: null },
    "positive",
    "catchBlock",
  );

/**
 * Finalize condition sources for one terminal: a condition whose branch
 * statement encloses the terminal's home statement is an `explicit`
 * ancestor branch; a negative condition passed on the way (the guard
 * didn't fire) is an early return/throw.
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
    if (encloses || cond.info.polarity === "positive") {
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

/** Every direct statement child, across every construct that has one. */
function childrenOf<Cond>(
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
 * Does this statement's subtree hold a bare `break` that doesn't belong
 * to a nested loop or switch (those own their own breaks)? Every clause
 * in a switch/match must either end its own path or be the shape this
 * check clears, or the whole switch degrades rather than guess at the
 * jump target.
 */
function hasStrayBreak<Cond>(nodes: StatementBlock<Cond>): boolean {
  return nodes.some((node) => {
    if (node.kind === "exit" && node.exit === "break") {
      return true;
    }
    if (node.kind === "switch" || node.kind === "loop") {
      return false;
    }
    return hasStrayBreak(childrenOf(node));
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
    throw new PathBudgetExceeded();
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

/** Does this statement's subtree hold any of the caller's given terminals? */
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
  const armsExit = stmt.exitKind !== null;
  const armsHaveTerminals = containsTerminal(ctx, stmt);

  // Neither arm exits nor holds a terminal: the branch cannot
  // discriminate anything downstream, so collapse to a pass-through.
  if (!armsExit && !armsHaveTerminals) {
    return [path];
  }

  const thenExit = exitKindOfList(stmt.thenBody);
  const elseExit =
    stmt.elseBody === null ? null : exitKindOfList(stmt.elseBody);

  const thenPath = [
    ...path,
    branchCond(stmt, stmt.condition, "positive", elseExit),
  ];
  const elsePath = [
    ...path,
    branchCond(stmt, stmt.condition, "negative", thenExit),
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
    // Terminals inside the body see: path so far, plus "some iteration"
    // (opaque, an execution may never enter the loop), plus their
    // in-body branch structure. The continuations aren't collected
    // here; the recursive enumerate call records them via its own
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
  // A `finally` is allowed only as pure cleanup: one with unit exits or
  // caller-given terminals declines to a degraded result (returns-from-
  // finally are cursed; never fabricate their interleavings).
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

/** Return/throw/break/continue end their path. */
function stepExit<Cond, Terminal>(
  _stmt: Extract<StructuredStatement<Cond>, { kind: "exit" }>,
  _path: PathCond<Cond>[],
  _ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  return [];
}

/** Anything else is a pass-through: it doesn't branch the path. */
function stepOpaque<Cond, Terminal>(
  _stmt: Extract<StructuredStatement<Cond>, { kind: "opaque" }>,
  path: PathCond<Cond>[],
  _ctx: Ctx<Cond, Terminal>,
): PathCond<Cond>[][] {
  return [path];
}

// Erased-generic dispatch table, the same pattern @suss/extractor's own
// RawEffect/RawTerminal converters use: build once against `unknown`,
// narrow per key via `Extract`, and cast at the one call site below.
// Cond/Terminal are erased at runtime, so the cast is exact.
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

function stepStatement<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  stmt: StructuredStatement<Cond>,
  path: PathCond<Cond>[],
): PathCond<Cond>[][] {
  const ownTerminals = ctx.terminalsByStmt.get(stmt) ?? [];
  for (const terminal of ownTerminals) {
    recordTerminal(ctx, terminal, stmt, path);
  }

  const handler = stepHandlers[stmt.kind] as (
    stmt: AnyStructuredStatement,
    path: AnyPathCond[],
    ctx: AnyCtx,
  ) => AnyPathCond[][];
  return handler(
    stmt as AnyStructuredStatement,
    path as AnyPathCond[],
    ctx as AnyCtx,
  ) as PathCond<Cond>[][];
}

/**
 * Enumerate paths through a statement list. Returns the condition
 * prefixes of every path that falls through past the end (continuations
 * for the caller to resume with).
 */
function enumerate<Cond, Terminal>(
  ctx: Ctx<Cond, Terminal>,
  stmts: StatementBlock<Cond>,
  prefix: PathCond<Cond>[],
): PathCond<Cond>[][] {
  let frontiers: PathCond<Cond>[][] = [[...prefix]];

  for (const stmt of stmts) {
    const nextFrontiers: PathCond<Cond>[][] = [];
    for (const path of frontiers) {
      nextFrontiers.push(...stepStatement(ctx, stmt, path));
    }
    frontiers = nextFrontiers;
    if (frontiers.length > MAX_PATHS) {
      throw new PathBudgetExceeded();
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
   * Every StructuredStatement reachable from `statements`, mapped to
   * the caller-given terminals that live directly at that node: its
   * own position (a return/throw/opaque leaf) or, for a branching
   * construct, its header/test expression. A lowering builds this
   * alongside the tree; the engine never walks a raw source AST to
   * find a terminal's home.
   */
  terminalsByStmt: ReadonlyMap<StructuredStatement<Cond>, readonly Terminal[]>;
}

export interface StructuredPathConditionsResult<Cond, Terminal> {
  /** Per-terminal paths, keyed by the caller's own terminal handle. */
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
 * Compute per-path conditions for every StructuredStatement reachable
 * from `input.statements`. Throws `PathBudgetExceeded` when the path
 * count crosses the cap, or `UnmodeledFlow` when a switch/match shape
 * the enumeration doesn't cover appears (a stray break, an unsafe
 * fallthrough). The caller catches both and degrades to enclosure
 * conditions plus an opaque conjunct, never a fabricated claim.
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
  };
  const ctx: Ctx<Cond, Terminal> = {
    terminalsByStmt: input.terminalsByStmt,
    state,
    isAncestorOrSelf,
  };

  const continuations = enumerate(ctx, input.statements, []);
  for (const path of continuations) {
    chargeBudget(state);
    state.fallthrough.push(classify(path, null, isAncestorOrSelf));
  }

  return { byTerminal: state.byTerminal, fallthrough: state.fallthrough };
}
