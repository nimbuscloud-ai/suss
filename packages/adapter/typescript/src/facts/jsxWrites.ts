/**
 * The JSX a function writes, stated as facts when a reader asks about
 * that function: every element under it, the attributes and spreads each
 * one writes, and what reaches it as children. No rule reads these rows,
 * and stating them in every body walk would put a row in the store for
 * every attribute of every React file, so the body walk leaves them out
 * and a row exists only for a function some reader asked about.
 */

import { Node } from "ts-morph";

import { jsxTagOf } from "./directives.js";
import { nodeId } from "./extract.js";

import type { Database } from "@suss/datalog";
import type {
  JsxAttribute,
  JsxChild,
  JsxElement,
  JsxSelfClosingElement,
} from "ts-morph";
import type { NodeTable } from "./extract.js";

/**
 * Every element written under the function, in source order: in its own
 * body, in a function written inside it, or in an attribute's value.
 * Each gets its `writesElement` row and the rows that describe it.
 */
export function stateElementsWritten(
  db: Database,
  table: NodeTable,
  func: Node,
): string[] {
  const funcId = keyOf(table, func);
  const elements: string[] = [];
  func.forEachDescendant((node) => {
    if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) {
      return;
    }
    const id = keyOf(table, node);
    db.add("writesElement", [funcId, id]);
    stateElement(db, table, node, id);
    elements.push(id);
  });
  return elements;
}

function stateElement(
  db: Database,
  table: NodeTable,
  element: JsxElement | JsxSelfClosingElement,
  id: string,
): void {
  const tag = jsxTagOf(element);
  if (tag !== null) {
    db.add("jsxElement", [id, keyOf(table, tag)]);
  }
  const opening = Node.isJsxElement(element)
    ? element.getOpeningElement()
    : element;
  for (const attribute of opening.getAttributes()) {
    if (Node.isJsxAttribute(attribute)) {
      db.add("jsxAttribute", [
        id,
        attribute.getNameNode().getText(),
        keyOf(table, attributeValue(attribute)),
      ]);
      continue;
    }
    db.add("jsxSpread", [id, keyOf(table, attribute.getExpression())]);
  }
  if (!Node.isJsxElement(element)) {
    return;
  }
  element.getJsxChildren().forEach((child, position) => {
    if (reachesAsChild(child)) {
      db.add("jsxChild", [id, String(position), keyOf(table, child)]);
    }
  });
}

/** An attribute written with no value, `<Chip open />`, is set by being there, so it is its own value. */
function attributeValue(attribute: JsxAttribute): Node {
  const initializer = attribute.getInitializer();
  if (initializer === undefined) {
    return attribute;
  }
  return Node.isJsxExpression(initializer)
    ? (initializer.getExpression() ?? attribute)
    : initializer;
}

/** React passes nothing for whitespace between the tags, or for an expression with nothing in it, such as a comment. */
function reachesAsChild(child: JsxChild): boolean {
  if (Node.isJsxText(child)) {
    return !child.containsOnlyTriviaWhiteSpaces();
  }
  return !Node.isJsxExpression(child) || child.getExpression() !== undefined;
}

function keyOf(table: NodeTable, node: Node): string {
  const id = nodeId(node);
  table.byId.set(id, node);
  return id;
}
