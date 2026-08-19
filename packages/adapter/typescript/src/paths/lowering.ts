// lowering.ts: ts-morph statement nodes to StructuredStatement<Expression>.
//
// The only place in the TS adapter that still walks a raw ts-morph
// statement tree for control-flow shape. Everything downstream
// (enumeratePaths.ts, in @suss/extractor) operates on the lowered tree
// alone, never touching a ts-morph Node.

import {
  type Block,
  type Expression,
  Node,
  type Statement,
  type SwitchStatement,
} from "ts-morph";

import {
  type CaseGroup,
  type ConditionHandle,
  type ExitKind,
  type StatementBlock,
  type StructuredStatement,
  UnmodeledFlow,
} from "@suss/extractor";

import {
  type DescentBarriers,
  isDescentStop,
  isInlineCallback,
  NO_BARRIERS,
  startsItsOwnScope,
} from "../walk/descent.js";

/**
 * What the walk needs at every node: the pack's sub-unit barriers, the
 * unit root they are relative to, and the map back from a raw statement
 * to what it lowered into.
 */
interface LowerContext {
  readonly func: Node;
  readonly barriers: DescentBarriers;
  readonly rawToStructured: Map<Node, StructuredStatement<Expression>>;
}

/**
 * Does this statement's own subtree exit the unit (return/throw not
 * nested inside an inner function)? Any throw wins the classification.
 * Feeds `StructuredStatement.exitKind`, computed once per node here so
 * the generic engine never has to re-walk a subtree to find one.
 */
function exitKindOf(stmt: Node): ExitKind {
  let sawReturn = false;
  let sawThrow = false;
  const visit = (node: Node): void => {
    if (node !== stmt && startsItsOwnScope(node)) {
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

const isLoop = (stmt: Node): boolean =>
  Node.isForOfStatement(stmt) ||
  Node.isForInStatement(stmt) ||
  Node.isForStatement(stmt) ||
  Node.isWhileStatement(stmt) ||
  Node.isDoStatement(stmt);

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

const loopHeaderText = (stmt: Statement): string => {
  const text = stmt.getText();
  const bodyStart = text.indexOf("{");
  const header = bodyStart === -1 ? text : text.slice(0, bodyStart);
  return header.trim();
};

const conditionOf = (expr: Expression): ConditionHandle<Expression> => ({
  sourceText: expr.getText(),
  expression: expr,
});

// ---------------------------------------------------------------------------
// Statement lowering
// ---------------------------------------------------------------------------

function lowerStatement(
  stmt: Statement,
  ctx: LowerContext,
): StructuredStatement<Expression> {
  const structured = {
    ...buildStructured(stmt, ctx),
    callbacks: lowerCallbacksIn(ownExpressionsOf(stmt), ctx),
  };
  ctx.rawToStructured.set(stmt, structured);
  return structured;
}

function lowerList(
  stmts: readonly Statement[],
  ctx: LowerContext,
): StructuredStatement<Expression>[] {
  return spliceBlocks(stmts).map((s) => lowerStatement(s, ctx));
}

/**
 * The parts of `stmt` that are not lowered as statements of their own:
 * its test, its header, the value it returns. A callback written in one
 * of these runs where the statement does, and a callback inside a child
 * block is collected when that block's own statements are lowered.
 */
function ownExpressionsOf(stmt: Statement): Node[] {
  if (Node.isIfStatement(stmt) || Node.isSwitchStatement(stmt)) {
    return [stmt.getExpression()];
  }
  if (Node.isWhileStatement(stmt) || Node.isDoStatement(stmt)) {
    return [stmt.getExpression()];
  }
  if (Node.isForOfStatement(stmt) || Node.isForInStatement(stmt)) {
    return [stmt.getInitializer(), stmt.getExpression()];
  }
  if (Node.isForStatement(stmt)) {
    return [
      stmt.getInitializer(),
      stmt.getCondition(),
      stmt.getIncrementor(),
    ].filter((n) => n !== undefined);
  }
  if (Node.isTryStatement(stmt)) {
    return [];
  }
  if (Node.isReturnStatement(stmt) || Node.isThrowStatement(stmt)) {
    const value = stmt.getExpression();
    return value === undefined ? [] : [value];
  }
  if (Node.isBreakStatement(stmt) || Node.isContinueStatement(stmt)) {
    return [];
  }
  return [stmt];
}

/**
 * The lowered bodies of the callbacks this statement passes to calls it
 * makes. Descent stops at anything the pack claimed as a sub-unit and at
 * every named declaration, so the set is the one the effect walk uses.
 */
function lowerCallbacksIn(
  parts: readonly Node[],
  ctx: LowerContext,
): StatementBlock<Expression>[] {
  const bodies: StatementBlock<Expression>[] = [];

  const visit = (node: Node, root: Node): void => {
    if (node !== root && isDescentStop(node, ctx.func, ctx.barriers)) {
      return;
    }
    if (
      node !== root &&
      (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) &&
      isInlineCallback(node, ctx.func, ctx.barriers)
    ) {
      const body = node.getBody();
      // A concise body has no statements of its own, but a call in it
      // can still take a callback, so the walk keeps going through it.
      if (body !== undefined && Node.isBlock(body)) {
        bodies.push(lowerList(body.getStatements(), ctx));
        return;
      }
    } else if (node !== root && startsItsOwnScope(node)) {
      return;
    }
    for (const child of node.getChildren()) {
      visit(child, root);
    }
  };

  for (const part of parts) {
    visit(part, part);
  }
  return bodies;
}

/**
 * The same, for an arrow written without braces. There is no statement
 * flow to enumerate, so the callbacks in the expression are all the
 * branching the body has.
 */
export function lowerExpressionBodyCallbacks(
  expression: Node,
  func: Node,
  barriers: DescentBarriers = NO_BARRIERS,
): StatementBlock<Expression>[] {
  return lowerCallbacksIn([expression], {
    func,
    barriers,
    rawToStructured: new Map(),
  });
}

/**
 * A bare block only scopes declarations, so its statements belong to
 * the surrounding list. People brace a switch case to scope a const,
 * and the branches inside used to stay hidden behind the block (#191).
 * Recursion keeps a block inside a block flat too.
 */
function spliceBlocks(stmts: readonly Statement[]): Statement[] {
  return stmts.flatMap((s) =>
    Node.isBlock(s) ? spliceBlocks(s.getStatements()) : [s],
  );
}

function buildStructured(
  stmt: Statement,
  ctx: LowerContext,
): StructuredStatement<Expression> {
  if (Node.isIfStatement(stmt)) {
    const elseBranch = stmt.getElseStatement();
    return {
      kind: "if",
      condition: conditionOf(stmt.getExpression()),
      thenBody: lowerList(statementsOf(stmt.getThenStatement()), ctx),
      elseBody:
        elseBranch === undefined
          ? null
          : lowerList(statementsOf(elseBranch), ctx),
      exitKind: exitKindOf(stmt),
    };
  }

  if (Node.isSwitchStatement(stmt)) {
    return {
      kind: "switch",
      groups: lowerSwitchGroups(stmt, ctx),
      exitKind: exitKindOf(stmt),
    };
  }

  if (isLoop(stmt)) {
    return {
      kind: "loop",
      condition: { sourceText: loopHeaderText(stmt), expression: null },
      body: lowerList(statementsOf(getLoopBody(stmt)), ctx),
      exitKind: exitKindOf(stmt),
    };
  }

  if (Node.isTryStatement(stmt)) {
    const catchClause = stmt.getCatchClause();
    const finallyBlock = stmt.getFinallyBlock();
    return {
      kind: "try",
      tryBody: lowerList(stmt.getTryBlock().getStatements(), ctx),
      catchBody:
        catchClause === undefined
          ? null
          : lowerList(catchClause.getBlock().getStatements(), ctx),
      finallyBody:
        finallyBlock === undefined
          ? null
          : lowerList(finallyBlock.getStatements(), ctx),
      exitKind: exitKindOf(stmt),
    };
  }

  if (Node.isReturnStatement(stmt)) {
    return { kind: "exit", exit: "return", exitKind: exitKindOf(stmt) };
  }
  if (Node.isThrowStatement(stmt)) {
    return { kind: "exit", exit: "throw", exitKind: exitKindOf(stmt) };
  }
  if (Node.isBreakStatement(stmt)) {
    return { kind: "exit", exit: "break", exitKind: exitKindOf(stmt) };
  }
  if (Node.isContinueStatement(stmt)) {
    return { kind: "exit", exit: "continue", exitKind: exitKindOf(stmt) };
  }

  return { kind: "opaque", exitKind: exitKindOf(stmt) };
}

/**
 * Case-group lowering: merge TypeScript's stacked empty-bodied labels
 * onto the clause that finally has a body, matching the legacy
 * collector's synthetic condition text exactly so transition IDs stay
 * stable. A default clause anywhere but last is a shape the enumeration
 * declines, checked here against the raw clause order. An empty
 * default still counts (it would have blocked anything after it had it
 * carried a body too): the ordering rule is about TypeScript's own
 * clause-list grammar, not about the lowered shape, so it belongs in
 * lowering rather than in the generic engine.
 */
function lowerSwitchGroups(
  stmt: SwitchStatement,
  ctx: LowerContext,
): CaseGroup<Expression>[] {
  const switchText = stmt.getExpression().getText();
  const groups: CaseGroup<Expression>[] = [];
  let pendingLabels: string[] = [];
  let sawDefault = false;

  for (const clause of stmt.getClauses()) {
    if (sawDefault) {
      throw new UnmodeledFlow("default clause is not last");
    }

    if (Node.isDefaultClause(clause)) {
      sawDefault = true;
      const stmts = clause.getStatements();
      if (stmts.length === 0) {
        continue; // empty default, behaves like no default at all
      }
      groups.push({
        condition: null,
        ...lowerGroupBody(stmts, ctx),
      });
      continue;
    }

    if (!Node.isCaseClause(clause)) {
      continue;
    }
    pendingLabels.push(clause.getExpression().getText());
    const stmts = clause.getStatements();
    if (stmts.length === 0) {
      continue; // stacked label, falls into the next clause's body
    }
    const labels = pendingLabels;
    pendingLabels = [];
    const sourceText = labels.map((l) => `${switchText} === ${l}`).join(" || ");
    groups.push({
      condition: { sourceText, expression: null },
      ...lowerGroupBody(stmts, ctx),
    });
  }

  return groups;
}

/**
 * Every break in a clause body must be the clause's last statement, or
 * the whole switch degrades. The caller splices bare blocks first, so
 * this walk catches a break behind if or try nesting, which the
 * lowered tree cannot express. A nested function, switch, or loop is
 * skipped, since each owns its own break.
 */
function validateClauseBreaks(stmts: readonly Statement[]): void {
  const last = stmts[stmts.length - 1];
  for (const stmt of stmts) {
    if (stmt === last && Node.isBreakStatement(stmt)) {
      continue;
    }

    // The descendant walk skips these when it meets them below the
    // root, and a spliced clause can have one AS the root.
    if (Node.isSwitchStatement(stmt) || isLoop(stmt)) {
      continue;
    }
    stmt.forEachDescendant((node, traversal) => {
      if (
        startsItsOwnScope(node) ||
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

function lowerGroupBody(
  rawStmts: Statement[],
  ctx: LowerContext,
): { hasTrailingBreak: boolean; body: StructuredStatement<Expression>[] } {
  // Splice before the break rules run, so a break at the end of a
  // braced case counts as the clause's own trailing break.
  const stmts = spliceBlocks(rawStmts);
  validateClauseBreaks(stmts);
  const last = stmts[stmts.length - 1];
  const hasTrailingBreak = last !== undefined && Node.isBreakStatement(last);
  const kept = hasTrailingBreak ? stmts.slice(0, -1) : stmts;
  const body = lowerList(kept, ctx);
  // A trailing break still gets lowered (registered), even though it's
  // excluded from `body` and never enumerated, matching the legacy
  // collector, which also marked it "visited" so a caller-given
  // terminal that happens to name it still resolves a home.
  if (hasTrailingBreak && last !== undefined) {
    lowerStatement(last, ctx);
  }
  return { hasTrailingBreak, body };
}

// ---------------------------------------------------------------------------
// Function-body lowering + terminal association
// ---------------------------------------------------------------------------

export interface LoweredFunctionBody {
  statements: StructuredStatement<Expression>[];
  terminalsByStmt: ReadonlyMap<
    StructuredStatement<Expression>,
    readonly Node[]
  >;
  /**
   * Each given terminal's raw enclosing statement, for the
   * expression-level walk boundary the caller appends after the
   * generic engine returns. Branching below the statement level
   * (ternaries, &&/||, case clauses inside nested callbacks) stays
   * outside the lowered tree entirely, and is composed back in there.
   */
  terminalHomeRaw: ReadonlyMap<Node, Node>;
}

/**
 * Lower a function's block body and associate every caller-given
 * terminal with the statement that encloses it in the lowered tree.
 * Throws `UnmodeledFlow("terminal outside the statement flow")` when a
 * terminal is outside anything the lowering walked, a defensive
 * case, since every caller-given terminal is expected to live inside
 * the body it was found in.
 */
export function lowerFunctionBody(
  body: Block,
  terminalNodes: readonly Node[],
  func: Node = body,
  barriers: DescentBarriers = NO_BARRIERS,
): LoweredFunctionBody {
  const rawToStructured = new Map<Node, StructuredStatement<Expression>>();
  const ctx: LowerContext = { func, barriers, rawToStructured };
  const statements = lowerList(body.getStatements(), ctx);

  const terminalsByStmt = new Map<StructuredStatement<Expression>, Node[]>();
  const terminalHomeRaw = new Map<Node, Node>();

  for (const terminal of terminalNodes) {
    if (terminal === body) {
      continue; // synthetic fallthrough terminal, the caller handles it
    }
    const home = enclosingLoweredStatement(terminal, body, rawToStructured);
    const structuredHome =
      home === null ? undefined : rawToStructured.get(home);
    if (home === null || structuredHome === undefined) {
      throw new UnmodeledFlow("terminal outside the statement flow");
    }
    terminalHomeRaw.set(terminal, home);
    const list = terminalsByStmt.get(structuredHome) ?? [];
    list.push(terminal);
    terminalsByStmt.set(structuredHome, list);
  }

  return { statements, terminalsByStmt, terminalHomeRaw };
}

/**
 * The nearest ancestor (or self) that lowering visited. Walking up
 * from the terminal, the first statement lowered into the tree is the
 * one whose StructuredStatement should record this terminal.
 */
function enclosingLoweredStatement(
  terminal: Node,
  body: Node,
  rawToStructured: ReadonlyMap<Node, StructuredStatement<Expression>>,
): Node | null {
  let current: Node | undefined = terminal;
  while (current !== undefined && current !== body) {
    if (Node.isStatement(current) && rawToStructured.has(current)) {
      return current;
    }
    current = current.getParent();
  }
  return null;
}
