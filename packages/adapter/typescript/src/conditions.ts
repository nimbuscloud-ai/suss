// conditions.ts: AST traversal for branch condition extraction (Task 2.1)
// Refactored in Task 2.5 to expose Expression nodes for assembly.

import {
  type ArrowFunction,
  type CaseClause,
  type ConstructorDeclaration,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
} from "ts-morph";

import { caseArmOf, caseArmText } from "./paths/caseArms.js";
import { predicateOfCondition } from "./predicates.js";

import type { RawCondition } from "@suss/extractor";

/**
 * A function a unit is built on. A constructor is one, since `new
 * Client()` runs its body and its parameters' defaults the way a call
 * runs a function's.
 */
export type FunctionRoot =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration
  | ConstructorDeclaration;

/**
 * What a branch condition tests: the test expression, or for a switch
 * arm the case clause, which compares the switch's subject with its
 * labels.
 */
export type ConditionNode = Expression | CaseClause;

/**
 * A condition with its original AST node preserved.
 * Used internally by the assembly step to call predicateOfCondition.
 */
export interface ConditionInfo {
  sourceText: string;
  polarity: "positive" | "negative";
  source: RawCondition["source"];
  /** The AST node for the condition. Null for catch clauses and loop markers. */
  expression: ConditionNode | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function makeConditionInfo(
  sourceText: string,
  polarity: "positive" | "negative",
  source: RawCondition["source"],
  expression: ConditionNode | null,
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
  return collectAncestorConditionInfosBelow(terminalNode, functionRoot);
}

/**
 * The generalized walker: collect branch conditions from `terminalNode`
 * up to (but not including) `stopNode`. The CFG path engine uses this
 * with a *statement* stop to pick up expression-level branching
 * (ternaries, `&&`/`||`, case clauses inside nested callbacks) while
 * statement-level flow comes from path enumeration.
 */
export function collectAncestorConditionInfosBelow(
  terminalNode: Node,
  stopNode: Node,
): ConditionInfo[] {
  const result: ConditionInfo[] = [];
  // Start from the terminal node itself so that a direct parent
  // ConditionalExpression (ternary) is detected on the first iteration.
  let current: Node | undefined = terminalNode;

  while (current !== undefined && current !== stopNode) {
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
    } else if (Node.isCaseClause(current)) {
      const arm = caseArmOf(current);
      if (arm !== null) {
        result.unshift(
          makeConditionInfo(caseArmText(arm), "positive", "explicit", current),
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
 * Public API: returns RawCondition[] with structured: null.
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

export function isAncestorOrSelf(maybeAncestor: Node, node: Node): boolean {
  let current: Node | undefined = node;
  while (current !== undefined) {
    if (current === maybeAncestor) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}

/**
 * Convert a ConditionInfo (adapter-level: Expression + metadata) to
 * a RawCondition (IR-bound shape: structured Predicate or source
 * text fallback). Shared between branch-condition assembly and
 * effect-precondition capture.
 */
export function conditionInfoToRawCondition(info: ConditionInfo): RawCondition {
  const structured =
    info.expression !== null ? predicateOfCondition(info.expression) : null;
  return {
    sourceText: info.sourceText,
    structured,
    polarity: info.polarity,
    source: info.source,
  };
}
