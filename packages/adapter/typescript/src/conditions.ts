// conditions.ts — AST traversal for branch condition extraction (Task 2.1)
// structured is always null here; Task 2.2 will fill it in.

import {
  type ArrowFunction,
  type CaseClause,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
} from "ts-morph";

import type { RawCondition } from "@suss/extractor";

type FunctionRoot =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration;

// Returns a RawCondition with structured: null (Task 2.2 fills this in).
function makeCondition(
  sourceText: string,
  polarity: "positive" | "negative",
  source: RawCondition["source"],
): RawCondition {
  return { sourceText, structured: null, polarity, source };
}

/**
 * Walk from terminalNode up to (but not including) functionRoot, collecting
 * branch conditions imposed by ancestor control-flow nodes.
 * Result is ordered outermost → innermost.
 */
export function collectAncestorBranches(
  terminalNode: Node,
  functionRoot: FunctionRoot,
): RawCondition[] {
  const result: RawCondition[] = [];
  let current: Node | undefined = terminalNode.getParent();

  while (current !== undefined && current !== functionRoot) {
    const parent = current.getParent();

    // IfStatement handling covers two cases:
    //   A) current's parent is an IfStatement and current is inside then/else (braces case).
    //   B) current IS directly the thenStatement of a parent IfStatement without braces
    //      (e.g. `if (x) return y;` → return's parent is IfStatement, IfStatement's parent
    //      is a block — detected by checking current === ifStmt.getThenStatement()).
    // IfStatement: record condition + polarity.
    // Works for both the braces case (current is a Block child of the IfStatement)
    // and the no-braces case (current IS the IfStatement, terminal is directly its thenStatement).
    if (parent !== undefined && Node.isIfStatement(parent)) {
      // Braces case: current is then-block, else-block, or a child thereof.
      const thenBranch = parent.getThenStatement();
      const elseBranch = parent.getElseStatement();
      const condText = parent.getExpression().getText();

      const inThen = isAncestorOrSelf(thenBranch, current);
      const inElse =
        elseBranch !== undefined && isAncestorOrSelf(elseBranch, current);

      if (inThen) {
        result.unshift(makeCondition(condText, "positive", "explicit"));
      } else if (inElse) {
        result.unshift(makeCondition(condText, "negative", "explicit"));
      }
    } else if (
      Node.isIfStatement(current) &&
      current.getThenStatement() === terminalNode
    ) {
      // No-braces case: `if (cond) return/throw;` — the terminal is directly the thenStatement.
      result.unshift(
        makeCondition(
          current.getExpression().getText(),
          "positive",
          "explicit",
        ),
      );
    } else if (Node.isCaseClause(current)) {
      // SwitchStatement → CaseClause: record `switchExpr === caseValue`
      const switchStmt = current.getParent()?.getParent();
      if (switchStmt !== undefined && Node.isSwitchStatement(switchStmt)) {
        const switchExpr = switchStmt.getExpression().getText();
        const caseExpr = (current as CaseClause).getExpression().getText();
        const condText = `${switchExpr} === ${caseExpr}`;
        result.unshift(makeCondition(condText, "positive", "explicit"));
      }
    } else if (Node.isCatchClause(current)) {
      // TryCatchClause: opaque catch condition
      result.unshift(makeCondition("catch", "positive", "catchBlock"));
    } else if (parent !== undefined && Node.isConditionalExpression(parent)) {
      // Ternary: positive if in whenTrue, negative if in whenFalse
      const condText = parent.getCondition().getText();
      const inTrue = isAncestorOrSelf(parent.getWhenTrue(), current);
      const inFalse = isAncestorOrSelf(parent.getWhenFalse(), current);
      if (inTrue) {
        result.unshift(makeCondition(condText, "positive", "explicit"));
      } else if (inFalse) {
        result.unshift(makeCondition(condText, "negative", "explicit"));
      }
    } else if (parent !== undefined && Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getText();
      const left = parent.getLeft();
      // Only record when current is the right side (left is the implicit condition)
      if (
        current === parent.getRight() ||
        isAncestorOrSelf(parent.getRight(), current)
      ) {
        if (op === "&&") {
          result.unshift(makeCondition(left.getText(), "positive", "explicit"));
        } else if (op === "||") {
          result.unshift(makeCondition(left.getText(), "negative", "explicit"));
        }
      }
    }

    current = parent;
  }

  return result;
}

/**
 * Find prior sibling statements that are guard clauses (if (...) { return/throw }).
 * Their conditions are recorded as polarity "negative".
 * Handles nested guards: if (a) { if (b) return; } → outer condition contributes too.
 */
export function collectEarlyReturns(
  terminalNode: Node,
  functionRoot: FunctionRoot,
): RawCondition[] {
  const result: RawCondition[] = [];

  // Get the function body's direct statement list
  const body = functionRoot.getBody();
  if (body === undefined || !Node.isBlock(body)) {
    return result;
  }

  const statements = body.getStatements();

  // Find which top-level statement contains our terminal node
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

  // Walk all prior sibling statements
  for (let i = 0; i < containerIdx; i++) {
    const stmt = statements[i];
    if (Node.isIfStatement(stmt)) {
      collectGuardConditions(stmt, result);
    }
  }

  return result;
}

/**
 * Recursively collect conditions from guard if-statements.
 * An outer if(a) { if(b) return; } contributes [a, b] as negatives.
 * The outer condition is added first (outermost → innermost).
 */
function collectGuardConditions(ifStmt: Node, result: RawCondition[]): boolean {
  if (!Node.isIfStatement(ifStmt)) {
    return false;
  }

  const thenStmt = ifStmt.getThenStatement();
  const condText = ifStmt.getExpression().getText();

  // Check if the then-block itself contains a return/throw (possibly nested)
  if (thenBlockReturnsOrThrows(thenStmt)) {
    // Determine source: "earlyReturn" or "earlyThrow"
    const source = thenBlockThrows(thenStmt) ? "earlyThrow" : "earlyReturn";
    result.push(makeCondition(condText, "negative", source));

    // Also walk nested if-statements inside the then-block to collect deeper guards.
    // e.g. if (a) { if (b) return; } → a is already recorded; now check if b is also a guard.
    if (Node.isBlock(thenStmt)) {
      for (const inner of thenStmt.getStatements()) {
        if (Node.isIfStatement(inner)) {
          collectGuardConditions(inner, result);
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

// Re-export the FunctionRoot type so tests can use it.
export type { FunctionRoot };
