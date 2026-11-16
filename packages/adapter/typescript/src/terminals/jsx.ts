// jsx.ts: JSX-return matching + render-tree construction. Used by
// React (and any JSX-emitting framework) to classify component
// outputs as `render` terminals with a recursive renderTree.

import { Node } from "ts-morph";

import { factValueOps } from "@suss/recognize/ops";

import { toFunctionRoot } from "../discovery/shared.js";
import { endLineOf, startLineOf } from "../lines.js";
import { nodeOfValue } from "../resolve/callOps.js";
import { factSourceFor, statedFactKey } from "../resolve/factSource.js";
import { hasBody, isInExternalCode } from "../resolve/unfollowedCall.js";
import { writesUndefined } from "../walk/undefinedValue.js";
import { peelParens } from "../walk/unwrap.js";

import type { RenderNode } from "@suss/behavioral-ir";
import type {
  FactSource,
  RawTerminal,
  TerminalPattern,
  ValueOps,
} from "@suss/extractor";
import type { JsxOpeningElement, JsxSelfClosingElement, ts } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { FoundTerminal } from "./shared.js";

/** Where a component tag's declaration is, as the render edge keys it. */
interface RenderTarget {
  file: string;
  name: string;
}

/**
 * The target the store gave each binding a tag refers to, for each run's
 * store. Every tag that refers to one binding settles to the same
 * component, so a file that renders a component many times asks once.
 */
const TARGETS_BY_BINDING = new WeakMap<
  ResolutionStore,
  WeakMap<ts.Symbol, RenderTarget | null>
>();

/**
 * Where each component tag's declaration is, for the render edge, read
 * over one fact source for the whole tree. The checker joins this to the
 * child summary's file and name, which is how a parent's passed props
 * meet the props the child reads. A tag written as a capitalised name is
 * asked of the store, and any other tag, such as `div` or `Menu.Item`,
 * has no target.
 */
class ComponentTargets {
  private readonly resolution: ResolutionStore | undefined;
  private source: FactSource | undefined;

  constructor(resolution: ResolutionStore | undefined) {
    this.resolution = resolution;
  }

  of(tag: Node): RenderTarget | null {
    if (
      this.resolution === undefined ||
      !Node.isIdentifier(tag) ||
      !/^[A-Z]/.test(tag.getText())
    ) {
      return null;
    }
    const binding = tag.getSymbol()?.compilerSymbol;
    if (binding === undefined) {
      return this.asked(tag, this.resolution);
    }
    const known = targetsKnownTo(this.resolution);
    if (!known.has(binding)) {
      known.set(binding, this.asked(tag, this.resolution));
    }
    const target = known.get(binding) ?? null;
    return target === null ? null : { ...target };
  }

  private asked(tag: Node, resolution: ResolutionStore): RenderTarget | null {
    this.source ??= factSourceFor(resolution);
    const value = factValueOps(statedFactKey(tag, resolution), this.source);
    return componentTargetOf(value, tag.getText());
  }
}

function targetsKnownTo(
  resolution: ResolutionStore,
): WeakMap<ts.Symbol, RenderTarget | null> {
  const known = TARGETS_BY_BINDING.get(resolution);
  if (known !== undefined) {
    return known;
  }
  const fresh = new WeakMap<ts.Symbol, RenderTarget | null>();
  TARGETS_BY_BINDING.set(resolution, fresh);
  return fresh;
}

/**
 * Match a return statement whose expression is a JSX element, JSX
 * fragment, or JSX self-closing element. Records the root element name
 * in `component` AND the full recursive render tree in `renderTree`.
 */
export function tryMatchJsxReturn(
  node: Node,
  pattern: TerminalPattern,
  resolution: ResolutionStore | undefined,
): FoundTerminal | null {
  // Normal `return <X />`, returns JSX from a block-body function.
  // Expression-body arrow `() => <X />`, the body expression IS JSX.
  // Either shape returns the JSX, so the source is the return statement
  // itself or, for an arrow written without one, its body.
  let expr: Node | undefined;
  let source: Node | undefined;
  if (Node.isReturnStatement(node)) {
    expr = node.getExpression();
    source = node;
  } else if (Node.isArrowFunction(node)) {
    const body = node.getBody();
    if (body !== undefined && !Node.isBlock(body)) {
      expr = body;
      source = body;
    }
  }
  if (expr === undefined || source === undefined) {
    return null;
  }
  const tree = jsxToRenderNode(expr, new ComponentTargets(resolution));
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
      start: startLineOf(node),
      end: endLineOf(node),
    },
  };

  return { node, source, terminal };
}

/**
 * The file of the function the tag settles to, under the name the tag's
 * value is declared under, since the checker keys a child summary that
 * way: `export const TextInput = forwardRef(Inner)` is `TextInput` at
 * `Inner`'s file. A component declared with no name of its own, such as
 * an anonymous default export, goes by the tag as written. A function
 * with no body, or one in a library, is no target.
 */
function componentTargetOf(
  tag: ValueOps,
  written: string,
): RenderTarget | null {
  const found = tag.function?.() ?? null;
  const node = found === null ? null : nodeOfValue(found);
  const func = node === null ? null : toFunctionRoot(node);
  if (
    func === null ||
    !hasBody(func) ||
    isInExternalCode(func.getSourceFile())
  ) {
    return null;
  }
  return {
    file: func.getSourceFile().getFilePath(),
    name: tag.declaration?.()?.name ?? written,
  };
}

/**
 * Convert a JSX expression to a RenderNode recursively. Returns null
 * if the expression isn't JSX (callers use that to reject the match).
 */
function jsxToRenderNode(
  node: Node,
  targets: ComponentTargets,
): RenderNode | null {
  const childOf = (child: Node) => jsxChildToRenderNode(child, targets);
  if (Node.isJsxElement(node)) {
    const opening = node.getOpeningElement();
    const tag = opening.getTagNameNode().getText();
    const attrs = collectJsxAttributes(opening);
    const target = targets.of(opening.getTagNameNode());
    const children = node
      .getJsxChildren()
      .map(childOf)
      .filter((n): n is RenderNode => n !== null);
    return {
      type: "element",
      tag,
      children,
      ...(attrs !== null ? { attrs } : {}),
      ...(target !== null ? { target } : {}),
    };
  }
  if (Node.isJsxSelfClosingElement(node)) {
    const tag = node.getTagNameNode().getText();
    const attrs = collectJsxAttributes(node);
    const target = targets.of(node.getTagNameNode());
    return {
      type: "element",
      tag,
      children: [],
      ...(attrs !== null ? { attrs } : {}),
      ...(target !== null ? { target } : {}),
    };
  }
  if (Node.isJsxFragment(node)) {
    // Fragments don't have attributes, the `<>...</>` syntax forbids
    // them, and `<React.Fragment key={...}>` is a JSX element, not a
    // fragment node.
    const children = node
      .getJsxChildren()
      .map(childOf)
      .filter((n): n is RenderNode => n !== null);
    return { type: "element", tag: "Fragment", children };
  }
  if (Node.isParenthesizedExpression(node)) {
    return jsxToRenderNode(node.getExpression(), targets);
  }
  return null;
}

/**
 * Build the `attrs` record for a JSX opening / self-closing element.
 * Returns null when the element has no attributes, the caller then
 * omits the field entirely so the render tree stays terse for
 * attribute-free markup. Spreads (`{...props}`) are preserved as a
 * single entry keyed on the empty string with the spread expression's
 * source text as the value; multiple spreads collapse (source order
 * is lost), but the raw source is still accessible via the original
 * JSX range for consumers that need it.
 */
function collectJsxAttributes(
  opening: JsxOpeningElement | JsxSelfClosingElement,
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
    // full source text including quotes, downstream consumers can
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
function jsxChildToRenderNode(
  child: Node,
  targets: ComponentTargets,
): RenderNode | null {
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
    return jsxExpressionToRenderNode(inner, targets);
  }
  if (
    Node.isJsxElement(child) ||
    Node.isJsxSelfClosingElement(child) ||
    Node.isJsxFragment(child)
  ) {
    return jsxToRenderNode(child, targets);
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
 * deliberately don't recurse into arbitrary expressions, if the
 * conditional's branches aren't JSX or null, the whole thing stays
 * opaque so downstream tools don't confuse "we decomposed this" with
 * "we understood this." `||` is left opaque: the common idiom
 * `value || <Fallback/>` renders the fallback when `value` is falsy,
 * which is already captured by treating it as an expression whose
 * source text tells the reader what's happening.
 */
function jsxExpressionToRenderNode(
  expr: Node,
  targets: ComponentTargets,
): RenderNode {
  if (Node.isParenthesizedExpression(expr)) {
    return jsxExpressionToRenderNode(expr.getExpression(), targets);
  }

  if (Node.isBinaryExpression(expr)) {
    const op = expr.getOperatorToken().getText();
    if (op === "&&") {
      const right = renderAlternative(peelParens(expr.getRight()), targets);
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
    const truthy = renderAlternative(peelParens(expr.getWhenTrue()), targets);
    const falsy = renderAlternative(peelParens(expr.getWhenFalse()), targets);

    if (truthy.kind === "jsx") {
      return {
        type: "conditional",
        condition: expr.getCondition().getText(),
        whenTrue: truthy.node,
        whenFalse: falsy.kind === "jsx" ? falsy.node : null,
      };
    }
    if (falsy.kind === "jsx") {
      // {cond ? someValue : <Fallback/>}, decompose with the condition
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
function renderAlternative(
  node: Node,
  targets: ComponentTargets,
): AlternativeResult {
  if (Node.isNullLiteral(node)) {
    return { kind: "noRender" };
  }
  if (Node.isFalseLiteral(node)) {
    return { kind: "noRender" };
  }
  if (writesUndefined(node)) {
    return { kind: "noRender" };
  }
  if (
    Node.isJsxElement(node) ||
    Node.isJsxSelfClosingElement(node) ||
    Node.isJsxFragment(node)
  ) {
    const tree = jsxToRenderNode(node, targets);
    if (tree !== null) {
      return { kind: "jsx", node: tree };
    }
  }
  return { kind: "notStatic" };
}
