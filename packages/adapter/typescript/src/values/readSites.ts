/**
 * Where a program reads a key off a value: `v.n`, `v["n"]` and the
 * elements of `const { n } = v`, written on the value itself or on a
 * reference to the one name it is kept in. A consumer that decodes a
 * message and keeps it in `order` reads its fields as `order.id`, so the
 * fields it reads are the keys at these sites.
 *
 * The facts state a read only when something asks about it, so a caller
 * states each site this gives and reads the key off its row.
 */

import { Node, SyntaxKind } from "ts-morph";

import { isWrittenAgain } from "../facts/assignments.js";
import { referencedSymbol } from "../facts/extract.js";
import { declaringFunctionOf } from "../facts/localUses.js";
import { climbValue } from "../walk/unwrap.js";

/**
 * The read sites on the value, and on each reference to a name it
 * initializes when nothing writes the name again. A read that is a call's
 * callee, or the target of an assignment, doesn't read a key:
 * `order.toString()` calls a method, and `order.seen = true` writes one.
 */
export function readSitesOf(value: Node): Node[] {
  const written = climbValue(value);
  return [
    ...readsWrittenOn(written),
    ...referencesKeeping(written).flatMap((reference) =>
      readsWrittenOn(climbValue(reference)),
    ),
  ];
}

/** The reads written directly on the value, or on a pattern it initializes. */
function readsWrittenOn(value: Node): Node[] {
  const parent = value.getParent();
  if (
    (Node.isPropertyAccessExpression(parent) ||
      Node.isElementAccessExpression(parent)) &&
    parent.getExpression() === value
  ) {
    return isCallee(parent) || isAssigned(parent) ? [] : [parent];
  }
  if (!Node.isVariableDeclaration(parent)) {
    return [];
  }
  const pattern = parent.getNameNode();
  if (!Node.isObjectBindingPattern(pattern)) {
    return [];
  }
  return pattern.getElements().filter((element) => {
    const property = element.getPropertyNameNode() ?? element.getNameNode();
    return (
      element.getDotDotDotToken() === undefined &&
      (Node.isIdentifier(property) || Node.isStringLiteral(property))
    );
  });
}

/**
 * Every reference to the name the value initializes, inside the function
 * that declares it. A name written again, or one declared outside every
 * function, doesn't keep one value.
 */
function referencesKeeping(value: Node): Node[] {
  const declaration = value.getParent();
  if (
    !Node.isVariableDeclaration(declaration) ||
    declaration.getInitializer() !== value
  ) {
    return [];
  }
  const name = declaration.getNameNode();
  const body = declaringFunctionOf(declaration);
  const symbol = referencedSymbol(name);
  if (
    !Node.isIdentifier(name) ||
    body === null ||
    symbol === undefined ||
    isWrittenAgain(declaration)
  ) {
    return [];
  }
  return body
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (node) =>
        node !== name &&
        node.getText() === name.getText() &&
        referencedSymbol(node) === symbol,
    );
}

function isCallee(read: Node): boolean {
  const written = climbValue(read);
  const call = written.getParent();
  return (
    (Node.isCallExpression(call) || Node.isNewExpression(call)) &&
    call.getExpression() === written
  );
}

function isAssigned(read: Node): boolean {
  const assignment = read.getParent();
  return (
    Node.isBinaryExpression(assignment) &&
    assignment.getLeft() === read &&
    assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken
  );
}
