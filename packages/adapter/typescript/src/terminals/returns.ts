// returns.ts — return-statement / return-shape / parameter-method-call
// / function-call matchers. The four ways a synchronous control path
// can produce a value-bearing terminal that isn't a throw or JSX render.

import {
  type CallExpression,
  type Expression,
  type Identifier,
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
import { resolveHelperReturn } from "./helperResolution.js";

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
/**
 * The return a value sits in, or null when it does not sit in one. A
 * concise arrow answers with its body, since that is what it returns.
 */
function returnPositionOf(ole: Node): Node | null {
  let current: Node | undefined = ole.getParent();
  // Direct child of ReturnStatement is already handled by the ReturnStatement
  // case in tryMatchReturnShape — skip to avoid duplicate terminals.
  if (current !== undefined && Node.isReturnStatement(current)) {
    return null;
  }
  while (current !== undefined) {
    if (Node.isReturnStatement(current)) {
      return current;
    }
    if (Node.isArrowFunction(current)) {
      // Only match expression bodies, not OLEs inside a block body
      const body = current.getBody();
      return body !== undefined && !Node.isBlock(body) ? body : null;
    }
    // Walk through ternary branches and parens
    if (
      Node.isParenthesizedExpression(current) ||
      Node.isConditionalExpression(current)
    ) {
      current = current.getParent();
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Match a returned object against a `returnShape` pattern.
 *
 * Returns a list because a return can produce more than one outcome. A
 * handler returning `json(...)` produces one per branch the helper can
 * take, which is how the IR expresses alternatives: separate
 * transitions, not one output holding a set of possibilities.
 */
export function tryMatchReturnShape(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "returnShape" }>,
): FoundTerminal[] {
  if (Node.isObjectLiteralExpression(node)) {
    const source = returnPositionOf(node);
    if (source === null) {
      return [];
    }
    const terminal = terminalFromReturnedObject(node, node, pattern, match);
    return terminal === null ? [] : [{ ...terminal, source }];
  }

  if (!Node.isReturnStatement(node)) {
    return [];
  }

  const returned = node.getExpression();
  if (returned === undefined) {
    return [];
  }

  if (Node.isObjectLiteralExpression(returned)) {
    const terminal = terminalFromReturnedObject(returned, node, pattern, match);
    return terminal === null ? [] : [terminal];
  }

  if (!Node.isCallExpression(returned)) {
    return [];
  }

  // `return json(200, payload)`. Most handlers build the response in a
  // helper rather than at the return site, and the helper belongs to the
  // project, so read it instead of guessing what its arguments mean.
  const resolved = resolveHelperReturn(returned);
  if (resolved.kind === "notLocal") {
    return [];
  }
  if (resolved.kind === "unreadable") {
    return [{ node, terminal: unresolvedTerminal(pattern.kind, returned) }];
  }

  const terminals: FoundTerminal[] = [];
  for (const value of resolved.returnValues) {
    const terminal = terminalFromReturnedObject(
      value,
      node,
      pattern,
      match,
      resolved.substitutions,
    );
    if (terminal !== null) {
      terminals.push(terminal);
    }
  }
  return terminals;
}

/**
 * Build one terminal from one returned object.
 *
 * `obj` is where the properties are read from, which may be inside a
 * helper. `anchor` is where it is reported, which is always the caller's
 * own return statement, so a finding points at the handler rather than
 * at a helper shared by fifty of them.
 */
function terminalFromReturnedObject(
  obj: ObjectLiteralExpression,
  anchor: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "returnShape" }>,
  substitutions?: ReadonlyMap<string, Expression>,
): FoundTerminal | null {
  const required = match.requiredProperties;
  if (required !== undefined && required.length > 0) {
    const presentNames = new Set<string>();
    for (const prop of obj.getProperties()) {
      if (
        Node.isPropertyAssignment(prop) ||
        Node.isShorthandPropertyAssignment(prop)
      ) {
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
    ...(substitutions !== undefined ? { substitutions } : {}),
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

  return {
    node: anchor,
    terminal: {
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
        start: anchor.getStartLineNumber(),
        end: anchor.getEndLineNumber(),
      },
    },
  };
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
 * Would the returned expression already match one of the pack's
 * `parameterMethodCall` patterns? Used by `excludeCallReturns` so a
 * pack that captures `reply.send(...)` via `parameterMethodCall` doesn't
 * also fire on the enclosing `return reply.send(...)`. The check peels
 * `await` / casts / parens so `return await reply.send(...)` is treated
 * the same as `return reply.send(...)`.
 *
 * Returns false for free-function calls (`return findUser(id)`),
 * method calls on non-parameter receivers (`return await db.findById(id)`),
 * and constructor calls (`return new Error(...)`) — none of which the
 * parameterMethodCall matcher would have caught, so excluding them here
 * would drop a legitimate value-bearing return.
 */
function returnCoveredByParameterMethodCall(
  expr: Node,
  func: FunctionRoot,
  patterns: TerminalPattern[],
): boolean {
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
  if (!Node.isCallExpression(current)) {
    return false;
  }
  for (const pattern of patterns) {
    if (pattern.match.type !== "parameterMethodCall") {
      continue;
    }
    const result = unwrapMethodChain(
      current,
      pattern.match.methodChain,
      func,
      pattern.match.parameterPosition,
    );
    if (result !== null) {
      return true;
    }
  }
  return false;
}

export function tryMatchReturnStatement(
  node: Node,
  pattern: TerminalPattern,
  func: FunctionRoot,
  allPatterns: TerminalPattern[],
): FoundTerminal | null {
  const match = pattern.match.type === "returnStatement" ? pattern.match : null;
  // Explicit `return expr;`
  if (Node.isReturnStatement(node)) {
    const expr = node.getExpression();
    // `excludeCallReturns` packs are using returnStatement to capture
    // value-producing returns (e.g. Fastify's bare `return user`). Skip
    // both `return;` (no value) and any return whose expression would
    // already match one of the pack's parameterMethodCall patterns —
    // matching it here as well would double-fire.
    if (match?.excludeCallReturns === true) {
      if (expr === undefined) {
        return null;
      }
      if (returnCoveredByParameterMethodCall(expr, func, allPatterns)) {
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
  // The body expression IS the return value. The walker descends into
  // nested arrows now, but gates return-valued terminals to the unit's
  // own scope (see `NESTED_ESCAPING_MATCH_TYPES` in terminals/index.ts),
  // so this branch only fires for the arrow that IS the function being
  // analysed — a nested `.then(res => res.json())` callback yields its
  // own value, not the unit's.
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

/**
 * Was this name imported from `module`? Prefix match, so "react-router"
 * also covers "react-router/server", mirroring how `requiresImport`
 * gates discovery.
 *
 * Reads the file's import declarations rather than resolving the symbol,
 * which keeps it working against a project whose dependencies are not
 * installed. That case is common enough to matter: a checkout without an
 * `npm install` still has its imports written down.
 */
function importedFromAny(
  callee: Identifier,
  modules: ReadonlyArray<string>,
): boolean {
  const name = callee.getText();
  for (const declaration of callee.getSourceFile().getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    const matches = modules.some(
      (module) => specifier === module || specifier.startsWith(`${module}/`),
    );
    if (!matches) {
      continue;
    }
    for (const named of declaration.getNamedImports()) {
      if ((named.getAliasNode() ?? named.getNameNode()).getText() === name) {
        return true;
      }
    }
    if (declaration.getDefaultImport()?.getText() === name) {
      return true;
    }
  }
  return false;
}

/**
 * A terminal that says the call produced a response without claiming to
 * know which one. `dynamic` carries the source text, so a reader sees
 * the call that produced it.
 */
function unresolvedTerminal(
  kind: TerminalPattern["kind"],
  node: Node,
): RawTerminal {
  return {
    kind,
    statusCode: { type: "dynamic", sourceText: node.getText() },
    body: null,
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

  // A pack that names a function is describing a library's own calling
  // convention, so the name has to have come from that library. Matching
  // the bare name would claim any same-named function in the user's
  // project, and `json` is a common name for a project's own response
  // helper, whose argument order is its author's business.
  if (
    match.requiresImport !== undefined &&
    match.requiresImport.length > 0 &&
    !importedFromAny(callee, match.requiresImport)
  ) {
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
