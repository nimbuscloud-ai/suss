/**
 * The directive prologue of a module or a function body: the string
 * literals written as statements before anything else, such as
 * `"use server"`. A framework reads one as a mark on the scope it opens,
 * so the facts state each word as `marks(scope, word)`.
 */

import { Node } from "ts-morph";

/** The words of the prologue, in the order written. The first statement that is not a string literal ends it. */
export function directivesOf(statements: readonly Node[]): string[] {
  const words: string[] = [];
  for (const statement of statements) {
    if (!Node.isExpressionStatement(statement)) {
      break;
    }
    const expression = statement.getExpression();
    if (!Node.isStringLiteral(expression)) {
      break;
    }
    words.push(expression.getLiteralValue());
  }
  return words;
}

/**
 * The tag a JSX element renders, or null for a fragment, which has none.
 * A component's name is written there, so a reader follows it to the
 * function.
 */
export function jsxTagOf(element: Node): Node | null {
  if (Node.isJsxElement(element)) {
    return element.getOpeningElement().getTagNameNode();
  }
  return Node.isJsxSelfClosingElement(element)
    ? element.getTagNameNode()
    : null;
}
