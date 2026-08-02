// paths/pathConditions.ts — CFG-semantics path conditions.
//
// Replaces the legacy `collectEarlyReturns` + `collectAncestorBranches`
// pair with per-path enumeration: every entry→terminal control-flow
// path contributes its own condition conjunction, so a terminal reached
// along several paths becomes several RawBranches instead of one
// branch with a fabricated (or missing) conjunction. This is
// correctness principle #1 ("every path maps to exactly one branch")
// implemented literally, and it closes the documented nested-guard and
// loop-return soundness gaps by construction:
//
//   - a guard nested one block deep contributes its real per-path
//     conditions (`if (a) { if (b) return; } T` → T gets the two paths
//     `[¬a]` and `[a, ¬b]`, not `[]` or `[¬a ∧ ¬b]`);
//   - paths that cross a loop whose body can exit the function carry an
//     explicit *opaque* condition (quantified-over-iterations facts are
//     not statically decidable — under-specify, never fabricate).
//
// Scope: the enumeration models if/else, switch (trailing-break
// bodies), loops (opaque-quantified), try/catch (opaque catch entry,
// pure-cleanup finally), break/continue (path enders), and
// expression-bodied arrows. Shapes it declines — labeled statements,
// `finally` blocks with exits or terminals, switch fallthrough into a
// non-empty clause, non-trailing switch breaks, and the path-count
// budget — DEGRADE instead of falling back to the (unsound) legacy
// collectors: every terminal gets its enclosure conditions (ancestor
// branches are true gating facts regardless of flow weirdness) plus
// one opaque "unmodeled control flow" conjunct, so the transition
// abstains rather than over- or under-claiming. Under-specify freely;
// never fabricate. Since every modeled construct is structured,
// recursive enumeration over the AST is equivalent to a query over
// the lowered CFG; the explicit cfgEdge fact materialization arrives
// with the rules engine (see docs/internal/differential-fuzzing.md
// and status.md decision #54+).
//
// Expression-level branching below a statement (ternaries, `&&`/`||`,
// case clauses inside nested callbacks) still comes from the scoped
// ancestor walker, appended after the statement-level path conditions —
// same composition order as the legacy pipeline, so condition lists
// (and therefore transition IDs) are byte-identical on shapes the
// legacy pipeline handled soundly.

import { Node, type Statement } from "ts-morph";

import {
  type ConditionInfo,
  collectAncestorConditionInfosBelow,
  type FunctionRoot,
  isAncestorOrSelf,
} from "../conditions.js";

/** Paths for one terminal: each entry is one path's condition list. */
export type TerminalPaths = ConditionInfo[][];

export interface PathConditionsResult {
  /** Per-terminal paths, keyed by terminal node. */
  byTerminal: Map<Node, TerminalPaths>;
  /**
   * Condition lists for paths that fall through the end of the body —
   * the synthetic `functionFallthrough` terminal's branches.
   */
  fallthrough: TerminalPaths;
}

/** Path-count cap; beyond it the caller falls back to legacy. */
const MAX_PATHS = 256;

// ---------------------------------------------------------------------------
// Bail scan — constructs v1 doesn't model at the statement-flow level
// ---------------------------------------------------------------------------

const isFunctionBoundary = (node: Node): boolean =>
  Node.isFunctionDeclaration(node) ||
  Node.isFunctionExpression(node) ||
  Node.isArrowFunction(node) ||
  Node.isMethodDeclaration(node);

/**
 * True when the unit-level statement flow contains a construct the
 * enumeration doesn't model. Only labeled statements remain a blanket
 * bail: switch and try/catch are modeled by `stepSwitch` / the try
 * handler (cursed `finally` shapes decline at step time), and break /
 * continue end their path (a loop break joins after the loop, whose
 * conditions are opacified anyway; a continue ends the symbolic
 * iteration). Nested function bodies don't count — their control flow
 * is not the unit's statement flow.
 */
function containsUnmodeledFlow(body: Node): boolean {
  let found = false;
  body.forEachDescendant((node, traversal) => {
    if (isFunctionBoundary(node)) {
      traversal.skip();
      return;
    }
    if (Node.isLabeledStatement(node)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

/** Switch shapes the enumeration declines — the caller falls back to legacy. */
class UnmodeledFlow extends Error {}

// ---------------------------------------------------------------------------
// Statement scans (function-boundary aware)
// ---------------------------------------------------------------------------

type ExitKind = "return" | "throw" | null;

/**
 * Does this statement subtree exit the *unit* (return/throw not nested
 * inside an inner function)? Any throw wins the classification, same
 * precedence as the legacy `thenBlockThrows`.
 */
function exitKindOf(stmt: Node): ExitKind {
  let sawReturn = false;
  let sawThrow = false;
  const visit = (node: Node): void => {
    if (node !== stmt && isFunctionBoundary(node)) {
      return;
    }
    if (Node.isReturnStatement(node)) {
      sawReturn = true;
    }
    if (Node.isThrowStatement(node)) {
      sawThrow = true;
    }
    for (const child of node.getChildren()) {
      visit(child);
    }
  };
  visit(stmt);
  if (sawThrow) {
    return "throw";
  }
  return sawReturn ? "return" : null;
}

const statementsOf = (stmt: Statement | undefined): Statement[] => {
  if (stmt === undefined) {
    return [];
  }
  if (Node.isBlock(stmt)) {
    return stmt.getStatements();
  }
  return [stmt];
};

// ---------------------------------------------------------------------------
// Path elements
// ---------------------------------------------------------------------------

/**
 * One condition on a path, before per-terminal source classification.
 * Synthetic loop conditions carry no expression (they render opaque).
 */
interface PathCond {
  info: ConditionInfo;
  /** The if-statement this condition branches on (null for synthetic). */
  branchStmt: Node | null;
  /** Exit kind of the *opposite* arm, for guard classification. */
  oppositeExit: ExitKind;
}

function branchCond(
  ifStmt: Node,
  expression: ConditionInfo["expression"],
  sourceText: string,
  polarity: "positive" | "negative",
  oppositeExit: ExitKind,
): PathCond {
  return {
    // Source is provisional — finalized per terminal in classify().
    info: { sourceText, polarity, source: "explicit", expression },
    branchStmt: ifStmt,
    oppositeExit,
  };
}

/**
 * Finalize condition sources for one terminal: a condition whose branch
 * statement encloses the terminal is an `explicit` ancestor branch;
 * a negative condition passed on the way (the guard didn't fire) is an
 * early return/throw, matching the legacy classification exactly.
 */
function classify(path: PathCond[], terminal: Node | null): ConditionInfo[] {
  return path.map((cond) => {
    if (cond.branchStmt === null) {
      return cond.info;
    }
    const encloses =
      terminal !== null && isAncestorOrSelf(cond.branchStmt, terminal);
    if (encloses || cond.info.polarity === "positive") {
      return { ...cond.info, source: "explicit" };
    }
    const source = cond.oppositeExit === "throw" ? "earlyThrow" : "earlyReturn";
    return { ...cond.info, source };
  });
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

class PathBudgetExceeded extends Error {}

interface EnumerationState {
  /** terminal node → containing enumerated statement association. */
  terminalsByStmt: Map<Statement, Node[]>;
  byTerminal: Map<Node, TerminalPaths>;
  fallthrough: TerminalPaths;
  pathCount: number;
}

function chargeBudget(state: EnumerationState): void {
  state.pathCount++;
  if (state.pathCount > MAX_PATHS) {
    throw new PathBudgetExceeded();
  }
}

function recordTerminal(
  state: EnumerationState,
  terminal: Node,
  stmt: Statement,
  path: PathCond[],
): void {
  chargeBudget(state);
  const statementLevel = classify(path, terminal);
  const expressionLevel = collectAncestorConditionInfosBelow(terminal, stmt);
  const existing = state.byTerminal.get(terminal) ?? [];
  existing.push([...statementLevel, ...expressionLevel]);
  state.byTerminal.set(terminal, existing);
}

/** Does this statement's subtree contain any enumerated terminal? */
function containsTerminal(
  stmt: Statement,
  terminals: ReadonlySet<Node>,
): boolean {
  let found = terminals.has(stmt);
  stmt.forEachDescendant((node, traversal) => {
    if (terminals.has(node)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

const loopIterationCond = (header: string): PathCond => ({
  info: {
    sourceText: `some iteration of: ${header}`,
    polarity: "positive",
    source: "explicit",
    expression: null,
  },
  branchStmt: null,
  oppositeExit: null,
});

const loopCompletedCond = (header: string, exit: ExitKind): PathCond => ({
  info: {
    sourceText: `loop exited via ${exit ?? "return"}: ${header}`,
    polarity: "negative",
    source: exit === "throw" ? "earlyThrow" : "earlyReturn",
    expression: null,
  },
  // Synthetic: classification is already final (branchStmt null keeps
  // classify() from touching it).
  branchStmt: null,
  oppositeExit: exit,
});

const isLoop = (stmt: Node): boolean =>
  Node.isForOfStatement(stmt) ||
  Node.isForInStatement(stmt) ||
  Node.isForStatement(stmt) ||
  Node.isWhileStatement(stmt) ||
  Node.isDoStatement(stmt);

const loopHeaderText = (stmt: Statement): string => {
  const text = stmt.getText();
  const bodyStart = text.indexOf("{");
  const header = bodyStart === -1 ? text : text.slice(0, bodyStart);
  return header.trim();
};

/**
 * Enumerate paths through a statement list. Returns the condition
 * prefixes of every path that falls through past the end (continuations
 * for the caller to resume with).
 */
function enumerate(
  state: EnumerationState,
  stmts: Statement[],
  prefix: PathCond[],
  terminals: ReadonlySet<Node>,
): PathCond[][] {
  let frontiers: PathCond[][] = [prefix];

  for (const stmt of stmts) {
    const nextFrontiers: PathCond[][] = [];
    for (const path of frontiers) {
      nextFrontiers.push(...stepStatement(state, stmt, path, terminals));
    }
    frontiers = nextFrontiers;
    if (frontiers.length > MAX_PATHS) {
      throw new PathBudgetExceeded();
    }
    if (frontiers.length === 0) {
      break; // every path exited — the rest is unreachable
    }
  }
  return frontiers;
}

/**
 * Process one statement for one incoming path. Records any terminals
 * inside it and returns the outgoing fall-through paths (empty when
 * every continuation exits the unit).
 */
function stepStatement(
  state: EnumerationState,
  stmt: Statement,
  path: PathCond[],
  terminals: ReadonlySet<Node>,
): PathCond[][] {
  // Terminals mapped directly to a branch/loop statement live in its
  // header expression (pathological but legal — `if (foo(res.json(x))))`;
  // record them against the incoming path before branching.
  const headerTerminals = state.terminalsByStmt.get(stmt) ?? [];

  // If-statement with observable structure → branch.
  if (Node.isIfStatement(stmt)) {
    for (const terminal of headerTerminals) {
      recordTerminal(state, terminal, stmt, path);
    }
    const thenStmts = statementsOf(stmt.getThenStatement());
    const elseStmts = statementsOf(stmt.getElseStatement());
    const armsExit = exitKindOf(stmt) !== null;
    const armsHaveTerminals = containsTerminal(stmt, terminals);

    // Neither arm exits nor holds a terminal: the branch cannot
    // discriminate anything downstream — collapse to a pass-through so
    // legacy-sound shapes keep byte-identical conditions.
    if (!armsExit && !armsHaveTerminals) {
      return [path];
    }

    const expr = stmt.getExpression();
    const thenExit = exitKindOfList(thenStmts);
    const elseExit = exitKindOfList(elseStmts);

    const thenPath = [
      ...path,
      branchCond(stmt, expr, expr.getText(), "positive", elseExit),
    ];
    const elsePath = [
      ...path,
      branchCond(stmt, expr, expr.getText(), "negative", thenExit),
    ];

    const out: PathCond[][] = [];
    out.push(...enumerate(state, thenStmts, thenPath, terminals));
    if (stmt.getElseStatement() !== undefined) {
      out.push(...enumerate(state, elseStmts, elsePath, terminals));
    } else {
      out.push(elsePath);
    }
    return out;
  }

  // Switch: model case groups as branch conditions (legacy-identical
  // synthetic text), trailing-break bodies joining after the switch.
  if (Node.isSwitchStatement(stmt)) {
    for (const terminal of headerTerminals) {
      recordTerminal(state, terminal, stmt, path);
    }
    return stepSwitch(state, stmt, path, terminals);
  }

  // Loop: one symbolic iteration for in-body terminals; fall-through
  // carries an opaque completion condition when the body can exit.
  if (isLoop(stmt)) {
    for (const terminal of headerTerminals) {
      recordTerminal(state, terminal, stmt, path);
    }
    const bodyStmts = statementsOf(getLoopBody(stmt));
    const bodyExit = exitKindOfList(bodyStmts);
    const header = loopHeaderText(stmt);

    if (containsTerminal(stmt, terminals)) {
      // Terminals inside the body see: path so far + "some iteration"
      // (opaque — an execution may never enter the loop) + their
      // in-body branch structure.
      enumerate(
        state,
        bodyStmts,
        [...path, loopIterationCond(header)],
        terminals,
      );
    }

    if (bodyExit !== null) {
      return [[...path, loopCompletedCond(header, bodyExit)]];
    }
    return [path];
  }

  // Try/catch: the try body runs on the incoming path; the catch body
  // runs under an opaque "catch" condition (which throw fired is not
  // statically decidable — same abstention the legacy collector used).
  // A `finally` is allowed only as pure cleanup: one with unit exits
  // or terminals declines to legacy (returns-from-finally are cursed;
  // never fabricate their interleavings).
  if (Node.isTryStatement(stmt)) {
    for (const terminal of headerTerminals) {
      recordTerminal(state, terminal, stmt, path);
    }
    const finallyBlock = stmt.getFinallyBlock();
    if (finallyBlock !== undefined) {
      const finallyStmts = finallyBlock.getStatements();
      const finallyHasTerminal = finallyStmts.some((s) =>
        containsTerminal(s, terminals),
      );
      if (exitKindOfList(finallyStmts) !== null || finallyHasTerminal) {
        throw new UnmodeledFlow("finally block with exits or terminals");
      }
    }
    const out: PathCond[][] = [];
    out.push(
      ...enumerate(state, stmt.getTryBlock().getStatements(), path, terminals),
    );
    const catchClause = stmt.getCatchClause();
    if (catchClause !== undefined) {
      const catchPath = [...path, catchEntryCond()];
      out.push(
        ...enumerate(
          state,
          catchClause.getBlock().getStatements(),
          catchPath,
          terminals,
        ),
      );
    }
    return out;
  }

  // Any statement may carry terminals (return-shape returns, res.*
  // calls in expression statements, throws, ternary arms, terminals
  // inside nested callbacks).
  const stmtTerminals = state.terminalsByStmt.get(stmt) ?? [];
  for (const terminal of stmtTerminals) {
    recordTerminal(state, terminal, stmt, path);
  }

  // Return/throw ends the path. So do break and continue: a trailing
  // switch break never reaches here (stepSwitch strips it) and a
  // non-trailing one declines earlier, so any break here binds a loop
  // — it jumps to after that loop, whose continuation the loop handler
  // computes independently; a continue ends the symbolic iteration.
  if (
    Node.isReturnStatement(stmt) ||
    Node.isThrowStatement(stmt) ||
    Node.isBreakStatement(stmt) ||
    Node.isContinueStatement(stmt)
  ) {
    return [];
  }
  return [path];
}

/** The legacy collector's exact catch condition — IDs stay stable. */
const catchEntryCond = (): PathCond => ({
  info: {
    sourceText: "catch",
    polarity: "positive",
    source: "catchBlock",
    expression: null,
  },
  branchStmt: null,
  oppositeExit: null,
});

/**
 * Every `break` in a clause body must be the clause's final top-level
 * statement — anything fancier (conditional breaks, breaks after
 * side-effect tails) declines to legacy. Breaks belonging to a nested
 * switch are that switch's concern.
 */
function validateClauseBreaks(stmts: Statement[]): void {
  const last = stmts[stmts.length - 1];
  for (const stmt of stmts) {
    if (stmt === last && Node.isBreakStatement(stmt)) {
      continue;
    }
    stmt.forEachDescendant((node, traversal) => {
      if (
        isFunctionBoundary(node) ||
        Node.isSwitchStatement(node) ||
        isLoop(node)
      ) {
        traversal.skip();
        return;
      }
      if (Node.isBreakStatement(node)) {
        throw new UnmodeledFlow("non-trailing break in switch clause");
      }
    });
    if (Node.isBreakStatement(stmt)) {
      throw new UnmodeledFlow("non-trailing break in switch clause");
    }
  }
}

/**
 * Enumerate a switch statement. Case labels group across empty
 * clauses (classic stacked fallthrough) with the same synthetic
 * condition text the legacy ancestor collector produced, so in-case
 * transition IDs are stable. Bodies must end every path with
 * return/throw or a trailing top-level break; falling through into
 * another non-empty clause declines to legacy, as does a default
 * clause anywhere but last.
 */
function stepSwitch(
  state: EnumerationState,
  stmt: Statement,
  path: PathCond[],
  terminals: ReadonlySet<Node>,
): PathCond[][] {
  if (!Node.isSwitchStatement(stmt)) {
    return [path];
  }
  const switchText = stmt.getExpression().getText();
  const clauses = stmt.getClauses();
  const out: PathCond[][] = [];
  const negations: PathCond[] = [];
  let pendingLabels: string[] = [];
  let sawDefault = false;

  const groupCond = (
    labels: string[],
    polarity: "positive" | "negative",
    source: ConditionInfo["source"],
  ): PathCond => ({
    info: {
      sourceText: labels.map((l) => `${switchText} === ${l}`).join(" || "),
      polarity,
      source,
      // Synthetic condition — no single Expression node (matches the
      // legacy collector, which also parsed these as opaque).
      expression: null,
    },
    branchStmt: null,
    oppositeExit: null,
  });

  // "Fallthrough is safe" = no non-empty clause after this one could
  // execute on falling off the body's end.
  const bodiesAfter: boolean[] = [];
  {
    let seenBody = false;
    for (let i = clauses.length - 1; i >= 0; i--) {
      bodiesAfter[i] = seenBody;
      if (clauses[i].getStatements().length > 0) {
        seenBody = true;
      }
    }
  }

  const runBody = (
    stmts: Statement[],
    groupPath: PathCond[],
    fallthroughSafe: boolean,
  ): void => {
    validateClauseBreaks(stmts);
    const last = stmts[stmts.length - 1];
    const hasTrailingBreak = last !== undefined && Node.isBreakStatement(last);
    const body = hasTrailingBreak ? stmts.slice(0, -1) : stmts;
    const conts = enumerate(state, body, groupPath, terminals);
    if (conts.length === 0) {
      return; // every path exited the unit
    }
    if (!hasTrailingBreak && !fallthroughSafe) {
      throw new UnmodeledFlow("fallthrough into a non-empty switch clause");
    }
    out.push(...conts);
  };

  let defaultRanBody = false;
  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    if (sawDefault) {
      throw new UnmodeledFlow("default clause is not last");
    }
    if (Node.isDefaultClause(clause)) {
      sawDefault = true;
      const stmts = clause.getStatements();
      if (stmts.length === 0) {
        continue; // empty default — behaves like no default
      }
      defaultRanBody = true;
      runBody(stmts, [...path, ...negations], bodiesAfter[i] === false);
      continue;
    }
    if (!Node.isCaseClause(clause)) {
      continue;
    }
    pendingLabels.push(clause.getExpression().getText());
    const stmts = clause.getStatements();
    if (stmts.length === 0) {
      continue; // stacked label — falls into the next clause's body
    }
    const labels = pendingLabels;
    pendingLabels = [];
    runBody(
      stmts,
      [...path, groupCond(labels, "positive", "explicit")],
      bodiesAfter[i] === false,
    );
    // Passing a group whose body exits the unit is a guard-passing —
    // same classification as an if-guard, so a trailing catch-all
    // terminal stays the default transition. Groups that rejoin via
    // break are ordinary branch decisions.
    const exit = exitKindOfList(stmts);
    const negationSource =
      exit === "throw"
        ? "earlyThrow"
        : exit === "return"
          ? "earlyReturn"
          : "explicit";
    negations.push(groupCond(labels, "negative", negationSource));
  }

  if (!defaultRanBody) {
    // No default body: values matching no bodied group — including
    // trailing label-only clauses — fall through the switch unchanged.
    out.push([...path, ...negations]);
  }
  return out;
}

function exitKindOfList(stmts: Statement[]): ExitKind {
  let sawReturn = false;
  for (const stmt of stmts) {
    const kind = exitKindOf(stmt);
    if (kind === "throw") {
      return "throw";
    }
    if (kind === "return") {
      sawReturn = true;
    }
  }
  return sawReturn ? "return" : null;
}

function getLoopBody(stmt: Statement): Statement | undefined {
  if (
    Node.isForOfStatement(stmt) ||
    Node.isForInStatement(stmt) ||
    Node.isForStatement(stmt) ||
    Node.isWhileStatement(stmt) ||
    Node.isDoStatement(stmt)
  ) {
    return stmt.getStatement();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compute per-path conditions for every terminal in `terminalNodes`.
 * Total: shapes the enumeration declines (and budget blowouts) come
 * back as the degraded result — enclosure conditions plus an opaque
 * "unmodeled control flow" conjunct — never as an absence.
 */
export function computePathConditions(
  func: FunctionRoot,
  terminalNodes: readonly Node[],
): PathConditionsResult {
  const body = func.getBody();
  if (body === undefined) {
    // Ambient declaration — nothing to enumerate, nothing terminates.
    return { byTerminal: new Map(), fallthrough: [] };
  }
  if (!Node.isBlock(body)) {
    // Expression-bodied arrow: one unconditional path; all branching is
    // expression-level (ternaries, &&/||) — same as the legacy walk.
    // The body itself is a terminal here, because an arrow written
    // without braces returns it. Only a block body can also anchor the
    // synthetic fall-through terminal the caller fills in, so nothing
    // is skipped on this path.
    const byTerminal = new Map<Node, TerminalPaths>();
    for (const terminal of terminalNodes) {
      byTerminal.set(terminal, [
        collectAncestorConditionInfosBelow(terminal, func),
      ]);
    }
    return { byTerminal, fallthrough: [] };
  }
  if (containsUnmodeledFlow(body)) {
    return degradedResult(func, terminalNodes, "labeled statement");
  }

  const topStatements = body.getStatements();
  const terminals = new Set(terminalNodes);

  // The statements the enumeration will visit: top-level statements
  // plus, transitively, if-arm and loop-body statements. Everything
  // else (statements inside nested callbacks, ternary arms, …) hangs
  // *below* one of these and is covered by the expression-level walker.
  const visited = new Set<Statement>();
  const collectVisited = (stmts: Statement[]): void => {
    for (const stmt of stmts) {
      visited.add(stmt);
      if (Node.isIfStatement(stmt)) {
        collectVisited(statementsOf(stmt.getThenStatement()));
        collectVisited(statementsOf(stmt.getElseStatement()));
      }
      if (isLoop(stmt)) {
        collectVisited(statementsOf(getLoopBody(stmt)));
      }
      if (Node.isSwitchStatement(stmt)) {
        for (const clause of stmt.getClauses()) {
          collectVisited(clause.getStatements());
        }
      }
      if (Node.isTryStatement(stmt)) {
        collectVisited(stmt.getTryBlock().getStatements());
        const catchClause = stmt.getCatchClause();
        if (catchClause !== undefined) {
          collectVisited(catchClause.getBlock().getStatements());
        }
        const finallyBlock = stmt.getFinallyBlock();
        if (finallyBlock !== undefined) {
          collectVisited(finallyBlock.getStatements());
        }
      }
    }
  };
  collectVisited(topStatements);

  // Associate each terminal with the *visited* statement containing it.
  const terminalsByStmt = new Map<Statement, Node[]>();
  for (const terminal of terminalNodes) {
    if (terminal === body) {
      continue; // synthetic fallthrough terminal — handled below
    }
    const stmt = enclosingVisitedStatement(terminal, body, visited);
    if (stmt === null) {
      return degradedResult(
        func,
        terminalNodes,
        "terminal outside the statement flow",
      );
    }
    const list = terminalsByStmt.get(stmt) ?? [];
    list.push(terminal);
    terminalsByStmt.set(stmt, list);
  }

  const state: EnumerationState = {
    terminalsByStmt,
    byTerminal: new Map(),
    fallthrough: [],
    pathCount: 0,
  };

  try {
    const continuations = enumerate(state, topStatements, [], terminals);
    for (const path of continuations) {
      chargeBudget(state);
      state.fallthrough.push(classify(path, null));
    }
  } catch (error) {
    if (error instanceof PathBudgetExceeded) {
      return degradedResult(func, terminalNodes, "path budget exceeded");
    }
    if (error instanceof UnmodeledFlow) {
      return degradedResult(func, terminalNodes, error.message);
    }
    throw error;
  }

  return {
    byTerminal: state.byTerminal,
    fallthrough: state.fallthrough,
  };
}

/**
 * Sound degradation for shapes the enumeration declines. Enclosure
 * conditions (the ancestor walk: if-arms, catch clauses, ternary and
 * logical operands, case clauses) are true gating facts no matter how
 * exotic the surrounding flow is — a terminal inside `if (a)` really
 * is gated on `a`. What the walk cannot see (guards passed on the
 * way, labeled jumps, budget-truncated paths) is covered by one
 * opaque conjunct, so the transition abstains instead of claiming a
 * complete condition set. This replaced the legacy collectors as the
 * decline behavior: they produced *claims* on these shapes (missing
 * or over-conjoined guard negations) — degradation trades that
 * unsoundness for honest under-specification.
 */
function degradedResult(
  func: FunctionRoot,
  terminalNodes: readonly Node[],
  reason: string,
): PathConditionsResult {
  const marker: ConditionInfo = {
    sourceText: `unmodeled control flow (${reason})`,
    polarity: "positive",
    source: "explicit",
    expression: null,
  };
  const body = func.getBody();
  const byTerminal = new Map<Node, TerminalPaths>();
  for (const terminal of terminalNodes) {
    if (body !== undefined && terminal === body) {
      continue; // synthetic fallthrough terminal
    }
    byTerminal.set(terminal, [
      [...collectAncestorConditionInfosBelow(terminal, func), marker],
    ]);
  }
  return { byTerminal, fallthrough: [[marker]] };
}

/**
 * The nearest ancestor (or self) that the enumeration visits. Walking
 * up from the terminal, the first statement in the visited set is the
 * one whose `stepStatement` frame should record this terminal.
 */
function enclosingVisitedStatement(
  terminal: Node,
  body: Node,
  visited: ReadonlySet<Statement>,
): Statement | null {
  let current: Node | undefined = terminal;
  while (current !== undefined && current !== body) {
    if (Node.isStatement(current) && visited.has(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}
