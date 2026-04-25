// returns.ts — return-statement / return-shape / parameter-method-call
// / function-call matchers. The four ways a synchronous control path
// can produce a value-bearing terminal that isn't a throw or JSX render.

import {
  type CallExpression,
  type Expression,
  Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
} from "ts-morph";

import { extractShape } from "../shapes/shapes.js";
import {
  type ExtractionContext,
  extractBody,
  extractStatusCode,
} from "./extract.js";

import type { RawTerminal, TerminalPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { FoundTerminal } from "./shared.js";

/**
 * Attempt to unwrap a method-chain call matching `methodChain` rooted at
 * parameter `paramPos` of `func`.
 *
 * Returns `{ calls }` where `calls[0]` is innermost (closest to param) and
 * `calls[N-1]` is the outermost (the matched node), or null on mismatch.
 */
function unwrapMethodChain(
  call: CallExpression,
  methodChain: string[],
  func: FunctionRoot,
  paramPos: number,
): { calls: CallExpression[] } | null {
  if (methodChain.length === 0) {
    return null;
  }

  // Build from outermost → innermost, collecting the calls in order
  const collected: CallExpression[] = [];
  let current: CallExpression = call;

  for (let i = methodChain.length - 1; i >= 0; i--) {
    const expectedMethod = methodChain[i];
    const callee = current.getExpression();

    if (!Node.isPropertyAccessExpression(callee)) {
      return null;
    }

    if (callee.getName() !== expectedMethod) {
      return null;
    }

    collected.unshift(current); // will end up innermost-first

    const subject = callee.getExpression();

    if (i === 0) {
      // The subject of the innermost method call must be a parameter identifier
      if (!Node.isIdentifier(subject)) {
        return null;
      }

      const symbol = subject.getSymbol();
      if (symbol === undefined) {
        return null;
      }

      const decls = symbol.getDeclarations();
      if (decls.length === 0) {
        return null;
      }

      const decl = decls[0];
      if (!Node.isParameterDeclaration(decl)) {
        return null;
      }

      // Verify the parameter is at the expected position
      const params = func.getParameters() as ParameterDeclaration[];
      const idx = params.indexOf(decl as ParameterDeclaration);
      if (idx !== paramPos) {
        return null;
      }
    } else {
      // Intermediate: subject must be a CallExpression (next in chain)
      if (!Node.isCallExpression(subject)) {
        return null;
      }
      current = subject;
    }
  }

  return { calls: collected };
}

/**
 * Check if an ObjectLiteralExpression is in a position that makes it a return
 * value — direct return, arrow expression body, or branch of a ternary that
 * itself is returned.
 */
function isInReturnPosition(ole: Node): boolean {
  let current: Node | undefined = ole.getParent();
  // Direct child of ReturnStatement is already handled by the ReturnStatement
  // case in tryMatchReturnShape — skip to avoid duplicate terminals.
  if (current !== undefined && Node.isReturnStatement(current)) {
    return false;
  }
  while (current !== undefined) {
    if (Node.isReturnStatement(current)) {
      return true;
    }
    if (Node.isArrowFunction(current)) {
      // Only match expression bodies, not OLEs inside a block body
      const body = current.getBody();
      return body !== undefined && !Node.isBlock(body);
    }
    // Walk through ternary branches and parens
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isConditionalExpression(current)
    ) {
      current = current.getParent();
      continue;
    }
    return false;
  }
  return false;
}

export function tryMatchReturnShape(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "returnShape" }>,
): FoundTerminal | null {
  let obj: ObjectLiteralExpression | null = null;

  if (Node.isReturnStatement(node)) {
    const arg = node.getExpression();
    if (arg !== undefined && Node.isObjectLiteralExpression(arg)) {
      obj = arg;
    }
  } else if (Node.isObjectLiteralExpression(node)) {
    if (isInReturnPosition(node)) {
      obj = node;
    }
  }

  if (obj === null) {
    return null;
  }

  // Check required properties
  const required = match.requiredProperties;
  if (required !== undefined && required.length > 0) {
    const presentNames = new Set<string>();

    for (const prop of obj.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        presentNames.add(prop.getName());
      } else if (Node.isShorthandPropertyAssignment(prop)) {
        presentNames.add(prop.getName());
      }
    }

    for (const name of required) {
      if (!presentNames.has(name)) {
        return null;
      }
    }
  }

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    returnedObj: obj,
  };
  const statusCode = extractStatusCode(ctx);
  // For a returnShape terminal, the returned object IS the body. `extractBody`
  // only knows how to pull from `ctx.calls` (parameterMethodCall) or
  // `ctx.throwCallArgs` (throw) — neither applies here — so a pack that
  // specifies `body: { from: "argument", position: 0 }` gets null back, even
  // though the obvious answer is "use the whole returned object". Fall back
  // to the returned object's shape when `extractBody` came up empty and
  // extraction didn't specifically select a property via `from: "property"`.
  let body = extractBody(ctx);
  if (body === null && pattern.extraction.body?.from !== "property") {
    body = { typeText: obj.getText(), shape: extractShape(obj) };
  }

  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode,
    body,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    renderTree: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

export function tryMatchParameterMethodCall(
  node: Node,
  func: FunctionRoot,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "parameterMethodCall" }>,
): FoundTerminal | null {
  if (!Node.isCallExpression(node)) {
    return null;
  }

  const result = unwrapMethodChain(
    node,
    match.methodChain,
    func,
    match.parameterPosition,
  );

  if (result === null) {
    return null;
  }

  const { calls } = result;

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    calls,
  };
  const statusCode = extractStatusCode(ctx);
  const body = extractBody(ctx);

  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode,
    body,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    renderTree: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

/**
 * Is the returned expression a call (or new) — possibly wrapped in
 * `await`, `as`, parens, or `!`? Used by `excludeCallReturns` so a
 * pack that already matches `reply.send(...)` via `parameterMethodCall`
 * doesn't double-fire on the enclosing `return reply.send(...)`.
 */
function isCallReturn(expr: Node): boolean {
  let current: Node = expr;
  while (true) {
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isAwaitExpression(current)
    ) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return Node.isCallExpression(current) || Node.isNewExpression(current);
}

export function tryMatchReturnStatement(
  node: Node,
  pattern: TerminalPattern,
): FoundTerminal | null {
  const match = pattern.match.type === "returnStatement" ? pattern.match : null;
  // Explicit `return expr;`
  if (Node.isReturnStatement(node)) {
    const expr = node.getExpression();
    // `excludeCallReturns` packs are using returnStatement to capture
    // value-producing returns (e.g. Fastify's bare `return user`). Skip
    // both `return;` (control-flow exit, no value) and `return <call>`
    // (covered by the pack's parameterMethodCall matcher) to avoid
    // double-firing. `isCallReturn` peels await / casts / parens so
    // `return await reply.send(...)` is treated the same as
    // `return reply.send(...)`.
    if (match?.excludeCallReturns === true) {
      if (expr === undefined) {
        return null;
      }
      if (isCallReturn(expr)) {
        return null;
      }
    }
    // Capture the shape of the returned expression. Without this,
    // every `return x;` surfaces as `-> return (default)` in inspect
    // output regardless of what `x` is — opaque to downstream consumers
    // that want to see the function's output. `extractShape` walks the
    // expression structurally first (object literals, conditional
    // expressions, identifiers resolved through AST) and falls back
    // to the type checker for anything it can't decompose.
    let body: RawTerminal["body"] = null;
    if (expr !== undefined) {
      const shape = extractShape(expr);
      if (shape !== null) {
        body = { typeText: null, shape };
      }
    }
    return buildReturnTerminal(node, pattern, body);
  }

  // Expression-body arrow: `(v) => setValue(v)` or `() => cond ? a : b`.
  // The body expression IS the return value. The per-node walker skips
  // into nested arrow bodies, so we only match the outermost arrow
  // (which IS the function being analysed) here — nested callbacks get
  // their own findTerminals pass when they're themselves discovered.
  if (Node.isArrowFunction(node)) {
    const body = node.getBody();
    if (body === undefined || Node.isBlock(body)) {
      return null;
    }
    // `body` is an Expression node.
    const shape = extractShape(body);
    const terminalBody: RawTerminal["body"] =
      shape !== null ? { typeText: null, shape } : null;
    return buildReturnTerminal(body, pattern, terminalBody);
  }

  return null;
}

function buildReturnTerminal(
  locationNode: Node,
  pattern: TerminalPattern,
  body: RawTerminal["body"],
): FoundTerminal {
  // Honour the pack's `defaultStatusCode` when one is declared. Used by
  // packs like Fastify whose returnStatement matcher emits `kind:
  // "response"` — `return user` is a 200 response. Packs that emit
  // `kind: "return"` (clients) leave defaultStatusCode unset, so this
  // collapses to null for them.
  const statusCode: RawTerminal["statusCode"] =
    pattern.extraction.defaultStatusCode !== undefined
      ? { type: "literal", value: pattern.extraction.defaultStatusCode }
      : null;
  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode,
    body,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    renderTree: null,
    location: {
      start: locationNode.getStartLineNumber(),
      end: locationNode.getEndLineNumber(),
    },
  };
  return { node: locationNode, terminal };
}

export function tryMatchFunctionCall(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "functionCall" }>,
): FoundTerminal | null {
  if (!Node.isCallExpression(node)) {
    return null;
  }

  const callee = node.getExpression();
  if (!Node.isIdentifier(callee)) {
    return null;
  }

  if (callee.getText() !== match.functionName) {
    return null;
  }

  const callArgs = node.getArguments() as Expression[];

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    throwCallArgs: callArgs,
  };
  const statusCode = extractStatusCode(ctx);
  const body = extractBody(ctx);

  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode,
    body,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    renderTree: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}
