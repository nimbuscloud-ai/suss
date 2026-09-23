/**
 * What a declared type says a value can be, for a read nothing in the
 * source writes a value for. A parameter typed `"INSERT" | "UPDATE"`, a
 * field typed with a string enum, and either one through a type alias
 * in another file all come back as the set of literals the type allows.
 * The checker has already followed the alias and the enum, so nothing
 * here walks a declaration.
 *
 * Any other type gives null. That includes a union with one member
 * that is not a string literal, such as an optional field that may be
 * `undefined`, since the value there can be something outside the set.
 */

import { SET_CAP, string, textPiece, type Value } from "@suss/values";

import type { Node, Type } from "ts-morph";

/** The literals a node's type allows, as a value, or null. */
export function declaredValueOf(node: Node): Value | null {
  const literals = stringLiteralsOf(node.getType());
  // Past the cap the set would turn into a hole named "value", and
  // null leaves the hole named after the read instead.
  if (literals === null || literals.length > SET_CAP) {
    return null;
  }
  return string([textPiece(literals)]);
}

function stringLiteralsOf(type: Type): string[] | null {
  const members = type.isUnion() ? type.getUnionTypes() : [type];
  const literals: string[] = [];
  for (const member of members) {
    const literal = member.isStringLiteral() ? member.getLiteralValue() : null;
    if (typeof literal !== "string") {
      return null;
    }
    literals.push(literal);
  }
  return literals;
}
