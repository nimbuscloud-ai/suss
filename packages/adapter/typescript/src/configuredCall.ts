import { Node } from "ts-morph";

/**
 * The identifier a property-access chain starts from, so `client.send`
 * and `sqs.client.send` both come back as the name a pack can look up.
 * Null when the chain starts from something else, a call or a literal.
 */
export function rootIdentifier(node: Node): Node | null {
  let current: Node = node;
  while (Node.isPropertyAccessExpression(current)) {
    current = current.getExpression();
  }
  return Node.isIdentifier(current) ? current : null;
}
