/**
 * What a parameter's annotation says a name can be, for a read of a
 * parameter no call site filled. `kind: Literal["a", "b"]` comes back
 * as the two strings, and so does `kind: Kind` where the facts follow
 * `Kind` to a `Literal[...]` written elsewhere.
 *
 * Only a parameter's annotation is read. A field annotated on a class,
 * read as `event.kind`, and an `Enum` member are not read. They give
 * null here the same as any other annotation.
 */

import { SET_CAP, string, textPiece, type Value } from "@suss/values";

import {
  children,
  enclosingFunction,
  field,
  fields,
  parameterNameAndType,
  stringLiteralValue,
} from "../ast.js";

import type { PyNode } from "../parser.js";

/** How many aliases an annotation is followed through. */
const ALIAS_HOPS = 2;

/** Follows a name to the expression it was written as, or null. */
type WrittenTo = (node: PyNode) => PyNode | null;

/** The literals a parameter's annotation allows, as a value, or null. */
export function declaredValueOf(
  node: PyNode,
  writtenTo: WrittenTo,
): Value | null {
  if (node.type !== "identifier") {
    return null;
  }
  const annotation = parameterAnnotation(node);
  const literals =
    annotation === null ? null : literalStrings(annotation, writtenTo, 0);
  if (literals === null || literals.length > SET_CAP) {
    return null;
  }
  return string([textPiece(literals)]);
}

/** The annotation on the parameter a name reads, from the nearest function that takes one by that name. */
function parameterAnnotation(name: PyNode): PyNode | null {
  let fn = enclosingFunction(name);
  while (fn !== null) {
    const params = field(fn, "parameters");
    for (const param of params === null ? [] : children(params)) {
      const declared = parameterNameAndType(param);
      if (declared?.name === name.text) {
        return declared.typeNode;
      }
    }
    fn = enclosingFunction(fn);
  }
  return null;
}

/**
 * The strings a `Literal[...]` annotation lists. The grammar writes it
 * as a generic type inside an annotation and as a subscript anywhere
 * else, which is where an alias's right side ends up.
 */
function literalStrings(
  written: PyNode,
  writtenTo: WrittenTo,
  hops: number,
): string[] | null {
  const node = written.type === "type" ? children(written)[0] : written;
  if (node === undefined) {
    return null;
  }
  if (node.type === "generic_type") {
    const [name, parameters] = children(node);
    return name !== undefined && isLiteral(name) && parameters !== undefined
      ? stringsIn(children(parameters).map((each) => children(each)[0]))
      : null;
  }
  if (node.type === "subscript") {
    const name = field(node, "value");
    return name !== null && isLiteral(name)
      ? stringsIn(fields(node, "subscript"))
      : null;
  }
  if (hops >= ALIAS_HOPS) {
    return null;
  }
  const alias = writtenTo(node);
  return alias === null ? null : literalStrings(alias, writtenTo, hops + 1);
}

/** `Literal` or `typing.Literal`, written under whatever module name the file imported. */
function isLiteral(name: PyNode): boolean {
  const last = name.type === "attribute" ? field(name, "attribute") : name;
  return last?.type === "identifier" && last.text === "Literal";
}

/** The text of each string, or null when one of them is anything else. */
function stringsIn(nodes: readonly (PyNode | undefined)[]): string[] | null {
  const strings: string[] = [];
  for (const node of nodes) {
    const text = node === undefined ? null : stringLiteralValue(node);
    if (text === null) {
      return null;
    }
    strings.push(text);
  }
  return strings.length === 0 ? null : strings;
}
