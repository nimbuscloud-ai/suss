// propertyName.ts: the name an object literal's property is written under,
// for every reader that matches a property by name.

import { Node } from "ts-morph";

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
