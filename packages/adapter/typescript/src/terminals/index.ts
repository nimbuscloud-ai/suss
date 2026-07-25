// terminals/index.ts — orchestrator for the per-matcher terminal-finding
// passes. Each matcher (returns/jsx/throws/functionCall) lives in its
// own sibling file; this file walks every descendant of the function
// being analysed and dispatches each node through the matchers in
// pattern order.

import { Node } from "ts-morph";

import {
  crossesNestedFunctionScope,
  type DescentBarriers,
  isDescentStop,
  NO_BARRIERS,
} from "../walk/descent.js";
import { tryMatchJsxReturn } from "./jsx.js";
import {
  tryMatchFunctionCall,
  tryMatchParameterMethodCall,
  tryMatchReturnShape,
  tryMatchReturnStatement,
} from "./returns.js";
import { tryMatchThrowExpression } from "./throws.js";

import type { TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { FoundTerminal } from "./shared.js";

export type { FoundTerminal } from "./shared.js";

/**
 * Terminal match types whose observable output flows through a channel
 * the enclosing unit owns rather than the nested function's return
 * value — `res.json(...)` writes to a response object the unit received
 * as a parameter. These stay matchable inside a descended nested
 * function; value-returning terminals (`return`, returned object shape,
 * JSX render) do not, because a `return` inside a callback yields the
 * callback's value, not the unit's.
 */
const NESTED_ESCAPING_MATCH_TYPES: ReadonlySet<
  TerminalPattern["match"]["type"]
> = new Set(["parameterMethodCall"]);

/**
 * Walk every descendant of `func` and try each pattern in order (first match
 * wins per node). Returns all matched terminals across the whole function.
 *
 * Descends into nested function expressions / arrows so a unit whose
 * terminal output is produced inside a Promise executor or `.then`
 * callback (`res.json(data)` on the unit's own `res` parameter) is still
 * discovered. Inside a nested function only escaping terminals are
 * matched — see `NESTED_ESCAPING_MATCH_TYPES`.
 */
export function findTerminals(
  func: FunctionRoot,
  patterns: TerminalPattern[],
  barriers: DescentBarriers = NO_BARRIERS,
): FoundTerminal[] {
  const results: FoundTerminal[] = [];

  func.forEachDescendant((node, traversal) => {
    if (isDescentStop(node, func, barriers)) {
      traversal.skip();
      return;
    }

    const nested = crossesNestedFunctionScope(node, func);

    for (const pattern of patterns) {
      if (nested && !NESTED_ESCAPING_MATCH_TYPES.has(pattern.match.type)) {
        continue;
      }
      let found: FoundTerminal | null = null;

      if (pattern.match.type === "returnShape") {
        // One return can produce several terminals: a handler returning
        // through a helper that branches produces one per branch the
        // helper can take at this call site.
        const matches = tryMatchReturnShape(node, pattern, pattern.match);
        if (matches.length > 0) {
          results.push(...matches);
          break;
        }
        continue;
      }
      if (pattern.match.type === "returnStatement") {
        found = tryMatchReturnStatement(node, pattern, func, patterns);
      } else if (pattern.match.type === "jsxReturn") {
        found = tryMatchJsxReturn(node, pattern);
      } else if (pattern.match.type === "parameterMethodCall") {
        found = tryMatchParameterMethodCall(node, func, pattern, pattern.match);
      } else if (pattern.match.type === "throwExpression") {
        found = tryMatchThrowExpression(node, pattern, pattern.match);
      } else if (pattern.match.type === "functionCall") {
        found = tryMatchFunctionCall(node, pattern, pattern.match);
      }
      // `functionFallthrough` is not matched per-node — the assembly
      // pass emits it as a branch-level fallback when no other
      // terminal covers the function's default-path exit.

      if (found !== null) {
        results.push(found);
        break;
      }
    }
  });

  // Fallback for expression-body arrows (`(v) => setValue(v)`, `() => <X />`):
  // the function IS its own implicit return, but `forEachDescendant` doesn't
  // include `func` itself, and the descendant walk's matchers target
  // ReturnStatement / JsxElement-inside-return. When nothing matched but
  // `func` is an expression-body arrow, give the return + JSX matchers a
  // chance at the arrow node itself. Skipped when the descendant walk found
  // something (e.g. `(args) => ({ status, body })` already matched
  // returnShape on the inner ObjectLiteralExpression).
  if (results.length === 0 && Node.isArrowFunction(func)) {
    const body = func.getBody();
    if (body !== undefined && !Node.isBlock(body)) {
      for (const pattern of patterns) {
        let found: FoundTerminal | null = null;
        if (pattern.match.type === "returnStatement") {
          found = tryMatchReturnStatement(func, pattern, func, patterns);
        } else if (pattern.match.type === "jsxReturn") {
          found = tryMatchJsxReturn(func, pattern);
        }
        if (found !== null) {
          results.push(found);
          break;
        }
      }
    }
  }

  return results;
}

/**
 * Does the function's last statement leave control flow dangling (i.e.
 * no explicit `return` / `throw`)? Used by the assembly pass to decide
 * whether to synthesise a fall-through terminal.
 *
 * Arrow functions with an expression body (`() => expr`) already
 * "return" the expression's value — nothing falls through. Function
 * bodies that are a block fall through when the last statement isn't
 * a terminator.
 */
export function functionMayFallThrough(func: FunctionRoot): boolean {
  const body = func.getBody();
  if (body === undefined) {
    return false;
  }
  if (!Node.isBlock(body)) {
    return false;
  }
  const statements = body.getStatements();
  if (statements.length === 0) {
    return true;
  }
  const last = statements[statements.length - 1];
  if (Node.isReturnStatement(last) || Node.isThrowStatement(last)) {
    return false;
  }
  return true;
}

/**
 * Build a synthetic fall-through terminal anchored at the closing of
 * the function body. Used by the assembly pass when no other terminal
 * covers the function's default-path exit.
 */
export function makeFallthroughTerminal(func: FunctionRoot): FoundTerminal {
  const body = func.getBody();
  const anchor: Node = body ?? func;
  const line = anchor.getEndLineNumber();
  return {
    node: anchor,
    terminal: {
      kind: "return",
      statusCode: null,
      body: null,
      exceptionType: null,
      message: null,
      component: null,
      delegateTarget: null,
      emitEvent: null,
      renderTree: null,
      location: { start: line, end: line },
    },
  };
}
