// propertyName.ts: the name a property or member is written under, for every
// reader that matches one by name or records it. ts-morph's `getName()` gives
// the key's source text with its quotes, so no reader uses it.

import { Node } from "ts-morph";

import type {
  FunctionDeclaration,
  MethodDeclaration,
  PropertyAssignment,
  PropertyDeclaration,
} from "ts-morph";

/**
 * The name a property of an object literal is written under, or null
 * for a spread, which has none, and for a computed key.
 */
export function propertyNameOf(property: Node): string | null {
  if (
    Node.isPropertyAssignment(property) ||
    Node.isShorthandPropertyAssignment(property) ||
    Node.isMethodDeclaration(property)
  ) {
    return keyNameOf(property.getNameNode());
  }
  return null;
}

/**
 * What a member is called where its name is recorded or shown. A
 * literal key gives its value, as `propertyNameOf` does. A computed
 * key has no value to read, so it keeps the text written in the
 * brackets, which is the name there is to show for it.
 */
export function memberNameOf(
  member: MethodDeclaration | PropertyAssignment | PropertyDeclaration,
): string {
  const name = member.getNameNode();
  return keyNameOf(name) ?? name.getText();
}

/**
 * What a function declaration is called: a method by `memberNameOf`,
 * a function declaration by its identifier, which an anonymous default
 * export does not have.
 */
export function functionNameOf(
  func: FunctionDeclaration | MethodDeclaration,
): string | undefined {
  return Node.isMethodDeclaration(func) ? memberNameOf(func) : func.getName();
}

/**
 * `{ "fetch"() {} }` and `{ fetch() {} }` define the same property, so
 * a quoted key gives the string inside the quotes. A computed key
 * gives null, which is what a caller matching a name can do with it.
 */
function keyNameOf(name: Node): string | null {
  if (Node.isIdentifier(name) || Node.isPrivateIdentifier(name)) {
    return name.getText();
  }
  if (
    Node.isStringLiteral(name) ||
    Node.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.getLiteralValue();
  }
  return Node.isNumericLiteral(name) ? String(name.getLiteralValue()) : null;
}
