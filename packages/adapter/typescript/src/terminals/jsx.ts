// jsx.ts — JSX-return matching + render-tree construction. Used by
// React (and any JSX-emitting framework) to classify component
// outputs as `render` terminals with a recursive renderTree.

import { Node } from "ts-morph";

import type { RenderNode } from "@suss/behavioral-ir";
import type { RawTerminal, TerminalPattern } from "@suss/extractor";
import type { FoundTerminal } from "./shared.js";

/**
 * Match a return statement whose expression is a JSX element, JSX
 * fragment, or JSX self-closing element. Records the root element name
 * in `component` AND the full recursive render tree in `renderTree`.
 */
export function tryMatchJsxReturn(
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
