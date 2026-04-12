// shapes.ts — Extract structured TypeShape from expression nodes

import { Node, type ObjectLiteralExpression, SyntaxKind } from "ts-morph";

import type { TypeShape } from "@suss/behavioral-ir";

/**
 * Attempt to decompose `node` into a structured `TypeShape`. Returns `null`
 * when the expression isn't a recognized literal, object literal, or array
 * literal — callers should fall back to a source-text ref shape in that case.
 *
 * Object-literal property values that can't themselves be decomposed become
 * `{ type: "ref", name: "<source text>" }` so field enumeration still works
 * even when individual values are opaque (e.g. computed expressions).
 */
export function extractShape(node: Node): TypeShape | null {
  if (Node.isAsExpression(node)) {
    return extractShape(node.getExpression());
  }

  if (Node.isParenthesizedExpression(node)) {
    return extractShape(node.getExpression());
  }

  if (Node.isObjectLiteralExpression(node)) {
    return shapeFromObjectLiteral(node);
  }

  if (Node.isArrayLiteralExpression(node)) {
    const elements = node.getElements();
    if (elements.length === 0) {
      return { type: "array", items: { type: "unknown" } };
    }
    const first = extractShape(elements[0]);
    return {
      type: "array",
      items: first ?? { type: "ref", name: elements[0].getText() },
    };
  }

  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return { type: "text" };
  }

  if (Node.isNumericLiteral(node)) {
    const v = node.getLiteralValue();
    return Number.isInteger(v) ? { type: "integer" } : { type: "number" };
  }

  const kind = node.getKind();
  if (kind === SyntaxKind.TrueKeyword || kind === SyntaxKind.FalseKeyword) {
    return { type: "boolean" };
  }
  if (kind === SyntaxKind.NullKeyword) {
    return { type: "null" };
  }

  return null;
}

function shapeFromObjectLiteral(obj: ObjectLiteralExpression): TypeShape {
  const properties: Record<string, TypeShape> = {};
  const spreads: Array<{ sourceText: string }> = [];

  for (const prop of obj.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getName();
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
      properties[name] = { type: "ref", name };
      continue;
    }

    if (Node.isSpreadAssignment(prop)) {
      spreads.push({ sourceText: prop.getExpression().getText() });
    }

    // Method / accessor members don't fit TypeShape cleanly — skip them for
    // now; the checker only reasons about data-shaped records.
  }

  return spreads.length > 0
    ? { type: "record", properties, spreads }
    : { type: "record", properties };
}
