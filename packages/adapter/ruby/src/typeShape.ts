/**
 * Turns a Ruby DSL call's type argument into an IR type shape.
 *
 * The argument is only read when it is a literal constant, or a one-element
 * array wrapping one. A type written as a lambda or a method call abstains
 * rather than guessing at what it evaluates to.
 */

import {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  shadowingClassFor,
} from "./scope.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";
import type { GraphqlTypeNameConvention } from "./scope.js";

export interface TypeReadContext {
  /** The `Module.nesting` chain in effect, innermost first. */
  nesting: readonly string[];
  /** Every class the surrounding file defines, by qualified name, so we can tell when one shadows a scalar. */
  knownClasses: ReadonlySet<string>;
  scalars: Readonly<Record<string, TypeShape>>;
  scalarNamePrefixes: readonly string[];
  typeNameConvention: GraphqlTypeNameConvention;
}

/** A name that matches no prefix keeps its full qualified spelling, which is what the ref fallback needs. */
function scalarLookupName(
  qualifiedName: string,
  prefixes: readonly string[],
): string {
  for (const prefix of prefixes) {
    if (qualifiedName.startsWith(prefix)) {
      return qualifiedName.slice(prefix.length);
    }
  }
  return qualifiedName;
}

/**
 * Null means the field abstains. Callers must not fall back to `unknown`, which
 * would read as a contract nobody actually declared.
 *
 * A bare `constant` is checked against `ctx.nesting` before the scalar table,
 * because a project class at some level of `Module.nesting` is what Ruby itself
 * finds first. A compound `scope_resolution` path is absolute and cannot be
 * shadowed, so it skips that check.
 */
export function typeShapeFromNode(
  node: RbNode,
  ctx: TypeReadContext,
): TypeShape | null {
  if (node.type === "array") {
    const inner = node.namedChild(0);
    if (inner === null) {
      return null;
    }
    const items = typeShapeFromNode(inner, ctx);
    return items === null ? null : { type: "array", items };
  }

  if (node.type === "constant") {
    const shadow = shadowingClassFor(node, ctx.nesting, ctx.knownClasses);
    if (shadow !== null) {
      return {
        type: "ref",
        name: graphqlTypeNameFromQualified(shadow, ctx.typeNameConvention),
      };
    }
    const bareScalar = ctx.scalars[node.text];
    if (bareScalar !== undefined) {
      return bareScalar;
    }
    const qualified = qualifyConstantRef(node, ctx.nesting);
    return qualified === null
      ? null
      : {
          type: "ref",
          name: graphqlTypeNameFromQualified(qualified, ctx.typeNameConvention),
        };
  }

  if (node.type === "scope_resolution") {
    const qualified = node.text;
    const scalar =
      ctx.scalars[scalarLookupName(qualified, ctx.scalarNamePrefixes)];
    if (scalar !== undefined) {
      return scalar;
    }
    return {
      type: "ref",
      name: graphqlTypeNameFromQualified(qualified, ctx.typeNameConvention),
    };
  }

  return null;
}
