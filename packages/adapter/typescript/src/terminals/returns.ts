// returns.ts: return-statement / return-shape / parameter-method-call
// / function-call matchers. The four ways a synchronous control path
// can produce a value-bearing terminal that isn't a throw or JSX render.

import {
  type CallExpression,
  type Expression,
  type Identifier,
  Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
  type ReturnStatement,
} from "ts-morph";

import { importedRootsOf, namedImportsOf } from "../discovery/importScan.js";
import { endLineOf, startLineOf } from "../lines.js";
import { parseConditionExpression } from "../predicates.js";
import { extractShape } from "../shapes/shapes.js";
import {
  type ExtractionContext,
  extractBody,
  extractStatusCode,
} from "./extract.js";
import { resolveHelperReturn } from "./helperResolution.js";
import { returnPositionOf, unwrapValue } from "./shared.js";
import { statusChoicesOf } from "./statusBranches.js";

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
 * The value a return statement gives back, with the wrappers that pass
 * it along stripped off. `return await respond(200)` produces what
 * `return respond(200)` produces, and `return {...} as R` returns the
 * object. Null for a bare `return;`.
 */
function returnedValueOf(returnStatement: ReturnStatement): Node | null {
  const written = returnStatement.getExpression();
  return written === undefined ? null : unwrapValue(written);
}

/**
 * Match a returned object against a `returnShape` pattern.
 *
 * Returns a list because a return can produce more than one outcome. A
 * handler returning `json(...)` produces one per branch the helper can
 * take, which is how the IR expresses alternatives: separate
 * transitions, rather than one output with a set of possibilities.
 */
export function tryMatchReturnShape(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "returnShape" }>,
  resolveWrittenValue?: (value: Node) => Node | null,
): FoundTerminal[] {
  if (Node.isObjectLiteralExpression(node)) {
    const source = returnPositionOf(node);
    if (source === null) {
      return [];
    }
    // The object a return writes is handled by the ReturnStatement case
    // below, which looks through the wrappers first, so matching here as
    // well would report the same return twice. Comparing against the
    // unwrapped expression is what catches `return {...} as R` and the
    // parenthesised, `as const`, and `satisfies` spellings of it. A
    // ternary branch is not the whole returned expression, so both of
    // its objects still match here.
    if (Node.isReturnStatement(source) && returnedValueOf(source) === node) {
      return [];
    }
    const terminal = terminalFromReturnedObject(
      node,
      node,
      pattern,
      match,
      undefined,
      resolveWrittenValue,
    );
    return terminal === null ? [] : [{ ...terminal, source }];
  }

  if (!Node.isReturnStatement(node)) {
    return [];
  }

  const returned = returnedValueOf(node);
  if (returned === null) {
    return [];
  }

  if (Node.isObjectLiteralExpression(returned)) {
    const terminal = terminalFromReturnedObject(
      returned,
      node,
      pattern,
      match,
      undefined,
      resolveWrittenValue,
    );
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
    return [
      {
        node,
        source: node,
        terminal: unresolvedTerminal(pattern.kind, returned),
      },
    ];
  }

  const terminals: FoundTerminal[] = [];
  for (const value of resolved.returnValues) {
    const terminal = terminalFromReturnedObject(
      value,
      node,
      pattern,
      match,
      resolved.substitutions,
      resolveWrittenValue,
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
 * helper. `anchor` is where it gets reported, which is always the
 * caller's own return statement, so a finding points at the handler
 * rather than at a helper shared by fifty of them.
 */
function terminalFromReturnedObject(
  obj: ObjectLiteralExpression,
  anchor: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "returnShape" }>,
  substitutions?: ReadonlyMap<string, Expression>,
  resolveWrittenValue?: (value: Node) => Node | null,
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
    ...(resolveWrittenValue !== undefined ? { resolveWrittenValue } : {}),
  };
  const statusCode = extractStatusCode(ctx);
  // For a returnShape terminal, the returned object IS the body. `extractBody`
  // only knows how to pull from `ctx.calls` (parameterMethodCall) or
  // `ctx.throwCallArgs` (throw): neither applies here: so a pack that
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
    // When a helper built the value, the anchor is the caller's own
    // return, so it doubles as the provenance. A value reached any other
    // way leaves this unset and its caller fills it in.
    ...(Node.isReturnStatement(anchor) ? { source: anchor } : {}),
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
        start: startLineOf(anchor),
        end: endLineOf(anchor),
      },
    },
  };
}

export function tryMatchParameterMethodCall(
  node: Node,
  func: FunctionRoot,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "parameterMethodCall" }>,
  resolveWrittenValue?: (value: Node) => Node | null,
): FoundTerminal[] {
  if (!Node.isCallExpression(node)) {
    return [];
  }

  const result = unwrapMethodChain(
    node,
    match.methodChain,
    func,
    match.parameterPosition,
  );

  if (result === null) {
    return [];
  }

  const { calls } = result;

  // `res.json(body)` writes to the response and is often a statement on
  // its own, so it only claims a return when it is inside one.
  const source = returnPositionOf(node);

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    calls,
    ...(resolveWrittenValue !== undefined ? { resolveWrittenValue } : {}),
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
      start: startLineOf(node),
      end: endLineOf(node),
    },
  };

  const base = { node, ...(source !== null ? { source } : {}) };
  const argument = statusArgument(calls, pattern.extraction);
  const choices = argument === null ? null : statusChoicesOf(argument);
  if (choices === null) {
    return [{ ...base, terminal }];
  }
  return choices.map((choice) => ({
    ...base,
    terminal: {
      ...terminal,
      statusCode: { type: "literal" as const, value: choice.status },
    },
    whenAlso: {
      sourceText: choice.conditionText,
      structured: parseConditionExpression(choice.condition),
      polarity: choice.whenTrue ? ("positive" as const) : ("negative" as const),
      source: "explicit" as const,
    },
  }));
}

/**
 * Which argument the pack reads the status out of, when it reads one out
 * of an argument at all. Only the pack knows which one that is.
 */
function statusArgument(
  calls: CallExpression[],
  extraction: TerminalPattern["extraction"],
): Node | null {
  const from = extraction.statusCode;
  if (from === undefined || from.from !== "argument") {
    return null;
  }
  return calls[0]?.getArguments()[from.position] ?? null;
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
 * and constructor calls (`return new Error(...)`): none of which the
 * parameterMethodCall matcher would have caught, so excluding them here
 * would drop a legitimate value-bearing return.
 */
function returnCoveredByParameterMethodCall(
  expr: Node,
  func: FunctionRoot,
  patterns: TerminalPattern[],
): boolean {
  const current = unwrapValue(expr);
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
  if (Node.isReturnStatement(node)) {
    const expr = node.getExpression();
    // `excludeCallReturns` packs are using returnStatement to capture
    // value-producing returns (e.g. Fastify's bare `return user`). Skip
    // both `return;` (no value) and any return whose expression would
    // already match one of the pack's parameterMethodCall patterns ,
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
    // output regardless of what `x` is: opaque to downstream consumers
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
  // analysed: a nested `.then(res => res.json())` callback yields its
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
  // "response"`: `return user` is a 200 response. Packs that emit
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
      start: startLineOf(locationNode),
      end: endLineOf(locationNode),
    },
  };
  // The caller passes either the return statement or the body of a
  // concise arrow, so the node this terminal is on is also the return it
  // came from.
  return { node: locationNode, source: locationNode, terminal };
}

/**
 * Was this name imported from `module`? Prefix match, so "react-router"
 * also covers "react-router/server", mirroring how `requiresImport`
 * gates discovery.
 *
 * Reads the file's import declarations rather than resolving the symbol,
 * so it keeps working on a project whose dependencies are not installed.
 * That case comes up often enough to matter: a checkout without an
 * `npm install` still has its imports written down.
 */
function importedFromAny(
  callee: Identifier,
  modules: ReadonlyArray<string>,
): boolean {
  const name = callee.getText();
  const sourceFile = callee.getSourceFile();
  for (const one of namedImportsOf(sourceFile, modules, { subpaths: true })) {
    if (one.local === name) {
      return true;
    }
  }
  return importedRootsOf(sourceFile, modules, { subpaths: true }).has(name);
}

/**
 * A terminal saying the call produced a response, without claiming to
 * know which one. `dynamic` keeps the source text, so a reader can see
 * the call it came from.
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
      start: startLineOf(node),
      end: endLineOf(node),
    },
  };
}

/**
 * The name to check an import gate against: the callee itself for
 * `json(...)`, and the receiver for `NextResponse.json(...)`. Null when
 * the callee is neither, as for a call on a value built in place.
 */
function calleeSubject(callee: Node): Identifier | null {
  if (Node.isIdentifier(callee)) {
    return callee;
  }
  if (Node.isPropertyAccessExpression(callee)) {
    const subject = callee.getExpression();
    return Node.isIdentifier(subject) ? subject : null;
  }
  return null;
}

export function tryMatchFunctionCall(
  node: Node,
  pattern: TerminalPattern,
  match: Extract<TerminalPattern["match"], { type: "functionCall" }>,
  resolveWrittenValue?: (value: Node) => Node | null,
): FoundTerminal | null {
  // `new Response(body, init)` builds a response the same way
  // `Response.json(body, init)` does, so a pack that declares `Response`
  // means both.
  if (!Node.isCallExpression(node) && !Node.isNewExpression(node)) {
    return null;
  }
  // `throw new Response(...)` is a throw, and a pack that declares
  // `Response` is describing what a handler replies with. Without this
  // the same statement produces both a throw and a response.
  if (Node.isNewExpression(node) && returnPositionOf(node) === null) {
    return null;
  }

  const callee = node.getExpression();
  // A pack declares either a function (`json`) or a method on something
  // it imported (`NextResponse.json`). The name has to match, and for
  // the dotted form the import check applies to the receiver.
  const subject = calleeSubject(callee);
  if (subject === null || callee.getText() !== match.functionName) {
    return null;
  }

  // A pack that declares a function is describing a library's own
  // calling convention, so the name has to have come from that library.
  // Matching on the bare name would claim any function called the same
  // thing in the user's project, and `json` is a common name for a
  // project's own response helper, whose argument order is its own.
  if (
    match.requiresImport !== undefined &&
    match.requiresImport.length > 0 &&
    !importedFromAny(subject, match.requiresImport)
  ) {
    return null;
  }

  const callArgs = node.getArguments() as Expression[];

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    throwCallArgs: callArgs,
    ...(resolveWrittenValue !== undefined ? { resolveWrittenValue } : {}),
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
      start: startLineOf(node),
      end: endLineOf(node),
    },
  };

  // `json(...)` builds a response, and a handler nearly always returns
  // the call, but it can be assigned first and returned later.
  const source = returnPositionOf(node);
  return { node, ...(source !== null ? { source } : {}), terminal };
}
