/**
 * The writes a program makes into a table or a map it declares, read
 * when a call takes its function out of one.
 *
 * Extraction here is lazy, and a write is in some other body, such as a
 * `register(name, handler)` function or a statement at the top of the
 * file, so nothing on the way to the read states it. This walks the scope
 * that declares the container, finds each write through a name for it,
 * and states it as `holdsUnderKey`, since the key in `table[name] = fn`
 * or `map.set(name, fn)` is one the program computes. A write from
 * another file is not read.
 */

import { Node, SyntaxKind } from "ts-morph";

import { emitValue, referencedSymbol } from "./extract.js";
import { MAP_ENTRY_WRITE } from "./languageWords.js";
import { declaringFunctionOf } from "./localUses.js";

import type { Database } from "@suss/datalog";
import type { Expression, VariableDeclaration } from "ts-morph";
import type { NodeTable } from "./extract.js";

/**
 * States every write into the container a name refers to, and returns
 * the declaration whose scope was read, or null when the name is not a
 * variable this run can see the scope of.
 */
export function emitContainerWrites(
  db: Database,
  table: NodeTable,
  container: Node,
): VariableDeclaration | null {
  const declaration = variableBehind(container);
  if (declaration === null) {
    return null;
  }
  const nameNode = declaration.getNameNode();
  const symbol = referencedSymbol(nameNode);
  const name = declaration.getName();
  const scope = declaringFunctionOf(declaration) ?? declaration.getSourceFile();
  scope.forEachDescendant((node) => {
    if (
      !Node.isIdentifier(node) ||
      node === nameNode ||
      node.getText() !== name ||
      referencedSymbol(node) !== symbol
    ) {
      return;
    }
    const written = valueWrittenThrough(node);
    if (written !== null) {
      db.add("holdsUnderKey", [
        emitValue(db, table, node),
        emitValue(db, table, written),
      ]);
    }
  });
  return declaration;
}

/** The variable a name for a container is declared as, when it is one. */
function variableBehind(container: Node): VariableDeclaration | null {
  if (!Node.isIdentifier(container)) {
    return null;
  }
  const [declaration] = referencedSymbol(container)?.getDeclarations() ?? [];
  return declaration !== undefined &&
    Node.isVariableDeclaration(declaration) &&
    Node.isIdentifier(declaration.getNameNode())
    ? declaration
    : null;
}

/** The value `name[key] = value` or `name.set(key, value)` puts in through this name, or null. */
function valueWrittenThrough(name: Node): Expression | null {
  const parent = name.getParent();
  if (
    Node.isElementAccessExpression(parent) &&
    parent.getExpression() === name
  ) {
    const assignment = parent.getParent();
    return Node.isBinaryExpression(assignment) &&
      assignment.getLeft() === parent &&
      assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      ? assignment.getRight()
      : null;
  }
  if (
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === name &&
    parent.getName() === MAP_ENTRY_WRITE
  ) {
    const call = parent.getParent();
    const value = Node.isCallExpression(call) ? call.getArguments()[1] : null;
    return value !== undefined && value !== null && Node.isExpression(value)
      ? value
      : null;
  }
  return null;
}
