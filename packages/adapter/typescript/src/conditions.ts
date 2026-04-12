// conditions.ts — AST traversal for branch condition extraction (Task 2.1)
// Refactored in Task 2.5 to expose Expression nodes for assembly.

import {
  type ArrowFunction,
  type CaseClause,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
} from "ts-morph";

import type { RawCondition } from "@suss/extractor";

export type FunctionRoot =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration;

/**
 * A condition with its original AST Expression preserved.
 * Used internally by the assembly step to call parseConditionExpression.
 */
export interface ConditionInfo {
  sourceText: string;
  polarity: "positive" | "negative";
  source: RawCondition["source"];
  /** The AST node for the condition. Null for catch clauses and synthetic switch conditions. */
  expression: Expression | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeConditionInfo(
  sourceText: string,
  polarity: "positive" | "negative",
  source: RawCondition["source"],
  expression: Expression | null,
): ConditionInfo {
  return { sourceText, polarity, source, expression };
}

function conditionInfoToRaw(info: ConditionInfo): RawCondition {
  return {
    sourceText: info.sourceText,
    structured: null,
    polarity: info.polarity,
    source: info.source,
  };
}

// ---------------------------------------------------------------------------
// Ancestor branch collection (with Expression nodes)
// ---------------------------------------------------------------------------

/**
 * Walk from terminalNode up to (but not including) functionRoot, collecting
 * branch conditions imposed by ancestor control-flow nodes.
 * Result is ordered outermost → innermost.
 *
 * Returns ConditionInfo with the Expression node preserved for later parsing.
 */
export function collectAncestorConditionInfos(
  terminalNode: Node,
  functionRoot: FunctionRoot,
): ConditionInfo[] {
  const result: ConditionInfo[] = [];
  let current: Node | undefined = terminalNode.getParent();

  while (current !== undefined && current !== functionRoot) {
    const parent = current.getParent();

    if (parent !== undefined && Node.isIfStatement(parent)) {
      const thenBranch = parent.getThenStatement();
      const elseBranch = parent.getElseStatement();
      const expr = parent.getExpression();

      const inThen = isAncestorOrSelf(thenBranch, current);
      const inElse =
        elseBranch !== undefined && isAncestorOrSelf(elseBranch, current);

      if (inThen) {
        result.unshift(
          makeConditionInfo(expr.getText(), "positive", "explicit", expr),
        );
      } else if (inElse) {
        result.unshift(
          makeConditionInfo(expr.getText(), "negative", "explicit", expr),
        );
      }
    } else if (
      Node.isIfStatement(current) &&
      current.getThenStatement() === terminalNode
    ) {
      const expr = current.getExpression();
      result.unshift(
        makeConditionInfo(expr.getText(), "positive", "explicit", expr),
      );
    } else if (Node.isCaseClause(current)) {
      const switchStmt = current.getParent()?.getParent();
      if (switchStmt !== undefined && Node.isSwitchStatement(switchStmt)) {
        const switchExpr = switchStmt.getExpression().getText();
        const caseExpr = (current as CaseClause).getExpression().getText();
        const condText = `${switchExpr} === ${caseExpr}`;
        // Synthetic condition — no single Expression node to preserve
        result.unshift(
          makeConditionInfo(condText, "positive", "explicit", null),
        );
      }
    } else if (Node.isCatchClause(current)) {
      result.unshift(
        makeConditionInfo("catch", "positive", "catchBlock", null),
      );
    } else if (parent !== undefined && Node.isConditionalExpression(parent)) {
      const expr = parent.getCondition();
      const inTrue = isAncestorOrSelf(parent.getWhenTrue(), current);
      const inFalse = isAncestorOrSelf(parent.getWhenFalse(), current);
      if (inTrue) {
        result.unshift(
          makeConditionInfo(expr.getText(), "positive", "explicit", expr),
        );
      } else if (inFalse) {
        result.unshift(
          makeConditionInfo(expr.getText(), "negative", "explicit", expr),
        );
      }
    } else if (parent !== undefined && Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getText();
      const left = parent.getLeft();
      if (
        current === parent.getRight() ||
        isAncestorOrSelf(parent.getRight(), current)
      ) {
        if (op === "&&") {
          result.unshift(
            makeConditionInfo(left.getText(), "positive", "explicit", left),
          );
        } else if (op === "||") {
          result.unshift(
            makeConditionInfo(left.getText(), "negative", "explicit", left),
          );
        }
      }
    }

    current = parent;
  }

  return result;
}

/**
 * Public API — returns RawCondition[] with structured: null.
 * Use collectAncestorConditionInfos when you need the Expression nodes.
 */
export function collectAncestorBranches(
  terminalNode: Node,
  functionRoot: FunctionRoot,
): RawCondition[] {
  return collectAncestorConditionInfos(terminalNode, functionRoot).map(
    conditionInfoToRaw,
  );
}

// ---------------------------------------------------------------------------
// Early return collection (with Expression nodes)
// ---------------------------------------------------------------------------

/**
 * Find prior sibling statements that are guard clauses (if (...) { return/throw }).
 * Returns ConditionInfo with the Expression node preserved for later parsing.
 */
export function collectEarlyReturnConditionInfos(
  terminalNode: Node,
  functionRoot: FunctionRoot,
): ConditionInfo[] {
  const result: ConditionInfo[] = [];

  const body = functionRoot.getBody();
  if (body === undefined || !Node.isBlock(body)) {
    return result;
  }

  const statements = body.getStatements();

  let containerIdx = -1;
  for (let i = 0; i < statements.length; i++) {
    if (isAncestorOrSelf(statements[i], terminalNode)) {
      containerIdx = i;
      break;
    }
  }

  if (containerIdx <= 0) {
    return result;
  }

  for (let i = 0; i < containerIdx; i++) {
    const stmt = statements[i];
    if (Node.isIfStatement(stmt)) {
      collectGuardConditionInfos(stmt, result);
    }
  }

  return result;
}

/**
 * Public API — returns RawCondition[] with structured: null.
 * Use collectEarlyReturnConditionInfos when you need the Expression nodes.
 */
export function collectEarlyReturns(
  terminalNode: Node,
  functionRoot: FunctionRoot,
): RawCondition[] {
  return collectEarlyReturnConditionInfos(terminalNode, functionRoot).map(
    conditionInfoToRaw,
  );
}

// ---------------------------------------------------------------------------
// Guard clause helpers
// ---------------------------------------------------------------------------

function collectGuardConditionInfos(
  ifStmt: Node,
  result: ConditionInfo[],
): boolean {
  if (!Node.isIfStatement(ifStmt)) {
    return false;
  }

  const thenStmt = ifStmt.getThenStatement();
  const expr = ifStmt.getExpression();

  if (thenBlockReturnsOrThrows(thenStmt)) {
    const source: RawCondition["source"] = thenBlockThrows(thenStmt)
      ? "earlyThrow"
      : "earlyReturn";
    result.push(makeConditionInfo(expr.getText(), "negative", source, expr));

    if (Node.isBlock(thenStmt)) {
      for (const inner of thenStmt.getStatements()) {
        if (Node.isIfStatement(inner)) {
          collectGuardConditionInfos(inner, result);
        }
      }
    }
    return true;
  }

  return false;
}

/** True if the then-block (directly or nested) contains a return or throw. */
function thenBlockReturnsOrThrows(node: Node): boolean {
  if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) {
    return true;
  }
  if (Node.isBlock(node)) {
    for (const stmt of node.getStatements()) {
      if (thenBlockReturnsOrThrows(stmt)) {
        return true;
      }
    }
  }
  return false;
}

/** True if the then-block contains a throw (as opposed to a return). */
function thenBlockThrows(node: Node): boolean {
  if (Node.isThrowStatement(node)) {
    return true;
  }
  if (Node.isBlock(node)) {
    for (const stmt of node.getStatements()) {
      if (thenBlockThrows(stmt)) {
        return true;
      }
    }
  }
  return false;
}

/** True if `maybeAncestor` is the same node as `node` or contains `node` as a descendant. */
function isAncestorOrSelf(maybeAncestor: Node, node: Node): boolean {
  if (maybeAncestor === node) {
    return true;
  }
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (current === maybeAncestor) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}
