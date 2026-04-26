// shapes.ts — Extract structured TypeShape from expression nodes.
//
// Three-pass strategy, in order:
//
//   1. **Syntactic decomposition.** Walk the AST. Object / array / primitive
//      literals and wrapping expressions decompose directly — this preserves
//      literal narrowness (`"success"` → `{ literal, value: "success" }`,
//      not `text`).
//
//   2. **AST resolution.** For terminal nodes that aren't literals —
//      bare identifiers, property access chains, call expressions — walk
//      back to the declaration and recurse on the initializer or return
//      expression. This lets us preserve literal narrowness even when the
//      type checker would widen (e.g. `const status = "ok"` at a use site
//      gives `string` from the checker, but `"ok"` from the AST).
//
//   3. **Type-checker fallback.** Anything the AST walk couldn't resolve is
//      handed to ts-morph's type checker via `shapeFromNodeType`, which
//      translates the inferred type into the same `TypeShape` vocabulary.
//      This picks up declared types for identifiers whose declaration we
//      can't statically expand (cross-module types, generics, etc.).
//
// Spreads inside object literals resolve through the same mechanism: when
// `{ ...user, admin: true }` is decomposed, the spread's expression goes
// through the full pipeline; a resolvable record is merged into the
// accumulator in source order (matching JS override semantics), and only
// unresolvable spreads fall through to the `spreads[]` escape hatch.

import {
  type Identifier,
  Node,
  type ObjectLiteralExpression,
  SyntaxKind,
} from "ts-morph";

import { resolveNodeFromAst } from "../resolve/astResolve.js";
import { shapeFromNodeType } from "./typeShapes.js";

import type { TypeShape } from "@suss/behavioral-ir";

// Module-local recursion guard. `extractShape` and `resolveNodeFromAst`
// can call each other transitively (extractShape → resolveNodeFromAst →
// extractShape), and each entry to `resolveNodeFromAst` resets its own
// cycle-detection context. That makes the cross-extractor path unbounded
// for self-referential call graphs (`function a() { return b(); }
// function b() { return a(); }`). Cap the call stack here as a safety
// net — past the limit, fall back to the type-checker path which has
// its own depth/seen tracking.
const MAX_EXTRACT_DEPTH = 64;
let extractShapeDepth = 0;

/**
 * Attempt to decompose `node` into a structured `TypeShape`. Returns `null`
 * only when the expression is syntactically unrecognized AND the type checker
 * cannot infer anything useful — callers then fall back to a source-text ref.
 */
export function extractShape(node: Node): TypeShape | null {
  if (extractShapeDepth >= MAX_EXTRACT_DEPTH) {
    // Defer to the type checker, which has its own seen-set / depth guard.
    return shapeFromNodeType(node);
  }
  extractShapeDepth += 1;
  try {
    return extractShapeInner(node);
  } finally {
    extractShapeDepth -= 1;
  }
}

function extractShapeInner(node: Node): TypeShape | null {
  const unwrapped = unwrap(node);

  // Object / array literals: syntactic decomposition preserves literal
  // narrowness that the type checker would widen.
  if (Node.isObjectLiteralExpression(unwrapped)) {
    return shapeFromObjectLiteral(unwrapped);
  }

  if (Node.isArrayLiteralExpression(unwrapped)) {
    return shapeFromArrayLiteral(unwrapped);
  }

  // Primitive literals — preserve the exact value.
  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return { type: "literal", value: unwrapped.getLiteralValue() };
  }

  // Template expressions with substitutions can't be reduced to a single
  // literal — surface as the widened primitive.
  if (Node.isTemplateExpression(unwrapped)) {
    return { type: "text" };
  }

  if (Node.isNumericLiteral(unwrapped)) {
    return numericLiteralShape(
      unwrapped.getLiteralValue(),
      unwrapped.getText(),
    );
  }

  // Negative numeric literal: `-3` parses as PrefixUnaryExpression(-,
  // NumericLiteral(3)). `+3` likewise. Fold the sign into the literal value
  // and its raw source text.
  if (Node.isPrefixUnaryExpression(unwrapped)) {
    const op = unwrapped.getOperatorToken();
    if (op === SyntaxKind.MinusToken || op === SyntaxKind.PlusToken) {
      const inner = unwrapped.getOperand();
      if (Node.isNumericLiteral(inner)) {
        const v = inner.getLiteralValue();
        const signed = op === SyntaxKind.MinusToken ? -v : v;
        const rawBody = inner.getText();
        const raw = op === SyntaxKind.MinusToken ? `-${rawBody}` : rawBody;
        return numericLiteralShape(signed, raw);
      }
    }
    // Any other prefix unary (!, ~, ++, --) — fall through.
  }

  if (Node.isBigIntLiteral(unwrapped)) {
    return { type: "ref", name: "bigint" };
  }

  const kind = unwrapped.getKind();
  if (kind === SyntaxKind.TrueKeyword) {
    return { type: "literal", value: true };
  }
  if (kind === SyntaxKind.FalseKeyword) {
    return { type: "literal", value: false };
  }
  if (kind === SyntaxKind.NullKeyword) {
    return { type: "null" };
  }

  // `undefined` is parsed as an identifier, not a keyword.
  if (Node.isIdentifier(unwrapped) && unwrapped.getText() === "undefined") {
    return { type: "undefined" };
  }

  // Ternary: `cond ? a : b` → union of the two branches. The condition is
  // metadata about when each branch fires, not part of the shape.
  if (Node.isConditionalExpression(unwrapped)) {
    const whenTrue = extractShape(unwrapped.getWhenTrue());
    const whenFalse = extractShape(unwrapped.getWhenFalse());
    const variants: TypeShape[] = [];
    if (whenTrue) {
      variants.push(whenTrue);
    }
    if (whenFalse) {
      variants.push(whenFalse);
    }
    if (variants.length === 0) {
      return shapeFromNodeType(unwrapped);
    }
    return collapseVariants(variants);
  }

  // Everything else — identifiers, property access chains, call expressions,
  // `new` expressions, tagged templates — try AST resolution first (which
  // preserves literal narrowness that the type checker would widen), then
  // fall back to the type checker.
  const astShape = resolveNodeFromAst(unwrapped, extractShape);
  if (astShape !== null) {
    return astShape;
  }
  return shapeFromNodeType(unwrapped);
}

/**
 * Strip wrappers that don't affect the value's shape: `as` / angle-bracket
 * type assertions, `!` non-null assertions, parentheses, `await`, and
 * satisfies clauses.
 */
function unwrap(node: Node): Node {
  let current = node;
  // Each pass peels one layer; loop until we hit something with semantic
  // weight. Explicit bound to avoid pathological depth via odd ASTs.
  for (let i = 0; i < 16; i++) {
    if (Node.isAsExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isTypeAssertion(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isNonNullExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
      continue;
    }
    // Don't unwrap AwaitExpression: TypeScript's inferred type for the
    // await node itself is the resolved value (Promise unwrapping). Peeling
    // to the operand would hand us `Promise<T>` instead of `T`.
    break;
  }
  return current;
}

/**
 * Build a numeric-literal `TypeShape`, carrying the raw source text so
 * consumers needing exact wire-format precision aren't tripped up by JS
 * `number` coercion losses (see "Serialization semantics" in the IR
 * reference).
 */
function numericLiteralShape(value: number, raw: string): TypeShape {
  return { type: "literal", value, raw };
}

function shapeFromArrayLiteral(
  arr: import("ts-morph").ArrayLiteralExpression,
): TypeShape {
  const elements = arr.getElements();
  if (elements.length === 0) {
    return { type: "array", items: { type: "unknown" } };
  }

  const shapes: TypeShape[] = [];
  for (const el of elements) {
    // Spread elements inside arrays: `[...xs, y]`. The spread contributes
    // items of whatever element type `xs` has. Unwrap to that element type.
    if (Node.isSpreadElement(el)) {
      const inner = el.getExpression();
      const innerShape = extractShape(inner);
      if (innerShape?.type === "array") {
        shapes.push(innerShape.items);
        continue;
      }
      shapes.push(innerShape ?? { type: "ref", name: inner.getText() });
      continue;
    }

    const shape = extractShape(el) ?? { type: "ref", name: el.getText() };
    shapes.push(shape);
  }

  return { type: "array", items: collapseVariants(shapes) };
}

function shapeFromObjectLiteral(obj: ObjectLiteralExpression): TypeShape {
  const properties: Record<string, TypeShape> = {};
  const unresolvedSpreads: Array<{ sourceText: string }> = [];

  // Walk in source order so later keys / spreads override earlier ones,
  // matching JS semantics (`{ a: 1, ...x, a: 2 }` has `a === 2`).
  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = propertyName(prop);
      if (name === null) {
        // Computed property key we can't resolve — nothing we can record on
        // the structured shape; skip rather than invent a name.
        continue;
      }
      const init = prop.getInitializer();
      if (init === undefined) {
        properties[name] = { type: "unknown" };
        continue;
      }
      properties[name] = extractShape(init) ?? {
        type: "ref",
        name: init.getText(),
      };
      continue;
    }

    if (Node.isShorthandPropertyAssignment(prop)) {
      const name = prop.getName();
      const valueExpr: Identifier = prop.getNameNode();
      properties[name] = extractShape(valueExpr) ?? {
        type: "ref",
        name,
      };
      continue;
    }

    if (Node.isSpreadAssignment(prop)) {
      const expr = prop.getExpression();
      const spreadShape = extractShape(expr);
      if (spreadShape?.type === "record") {
        // Inline the spread's properties at this position. Any own-key we
        // already recorded remains only if the spread doesn't override it;
        // later spreads / assignments still overwrite, matching source order.
        for (const [k, v] of Object.entries(spreadShape.properties)) {
          properties[k] = v;
        }
        // Carry nested unresolvable spreads upward — if `user` had its own
        // unresolved spreads, they still contribute unknown fields to us.
        if (spreadShape.spreads) {
          unresolvedSpreads.push(...spreadShape.spreads);
        }
        continue;
      }
      unresolvedSpreads.push({ sourceText: expr.getText() });
    }

    // Method / accessor members don't fit TypeShape cleanly — records in
    // this IR represent data, not behavior, so skip them.
  }

  return unresolvedSpreads.length > 0
    ? { type: "record", properties, spreads: unresolvedSpreads }
    : { type: "record", properties };
}

function propertyName(
  prop: import("ts-morph").PropertyAssignment,
): string | null {
  const nameNode = prop.getNameNode();
  if (
    Node.isIdentifier(nameNode) ||
    Node.isStringLiteral(nameNode) ||
    Node.isNoSubstitutionTemplateLiteral(nameNode) ||
    Node.isNumericLiteral(nameNode)
  ) {
    return nameNode.getText().replace(/^["']|["']$/g, "");
  }
  // Computed property name — skip, we can't emit a stable string for it.
  return null;
}

/**
 * Collapse a list of shapes to a single TypeShape: dedupe by structural
 * equality, return the single remaining shape if there's one, otherwise
 * a union.
 */
function collapseVariants(shapes: TypeShape[]): TypeShape {
  const deduped: TypeShape[] = [];
  const seen = new Set<string>();
  for (const shape of shapes) {
    const key = JSON.stringify(shape);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(shape);
  }
  if (deduped.length === 0) {
    return { type: "unknown" };
  }
  if (deduped.length === 1) {
    return deduped[0];
  }
  return { type: "union", variants: deduped };
}
