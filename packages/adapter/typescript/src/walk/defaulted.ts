/**
 * defaulted.ts: whether a read has something behind it.
 *
 * `??` and `||` are ECMAScript, not anything a pack defines, so the
 * packs that record a read ask here instead of each spelling the
 * operators out. This is a separate file from unwrap.ts because that
 * one is about wrappers, and a fallback is not one.
 */

import { Node } from "ts-morph";

import { climbSyntax } from "./unwrap.js";

/**
 * Whether something else supplies a value when this read comes back
 * empty. `env.X ?? "default"` and `env.X || other` both do, and so does
 * the middle of a chain: in `env.A || env.B || undefined`, B's fallback
 * is the chain's tail. The climb stops when the read is the final
 * operand (`getDefault() ?? env.X`), where the read is itself the
 * fallback and its absence propagates.
 */
export function isDefaultedAt(node: Node): boolean {
  let child = climbSyntax(node);
  let parent = child.getParent();
  while (parent !== undefined) {
    if (!Node.isBinaryExpression(parent)) {
      return false;
    }
    // The token text rather than the SyntaxKind enum, which renumbers
    // between TypeScript releases.
    const operator = parent.getOperatorToken().getText();
    if (operator !== "??" && operator !== "||") {
      return false;
    }
    if (parent.getLeft() === child) {
      return true;
    }
    child = climbSyntax(parent);
    parent = child.getParent();
  }
  return false;
}
