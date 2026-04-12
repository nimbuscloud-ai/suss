// terminals.ts — Terminal-finding logic for ts-morph function ASTs (Task 2.3)

import {
  type CallExpression,
  type Expression,
  Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
} from "ts-morph";

import type {
  RawTerminal,
  TerminalExtraction,
  TerminalPattern,
} from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";

// ---------------------------------------------------------------------------
// Public output type
// ---------------------------------------------------------------------------

export interface FoundTerminal {
  node: Node;
  terminal: RawTerminal;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unwrap `expr as const` / `expr as Type` to the inner expression. */
function unwrapAs(node: Expression): Expression {
  return Node.isAsExpression(node) ? unwrapAs(node.getExpression()) : node;
}

// ---------------------------------------------------------------------------
// Status-code extraction
// ---------------------------------------------------------------------------

function extractStatusCode(
  extraction: TerminalExtraction,
  returnedObj: ObjectLiteralExpression | null,
  throwCallArgs: Expression[] | null,
  calls: CallExpression[] | null,
): RawTerminal["statusCode"] {
  const sc = extraction.statusCode;
  if (sc === undefined) {
    return null;
  }

  if (sc.from === "constructor") {
    return null;
  }

  if (sc.from === "property") {
    if (returnedObj === null) {
      return null;
    }

    for (const prop of returnedObj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        // Handle shorthand: ShorthandPropertyAssignment
        if (Node.isShorthandPropertyAssignment(prop)) {
          if (prop.getName() === sc.name) {
            return { type: "dynamic", sourceText: prop.getName() };
          }
        }
        continue;
      }

      if (prop.getName() !== sc.name) {
        continue;
      }

      const raw = prop.getInitializer();
      if (raw === undefined) {
        return null;
      }

      const val = unwrapAs(raw);
      if (Node.isNumericLiteral(val)) {
        return { type: "literal", value: Number(val.getText()) };
      }

      return { type: "dynamic", sourceText: val.getText() };
    }

    return null;
  }

  // from: "argument"
  const pos = sc.position;

  if (calls !== null) {
    // parameterMethodCall: statusCode comes from innermost call (calls[0])
    const innerCall = calls[0];
    const args = innerCall.getArguments();
    const rawArg = args[pos] as Expression | undefined;
    if (rawArg === undefined) {
      return null;
    }

    const arg = unwrapAs(rawArg);
    if (Node.isNumericLiteral(arg)) {
      return { type: "literal", value: Number(arg.getText()) };
    }

    return { type: "dynamic", sourceText: arg.getText() };
  }

  if (throwCallArgs !== null) {
    const rawArg = throwCallArgs[pos] as Expression | undefined;
    if (rawArg === undefined) {
      return null;
    }

    const arg = unwrapAs(rawArg);
    if (Node.isNumericLiteral(arg)) {
      return { type: "literal", value: Number(arg.getText()) };
    }

    return { type: "dynamic", sourceText: arg.getText() };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Body extraction
// ---------------------------------------------------------------------------

function extractBody(
  extraction: TerminalExtraction,
  returnedObj: ObjectLiteralExpression | null,
  throwCallArgs: Expression[] | null,
  calls: CallExpression[] | null,
): RawTerminal["body"] {
  const b = extraction.body;
  if (b === undefined) {
    return null;
  }

  if (b.from === "property") {
    if (returnedObj === null) {
      return null;
    }

    for (const prop of returnedObj.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        if (Node.isShorthandPropertyAssignment(prop)) {
          if (prop.getName() === b.name) {
            return { typeText: prop.getName(), shape: null };
          }
        }
        continue;
      }

      if (prop.getName() !== b.name) {
        continue;
      }

      const val = prop.getInitializer();
      if (val === undefined) {
        return null;
      }

      return { typeText: val.getText(), shape: null };
    }

    return null;
  }

  // from: "argument"
  const pos = b.position;

  if (calls !== null) {
    // parameterMethodCall: body comes from outermost call (calls[N-1])
    const outerCall = calls[calls.length - 1];
    const args = outerCall.getArguments();
    const arg = args[pos] as Expression | undefined;
    if (arg === undefined) {
      return null;
    }

    return { typeText: arg.getText(), shape: null };
  }

  if (throwCallArgs !== null) {
    const arg = throwCallArgs[pos] as Expression | undefined;
    if (arg === undefined) {
      return null;
    }

    return { typeText: arg.getText(), shape: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pattern matching + extraction per node
// ---------------------------------------------------------------------------

function tryMatchReturnShape(
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
    // Arrow expression body: async () => ({ status: 200, body: {} })
    const parent = node.getParent();
    if (parent && Node.isParenthesizedExpression(parent)) {
      const grandparent = parent.getParent();
      if (grandparent && Node.isArrowFunction(grandparent)) {
        obj = node;
      }
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

  const statusCode = extractStatusCode(pattern.extraction, obj, null, null);
  const body = extractBody(pattern.extraction, obj, null, null);

  const terminal: RawTerminal = {
    kind:
      pattern.kind === "throw"
        ? "throw"
        : pattern.kind === "return"
          ? "return"
          : pattern.kind === "render"
            ? "render"
            : "response",
    statusCode,
    body,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

function tryMatchParameterMethodCall(
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

  const statusCode = extractStatusCode(pattern.extraction, null, null, calls);
  const body = extractBody(pattern.extraction, null, null, calls);

  const terminal: RawTerminal = {
    kind:
      pattern.kind === "throw"
        ? "throw"
        : pattern.kind === "return"
          ? "return"
          : pattern.kind === "render"
            ? "render"
            : "response",
    statusCode,
    body,
    exceptionType: null,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

function tryMatchThrowExpression(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "throwExpression" }>,
): FoundTerminal | null {
  if (!Node.isThrowStatement(node)) {
    return null;
  }

  const thrownExpr = node.getExpression();
  const constructorPattern = match.constructorPattern;

  let callArgs: Expression[] | null = null;
  let exceptionType: string | null = null;

  if (Node.isCallExpression(thrownExpr)) {
    const calleeText = thrownExpr.getExpression().getText();
    exceptionType = calleeText;

    if (constructorPattern !== undefined) {
      if (!calleeText.startsWith(constructorPattern)) {
        return null;
      }
    }

    callArgs = thrownExpr.getArguments() as Expression[];
  } else if (Node.isNewExpression(thrownExpr)) {
    const calleeText = thrownExpr.getExpression().getText();
    exceptionType = calleeText;

    if (constructorPattern !== undefined) {
      if (!calleeText.startsWith(constructorPattern)) {
        return null;
      }
    }

    callArgs = (thrownExpr.getArguments() ?? []) as Expression[];
  } else {
    // Identifier or other expression
    if (constructorPattern !== undefined) {
      return null;
    }
    // Any throw matches when no constructorPattern
    exceptionType = thrownExpr.getText();
  }

  const statusCode = extractStatusCode(
    pattern.extraction,
    null,
    callArgs,
    null,
  );
  const body = extractBody(pattern.extraction, null, callArgs, null);

  const terminal: RawTerminal = {
    kind: "throw",
    statusCode,
    body,
    exceptionType,
    message: null,
    component: null,
    delegateTarget: null,
    emitEvent: null,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Walk every descendant of `func` and try each pattern in order (first match
 * wins per node). Returns all matched terminals across the whole function.
 */
export function findTerminals(
  func: FunctionRoot,
  patterns: TerminalPattern[],
): FoundTerminal[] {
  const results: FoundTerminal[] = [];

  func.forEachDescendant((node, traversal) => {
    // Don't descend into nested function bodies — their terminals belong
    // to those inner functions, not to `func`.
    if (
      node !== func &&
      (Node.isFunctionDeclaration(node) ||
        Node.isFunctionExpression(node) ||
        Node.isArrowFunction(node) ||
        Node.isMethodDeclaration(node))
    ) {
      traversal.skip();
      return;
    }

    for (const pattern of patterns) {
      let found: FoundTerminal | null = null;

      if (pattern.match.type === "returnShape") {
        found = tryMatchReturnShape(node, pattern, pattern.match);
      } else if (pattern.match.type === "parameterMethodCall") {
        found = tryMatchParameterMethodCall(node, func, pattern, pattern.match);
      } else if (pattern.match.type === "throwExpression") {
        found = tryMatchThrowExpression(node, pattern, pattern.match);
      }

      if (found !== null) {
        results.push(found);
        break;
      }
    }
  });

  return results;
}
