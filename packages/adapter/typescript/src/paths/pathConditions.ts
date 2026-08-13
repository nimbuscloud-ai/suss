// paths/pathConditions.ts, CFG-semantics path conditions.
//
// This file used to contain the whole enumeration engine, written
// directly against ts-morph nodes. It now has only what is
// TypeScript-specific: the
// function-body special cases (an ambient declaration, an
// expression-bodied arrow), the labeled-statement bail, and the
// degrade-on-catch wrapper. The enumeration itself (entry-to-terminal
// path walking, case-group lowering, loop opacification, the
// unmodeled-shape degradation) is `enumerateStructuredPaths` in
// @suss/extractor, operating on the StructuredStatement `lowering.ts`
// produces from this function's ts-morph AST. See
// docs/internal/roadmap-second-language.md, "Path engine: abstract it
// once".
//
// Replaces the legacy `collectEarlyReturns` + `collectAncestorBranches`
// pair with per-path enumeration: every entry-to-terminal control-flow
// path contributes its own condition conjunction, so a terminal reached
// along several paths becomes several RawBranches instead of one
// branch with a fabricated (or missing) conjunction. This is
// correctness principle #1, "every path maps to exactly one branch",
// implemented literally, and it closes the documented nested-guard and
// loop-return soundness gaps by construction:
//
//   - a guard nested one block deep contributes its own per-path
//     conditions (`if (a) { if (b) return; } T` sends T down the two
//     paths `[¬a]` and `[a, ¬b]`, never `[]` or `[¬a ∧ ¬b]`);
//   - paths that cross a loop whose body can exit the function get an
//     explicit opaque condition. Quantified-over-iterations facts are
//     not statically decidable, so the engine under-specifies rather
//     than fabricating one.
//
// Scope: the enumeration models if/else, switch (trailing-break
// bodies), loops (opaque-quantified), try/catch (opaque catch entry,
// pure-cleanup finally), break/continue (path enders), and
// expression-bodied arrows. Shapes it declines, labeled statements,
// `finally` blocks with exits or terminals, switch fallthrough into a
// non-empty clause, non-trailing switch breaks, and the path-count
// budget, degrade instead of falling back to the unsound legacy
// collectors: every terminal gets its enclosure conditions (ancestor
// branches are true gating facts regardless of flow shape) plus one
// opaque "unmodeled control flow" conjunct, so the transition abstains
// rather than over- or under-claiming. Under-specify freely; never
// fabricate.
//
// Expression-level branching below a statement (ternaries, `&&`/`||`,
// case clauses inside nested callbacks) still comes from the scoped
// ancestor walker, appended after the statement-level path conditions,
// the same composition order as the legacy pipeline, so condition
// lists (and therefore transition IDs) are byte-identical on shapes
// the legacy pipeline handled soundly.

import { Node } from "ts-morph";

import {
  enumerateStructuredPaths,
  PathBudgetExceeded,
  UnmodeledFlow,
} from "@suss/extractor";

import {
  type ConditionInfo,
  collectAncestorConditionInfosBelow,
  type FunctionRoot,
} from "../conditions.js";
import { isFunctionBoundary, lowerFunctionBody } from "./lowering.js";

/** Paths for one terminal: each entry is one path's condition list. */
export type TerminalPaths = ConditionInfo[][];

export interface PathConditionsResult {
  /** Per-terminal paths, keyed by terminal node. */
  byTerminal: Map<Node, TerminalPaths>;
  /**
   * Condition lists for paths that fall through the end of the body,
   * the synthetic `functionFallthrough` terminal's branches.
   */
  fallthrough: TerminalPaths;
}

// ---------------------------------------------------------------------------
// Bail scan: constructs the enumeration doesn't model at the statement-flow level
// ---------------------------------------------------------------------------

/**
 * True when the unit-level statement flow contains a construct the
 * enumeration doesn't model. Labeled statements are TypeScript/
 * JavaScript syntax with no analogue this engine's other constructs
 * cover, so they stay a blanket bail here rather than a shape
 * `lowering.ts` has to represent. Nested function bodies don't count,
 * their control flow is not the unit's statement flow.
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Compute per-path conditions for every terminal in `terminalNodes`.
 * Total: shapes the enumeration declines (and budget blowouts) come
 * back as the degraded result, enclosure conditions plus an opaque
 * "unmodeled control flow" conjunct, never as an absence.
 */
export function computePathConditions(
  func: FunctionRoot,
  terminalNodes: readonly Node[],
): PathConditionsResult {
  const body = func.getBody();
  if (body === undefined) {
    // Ambient declaration, nothing to enumerate, nothing terminates.
    return { byTerminal: new Map(), fallthrough: [] };
  }
  if (!Node.isBlock(body)) {
    // Expression-bodied arrow: one unconditional path; all branching is
    // expression-level (ternaries, &&/||), same as the legacy walk.
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

  try {
    const lowered = lowerFunctionBody(body, terminalNodes);
    const result = enumerateStructuredPaths({
      statements: lowered.statements,
      terminalsByStmt: lowered.terminalsByStmt,
    });
    return composeExpressionLevel(func, result, lowered.terminalHomeRaw);
  } catch (error) {
    if (error instanceof PathBudgetExceeded) {
      return degradedResult(
        func,
        terminalNodes,
        error.message === "" ? "path budget exceeded" : error.message,
      );
    }
    if (error instanceof UnmodeledFlow) {
      return degradedResult(func, terminalNodes, error.message);
    }
    throw error;
  }
}

/**
 * Append the expression-level walk (ternaries, &&/||, case clauses
 * inside nested callbacks) after the generic engine's statement-level
 * conditions for each terminal, the same composition order as the
 * legacy pipeline. `terminalHomeRaw` is the raw statement `lowering.ts`
 * found enclosing each terminal, the boundary the walk stops at.
 */
function composeExpressionLevel(
  func: FunctionRoot,
  result: { byTerminal: Map<Node, TerminalPaths>; fallthrough: TerminalPaths },
  terminalHomeRaw: ReadonlyMap<Node, Node>,
): PathConditionsResult {
  const byTerminal = new Map<Node, TerminalPaths>();
  for (const [terminal, paths] of result.byTerminal) {
    const home = terminalHomeRaw.get(terminal) ?? func;
    const expressionLevel = collectAncestorConditionInfosBelow(terminal, home);
    byTerminal.set(
      terminal,
      paths.map((statementLevel) => [...statementLevel, ...expressionLevel]),
    );
  }
  return { byTerminal, fallthrough: result.fallthrough };
}

/**
 * Sound degradation for shapes the enumeration declines. Enclosure
 * conditions (the ancestor walk: if-arms, catch clauses, ternary and
 * logical operands, case clauses) are true gating facts no matter how
 * unusual the surrounding flow is, a terminal inside `if (a)` is gated
 * on `a` regardless. What the walk cannot see (guards passed on the
 * way, labeled jumps, budget-truncated paths) is covered by one
 * opaque conjunct, so the transition abstains instead of claiming a
 * complete condition set. This replaced the legacy collectors as the
 * decline behavior: they produced claims on these shapes (missing or
 * over-conjoined guard negations); degradation trades that
 * unsoundness for a stated, sound under-specification.
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
