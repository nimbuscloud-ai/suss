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
// Scope: the enumeration runs on *structured* statement flow only. A
// function whose unit-level flow contains `switch`, `try`, labels,
// `break`, or `continue` returns null and the caller falls back to the
// legacy collectors — behavior-preserving by conservatism. Since every
// remaining construct is structured, recursive enumeration over the AST
// is equivalent to a query over the lowered CFG; the explicit cfgEdge
// fact materialization arrives with the rules engine (see
// docs/internal/differential-fuzzing.md and status.md decision #54+).
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
 * enumeration doesn't model (switch / try / labels / break /
 * continue). Nested function bodies don't count — their control flow
 * is not the unit's statement flow (a `switch` inside a `.forEach`
 * callback is handled by the expression-level ancestor walker).
 */
function containsUnmodeledFlow(body: Node): boolean {
  let found = false;
  body.forEachDescendant((node, traversal) => {
    if (isFunctionBoundary(node)) {
      traversal.skip();
      return;
    }
    if (
      Node.isSwitchStatement(node) ||
      Node.isTryStatement(node) ||
      Node.isLabeledStatement(node) ||
      Node.isBreakStatement(node) ||
      Node.isContinueStatement(node)
    ) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

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

function isAncestorOrSelf(maybeAncestor: Node, node: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (current === maybeAncestor) {
      return true;
    }
    current = current.getParent();
  }
  return false;
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

const isLoop = (stmt: Statement): boolean =>
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

  // Any statement may carry terminals (return-shape returns, res.*
  // calls in expression statements, throws, ternary arms, terminals
  // inside nested callbacks).
  const stmtTerminals = state.terminalsByStmt.get(stmt) ?? [];
  for (const terminal of stmtTerminals) {
    recordTerminal(state, terminal, stmt, path);
  }

  // Return/throw ends the path.
  if (Node.isReturnStatement(stmt) || Node.isThrowStatement(stmt)) {
    return [];
  }
  return [path];
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
 * Returns null when the function's statement flow contains constructs
 * the enumeration doesn't model (the caller falls back to the legacy
 * collectors), or when the path budget is exceeded.
 */
export function computePathConditions(
  func: FunctionRoot,
  terminalNodes: readonly Node[],
): PathConditionsResult | null {
  const body = func.getBody();
  if (body === undefined || !Node.isBlock(body)) {
    return null;
  }
  if (containsUnmodeledFlow(body)) {
    return null;
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
      return null; // terminal outside the body's statement flow
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
      return null;
    }
    throw error;
  }

  return {
    byTerminal: state.byTerminal,
    fallthrough: state.fallthrough,
  };
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
