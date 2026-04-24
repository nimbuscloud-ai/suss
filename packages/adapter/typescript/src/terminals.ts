// terminals.ts — Terminal-finding logic for ts-morph function ASTs (Task 2.3)

import {
  type CallExpression,
  type Expression,
  Node,
  type ObjectLiteralExpression,
  type ParameterDeclaration,
} from "ts-morph";

import { extractShape } from "./shapes.js";

import type { RenderNode } from "@suss/behavioral-ir";
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
// Extraction context
//
// All three matcher types feed extractStatusCode / extractBody, but each
// supplies a different subset of source material. A single context object
// keeps call sites self-documenting (see docs/style.md: 4+ params → object).
// ---------------------------------------------------------------------------

interface ExtractionContext {
  extraction: TerminalExtraction;
  /** Object literal — supplied by returnShape. */
  returnedObj?: ObjectLiteralExpression;
  /** Args of a throw's call expression — supplied by throwExpression / functionCall. */
  throwCallArgs?: Expression[];
  /** Method-chain calls (innermost → outermost) — supplied by parameterMethodCall. */
  calls?: CallExpression[];
  /** Text of the thrown constructor — supplied by throwExpression only. */
  exceptionType?: string;
}

// ---------------------------------------------------------------------------
// Status-code extraction
// ---------------------------------------------------------------------------

function extractStatusCode(ctx: ExtractionContext): RawTerminal["statusCode"] {
  const result = extractStatusCodeFromRule(ctx);
  if (result !== null) {
    return result;
  }
  // Fall back to pack-declared default (e.g. Express res.json() → 200)
  if (ctx.extraction.defaultStatusCode !== undefined) {
    return { type: "literal", value: ctx.extraction.defaultStatusCode };
  }
  return null;
}

function extractStatusCodeFromRule(
  ctx: ExtractionContext,
): RawTerminal["statusCode"] {
  const sc = ctx.extraction.statusCode;
  if (sc === undefined) {
    return null;
  }

  if (sc.from === "constructor") {
    // Look up the thrown expression's constructor name in the pack-supplied
    // mapping. Match against the full text (e.g. "HttpError.NotFound"), falling
    // back to the last dot-segment so "NotFound" alone also resolves. Without
    // a match we return null rather than guessing.
    if (ctx.exceptionType === undefined) {
      return null;
    }
    const fullMatch = sc.codes[ctx.exceptionType];
    if (fullMatch !== undefined) {
      return { type: "literal", value: fullMatch };
    }
    const lastSegment = ctx.exceptionType.split(".").pop();
    if (lastSegment !== undefined && lastSegment !== ctx.exceptionType) {
      const segMatch = sc.codes[lastSegment];
      if (segMatch !== undefined) {
        return { type: "literal", value: segMatch };
      }
    }
    return null;
  }

  if (sc.from === "property") {
    if (ctx.returnedObj === undefined) {
      return null;
    }

    for (const prop of ctx.returnedObj.getProperties()) {
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
  const minArgs = sc.minArgs;

  if (ctx.calls !== undefined) {
    // parameterMethodCall: statusCode comes from innermost call (calls[0])
    const innerCall = ctx.calls[0];
    const args = innerCall.getArguments();
    // minArgs guard: skip extraction when arg at `position` is ambiguous in
    // short-form overloads (e.g. res.redirect(url) vs res.redirect(301, url))
    if (minArgs !== undefined && args.length < minArgs) {
      return null;
    }
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

  if (ctx.throwCallArgs !== undefined) {
    // minArgs guard (see above)
    if (minArgs !== undefined && ctx.throwCallArgs.length < minArgs) {
      return null;
    }
    const rawArg = ctx.throwCallArgs[pos] as Expression | undefined;
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

function extractBody(ctx: ExtractionContext): RawTerminal["body"] {
  const b = ctx.extraction.body;
  if (b === undefined) {
    return null;
  }

  if (b.from === "property") {
    if (ctx.returnedObj === undefined) {
      return null;
    }

    for (const prop of ctx.returnedObj.getProperties()) {
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

      return { typeText: val.getText(), shape: extractShape(val) };
    }

    return null;
  }

  // from: "argument"
  const pos = b.position;
  const minArgs = b.minArgs;

  if (ctx.calls !== undefined) {
    // parameterMethodCall: body comes from outermost call (calls[N-1])
    const outerCall = ctx.calls[ctx.calls.length - 1];
    const args = outerCall.getArguments();
    // minArgs guard: skip when overload makes this position ambiguous
    if (minArgs !== undefined && args.length < minArgs) {
      return null;
    }
    const arg = args[pos] as Expression | undefined;
    if (arg === undefined) {
      return null;
    }

    return { typeText: arg.getText(), shape: extractShape(arg) };
  }

  if (ctx.throwCallArgs !== undefined) {
    // minArgs guard (see above)
    if (minArgs !== undefined && ctx.throwCallArgs.length < minArgs) {
      return null;
    }
    const arg = ctx.throwCallArgs[pos] as Expression | undefined;
    if (arg === undefined) {
      return null;
    }

    return { typeText: arg.getText(), shape: extractShape(arg) };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pattern matching + extraction per node
// ---------------------------------------------------------------------------

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

function tryMatchReturnStatement(
  node: Node,
  pattern: TerminalPattern,
): FoundTerminal | null {
  // Explicit `return expr;`
  if (Node.isReturnStatement(node)) {
    const expr = node.getExpression();
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
  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode: null,
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
 * Match a return statement whose expression is a JSX element, JSX
 * fragment, or JSX self-closing element. Used by React (and any JSX
 * framework) to classify component outputs as `render` terminals,
 * recording the root element name in `component` AND the full
 * recursive render tree in `renderTree`.
 */
function tryMatchJsxReturn(
  node: Node,
  pattern: TerminalPattern,
): FoundTerminal | null {
  // Normal `return <X />` — returns JSX from a block-body function.
  // Expression-body arrow `() => <X />` — the body expression IS JSX.
  let expr: Node | undefined;
  if (Node.isReturnStatement(node)) {
    expr = node.getExpression();
  } else if (Node.isArrowFunction(node)) {
    const body = node.getBody();
    if (body !== undefined && !Node.isBlock(body)) {
      expr = body;
    }
  }
  if (expr === undefined) {
    return null;
  }
  const tree = jsxToRenderNode(expr);
  if (tree === null) {
    return null;
  }

  // `component` is the root name for Phase 1.1 consumers and any
  // tooling that doesn't want to walk the full tree. Fragments report
  // "Fragment" (matches Phase 1.1 behavior).
  const component = tree.type === "element" ? tree.tag : "Fragment";

  const terminal: RawTerminal = {
    kind: pattern.kind,
    statusCode: null,
    body: null,
    exceptionType: null,
    message: null,
    component,
    delegateTarget: null,
    emitEvent: null,
    renderTree: tree,
    location: {
      start: node.getStartLineNumber(),
      end: node.getEndLineNumber(),
    },
  };

  return { node, terminal };
}

/**
 * Convert a JSX expression to a RenderNode recursively. Returns null
 * if the expression isn't JSX (callers use that to reject the match).
 *
 * Scope for the initial tree extraction:
 *   - Element / self-closing element → `element` node with tag and
 *     child list.
 *   - Fragment → `element` node with tag `"Fragment"`.
 *   - Parenthesized JSX → unwrap one layer.
 *   - JSX text content → `text` node with the trimmed literal.
 *   - JSX expression containers (`{...}`) → `expression` node
 *     carrying the source text. Opaque fallback for dynamic children,
 *     inline conditionals, `.map()` calls, hook references, etc.
 *     Phase 1.4 will special-case some of these; until then,
 *     preserving source text keeps information legible without
 *     committing to a shape we don't yet need.
 *
 * Attributes are NOT captured in this slice — tag + children only.
 * Adding them is a straightforward follow-up once the first
 * downstream consumer (Phase 2 Storybook stub) surfaces what
 * attribute info it actually compares against.
 */
function jsxToRenderNode(node: Node): RenderNode | null {
  if (Node.isJsxElement(node)) {
    const opening = node.getOpeningElement();
    const tag = opening.getTagNameNode().getText();
    const attrs = collectJsxAttributes(opening);
    const children = node
      .getJsxChildren()
      .map(jsxChildToRenderNode)
      .filter((n): n is RenderNode => n !== null);
    return {
      type: "element",
      tag,
      children,
      ...(attrs !== null ? { attrs } : {}),
    };
  }
  if (Node.isJsxSelfClosingElement(node)) {
    const tag = node.getTagNameNode().getText();
    const attrs = collectJsxAttributes(node);
    return {
      type: "element",
      tag,
      children: [],
      ...(attrs !== null ? { attrs } : {}),
    };
  }
  if (Node.isJsxFragment(node)) {
    // Fragments don't have attributes — the `<>...</>` syntax forbids
    // them, and `<React.Fragment key={...}>` is a JSX element, not a
    // fragment node.
    const children = node
      .getJsxChildren()
      .map(jsxChildToRenderNode)
      .filter((n): n is RenderNode => n !== null);
    return { type: "element", tag: "Fragment", children };
  }
  if (Node.isParenthesizedExpression(node)) {
    return jsxToRenderNode(node.getExpression());
  }
  return null;
}

/**
 * Build the `attrs` record for a JSX opening / self-closing element.
 * Returns null when the element has no attributes — the caller then
 * omits the field entirely so the render tree stays terse for
 * attribute-free markup. Spreads (`{...props}`) are preserved as a
 * single entry keyed on the empty string with the spread expression's
 * source text as the value; multiple spreads collapse (source order
 * is lost), but the raw source is still accessible via the original
 * JSX range for consumers that need it.
 */
function collectJsxAttributes(
  opening:
    | import("ts-morph").JsxOpeningElement
    | import("ts-morph").JsxSelfClosingElement,
): Record<string, string> | null {
  const entries: Record<string, string> = {};
  for (const attr of opening.getAttributes()) {
    if (Node.isJsxSpreadAttribute(attr)) {
      // Record spreads under a bucket keyed "...expr" so consumers can
      // see them without clobbering a named attribute.
      const exprText = attr.getExpression().getText();
      entries[`...${exprText}`] = exprText;
      continue;
    }
    if (!Node.isJsxAttribute(attr)) {
      continue;
    }
    const name = attr.getNameNode().getText();
    const initializer = attr.getInitializer();
    if (initializer === undefined) {
      // Boolean-shorthand attribute (`<input disabled>`).
      entries[name] = "";
      continue;
    }
    if (Node.isJsxExpression(initializer)) {
      const inner = initializer.getExpression();
      entries[name] = inner !== undefined ? inner.getText() : "";
      continue;
    }
    // String-literal-valued attribute (`type="button"`). Keep the
    // full source text including quotes — downstream consumers can
    // strip if they want, but preserving raw text is consistent with
    // the expression case.
    entries[name] = initializer.getText();
  }
  return Object.keys(entries).length > 0 ? entries : null;
}

/**
 * Map a single JSX child to a RenderNode. Whitespace-only JSX text
 * (which appears between siblings) returns null so it doesn't
 * pollute the tree with empty nodes.
 */
function jsxChildToRenderNode(child: Node): RenderNode | null {
  if (Node.isJsxText(child)) {
    const text = child.getLiteralText().trim();
    if (text.length === 0) {
      return null;
    }
    return { type: "text", value: text };
  }
  if (Node.isJsxExpression(child)) {
    const inner = child.getExpression();
    if (inner === undefined) {
      return null;
    }
    return jsxExpressionToRenderNode(inner);
  }
  if (
    Node.isJsxElement(child) ||
    Node.isJsxSelfClosingElement(child) ||
    Node.isJsxFragment(child)
  ) {
    return jsxToRenderNode(child);
  }
  return null;
}

/**
 * Decompose the expression inside a `{...}` JSX child. The Phase 1.4
 * patterns we recognise:
 *
 *   {cond && <X/>}          → conditional(cond, <X/>, null)
 *   {cond ? <A/> : <B/>}    → conditional(cond, <A/>, <B/>)
 *   {cond ? <A/> : null}    → conditional(cond, <A/>, null)
 *
 * Anything else (identifiers, property access, `.map()` calls, function
 * calls, JSX references that aren't inline-constructed) falls through
 * to the opaque `expression` node with source text preserved. We
 * deliberately don't recurse into arbitrary expressions — if the
 * conditional's branches aren't JSX or null, the whole thing stays
 * opaque so downstream tools don't confuse "we decomposed this" with
 * "we understood this." `||` is left opaque: the common idiom
 * `value || <Fallback/>` renders the fallback when `value` is falsy,
 * which is already captured by treating it as an expression whose
 * source text tells the reader what's happening.
 */
function jsxExpressionToRenderNode(expr: Node): RenderNode {
  if (Node.isParenthesizedExpression(expr)) {
    return jsxExpressionToRenderNode(expr.getExpression());
  }

  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === "&&") {
      const right = renderAlternative(unwrapParens(expr.getRight()));
      if (right.kind === "jsx") {
        return {
          type: "conditional",
          condition: expr.getLeft().getText(),
          whenTrue: right.node,
          whenFalse: null,
        };
      }
    }
  }

  if (Node.isConditionalExpression(expr)) {
    const truthy = renderAlternative(unwrapParens(expr.getWhenTrue()));
    const falsy = renderAlternative(unwrapParens(expr.getWhenFalse()));

    if (truthy.kind === "jsx") {
      return {
        type: "conditional",
        condition: expr.getCondition().getText(),
        whenTrue: truthy.node,
        whenFalse: falsy.kind === "jsx" ? falsy.node : null,
      };
    }
    if (falsy.kind === "jsx") {
      // {cond ? someValue : <Fallback/>} — decompose with the condition
      // negated textually. We can't invert an arbitrary expression
      // structurally, so the `!(...)` wrap keeps the source text legible.
      return {
        type: "conditional",
        condition: `!(${expr.getCondition().getText()})`,
        whenTrue: falsy.node,
        whenFalse: null,
      };
    }
  }

  return { type: "expression", sourceText: expr.getText() };
}

type AlternativeResult =
  | { kind: "jsx"; node: RenderNode }
  | { kind: "noRender" }
  | { kind: "notStatic" };

/**
 * Classify one branch of a JSX conditional.
 *   - JSX element / fragment → a renderable node.
 *   - `null` / `false` / `undefined` literal → renders nothing (React's
 *     own "no render" conventions).
 *   - Anything else → don't decompose the enclosing conditional.
 */
function renderAlternative(node: Node): AlternativeResult {
  if (Node.isNullLiteral(node)) {
    return { kind: "noRender" };
  }
  if (Node.isFalseLiteral(node)) {
    return { kind: "noRender" };
  }
  if (Node.isIdentifier(node) && node.getText() === "undefined") {
    return { kind: "noRender" };
  }
  if (
    Node.isJsxElement(node) ||
    Node.isJsxSelfClosingElement(node) ||
    Node.isJsxFragment(node)
  ) {
    const tree = jsxToRenderNode(node);
    if (tree !== null) {
      return { kind: "jsx", node: tree };
    }
  }
  return { kind: "notStatic" };
}

function unwrapParens(node: Node): Node {
  return Node.isParenthesizedExpression(node)
    ? unwrapParens(node.getExpression())
    : node;
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
  const classified = classifyThrownExpression(thrownExpr, constructorPattern);
  if (classified === null) {
    return null;
  }
  const { callArgs, exceptionType } = classified;

  const ctx: ExtractionContext = {
    extraction: pattern.extraction,
    ...(callArgs !== null ? { throwCallArgs: callArgs } : {}),
    ...(exceptionType !== null ? { exceptionType } : {}),
  };
  const statusCode = extractStatusCode(ctx);
  const body = extractBody(ctx);
  const message = extractThrowMessage(callArgs);

  const terminal: RawTerminal = {
    kind: "throw",
    statusCode,
    body,
    exceptionType,
    message,
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
 * Pull the literal message string out of a thrown constructor's arguments.
 * Covers the two dominant shapes:
 *
 *   throw new Error("boom");            // message = "boom"
 *   throw new HttpError(404, "boom");   // message = "boom"  (first string arg)
 *
 * The first string-literal argument (StringLiteral or no-substitution
 * template literal) is returned regardless of position, so constructors
 * that put the code before the message still surface the message. Template
 * literals with substitutions (`Error: ${e}`) preserve their source text —
 * runtime value isn't resolvable, but the composition stays visible.
 * Returns null when no static message is present (no string args, or the
 * thrown expression is a bare identifier / member access).
 */
function extractThrowMessage(callArgs: Expression[] | null): string | null {
  if (callArgs === null) {
    return null;
  }
  for (const arg of callArgs) {
    if (
      Node.isStringLiteral(arg) ||
      Node.isNoSubstitutionTemplateLiteral(arg)
    ) {
      return arg.getLiteralValue();
    }
    if (Node.isTemplateExpression(arg)) {
      return arg.getText();
    }
  }
  return null;
}

/**
 * Inspect a `throw <expr>` expression and produce the (exceptionType,
 * callArgs) pair the terminal builder needs. Three shapes:
 *   - `throw fn(args)`          — callExpression; callArgs filled.
 *   - `throw new Ctor(args)`    — newExpression; callArgs filled.
 *   - `throw err` / `throw obj` — identifier / member / etc; no args.
 *
 * When the match specifies `constructorPattern`, the leading portion
 * of the callee text has to match it; anything else returns null.
 * Without a pattern, any throw matches and `exceptionType` is the
 * thrown expression's text.
 */
function classifyThrownExpression(
  thrown: Node,
  constructorPattern: string | undefined,
): { callArgs: Expression[] | null; exceptionType: string } | null {
  if (Node.isCallExpression(thrown) || Node.isNewExpression(thrown)) {
    const calleeText = thrown.getExpression().getText();
    if (
      constructorPattern !== undefined &&
      !calleeText.startsWith(constructorPattern)
    ) {
      return null;
    }
    return {
      callArgs: (thrown.getArguments() ?? []) as Expression[],
      exceptionType: calleeText,
    };
  }
  // Any-other-shape throw. If the pattern constrains a specific
  // constructor, this bare-identifier (or member access) can't match.
  if (constructorPattern !== undefined) {
    return null;
  }
  return { callArgs: null, exceptionType: thrown.getText() };
}

function tryMatchFunctionCall(
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
      } else if (pattern.match.type === "returnStatement") {
        found = tryMatchReturnStatement(node, pattern);
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
          found = tryMatchReturnStatement(func, pattern);
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
