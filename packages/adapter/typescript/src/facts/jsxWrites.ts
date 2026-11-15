/**
 * The JSX a function or a file writes, stated as facts when a reader asks
 * about it: every element under it, the attributes and spreads each one
 * writes, what reaches it as children, and the element written with
 * children that encloses it. No rule reads these rows. The body walk
 * states the tag and attributes of each element a function renders,
 * through the same producer this uses, so they get one key. The spreads,
 * the children, the enclosing element and `writesElement` would put a row
 * in the store for every element of every React file, so the body walk
 * leaves them out and they exist only for what some reader asked about.
 */

import { Node } from "ts-morph";

import { emitElementRows, nodeId } from "./extract.js";

import type { Database } from "@suss/datalog";
import type { JsxChild, JsxElement, JsxSelfClosingElement } from "ts-morph";
import type { NodeTable } from "./extract.js";

/**
 * Every element written under the function or the file, in source order:
 * in its own body, in a function written inside it, or in an attribute's
 * value. Each gets its `writesElement` row and the rows that describe it.
 */
export function stateElementsWritten(
  db: Database,
  table: NodeTable,
  root: Node,
): string[] {
  const rootId = writerKeyOf(table, root);
  const elements: string[] = [];
  root.forEachDescendant((node) => {
    if (!Node.isJsxElement(node) && !Node.isJsxSelfClosingElement(node)) {
      return;
    }
    const id = keyOf(table, node);
    db.add("writesElement", [rootId, id]);
    stateElement(db, table, node, id);
    elements.push(id);
  });
  return elements;
}

/** A file is keyed by its path, as `marks` and `exportsAs` key it, and a function by its node. */
function writerKeyOf(table: NodeTable, root: Node): string {
  return Node.isSourceFile(root) ? root.getFilePath() : keyOf(table, root);
}

function stateElement(
  db: Database,
  table: NodeTable,
  element: JsxElement | JsxSelfClosingElement,
  id: string,
): void {
  emitElementRows(db, table, element, id);
  const parent = element.getFirstAncestor(Node.isJsxElement);
  if (parent !== undefined) {
    db.add("jsxParent", [id, keyOf(table, parent)]);
  }
  const opening = Node.isJsxElement(element)
    ? element.getOpeningElement()
    : element;
  for (const attribute of opening.getAttributes()) {
    if (Node.isJsxSpreadAttribute(attribute)) {
      db.add("jsxSpread", [id, keyOf(table, attribute.getExpression())]);
    }
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
