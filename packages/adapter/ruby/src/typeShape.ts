// typeShape.ts: read a type expression from a class DSL as a declared
// shape.
//
// A DSL call's type argument is a literal constant (a scalar name the
// pack declares, or a project class), a one-element array literal
// wrapping one (the library's list type), or, when a project writes it
// as a lambda or a method call instead, an expression this module does
// not read. That last shape is the one the language-adapters proposal
// calls out for Ruby: a field whose type is anything other than a
// literal abstains rather than guessing, the same convention the
// Python adapter's annotation reader follows for a shape it doesn't
// recognize.
//
// Which names count as scalars, which module prefixes may qualify
// them, and how a class name derives its GraphQL type name are all
// pack data (see pack.ts), carried here in a `TypeReadContext` so a
// shape read from Ruby compares against one read from SDL without a
// vocabulary mismatch.

import {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  shadowingClassFor,
} from "./scope.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";
import type { GraphqlTypeNameConvention } from "./scope.js";

/** Everything a type expression needs to resolve: the lexical scope it sits in, and the pack's own scalar and naming vocabulary. */
export interface TypeReadContext {
  /** The `Module.nesting` chain in effect, innermost first. */
  nesting: readonly string[];
  /** Every class the surrounding file defines, by qualified name, for shadow detection. */
  knownClasses: ReadonlySet<string>;
  /** The pack's scalar table: type name to shape. */
  scalars: Readonly<Record<string, TypeShape>>;
  /** Module prefixes the pack's scalars are also reachable under. */
  scalarNamePrefixes: readonly string[];
  /** The pack's selected GraphQL type-name derivation. */
  typeNameConvention: GraphqlTypeNameConvention;
}

/**
 * A scalar can be written bare or under one of the pack's module
 * prefixes. Strip a matching prefix before the scalar lookup; a name
 * under no prefix keeps its full qualified spelling for the ref
 * fallback.
 */
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
 * Convert a type expression node into a `TypeShape`. Null for anything
 * that is not a literal constant path or a one-element array of one: a
 * method call, a lambda, a variable. Callers treat null as "this field
 * abstains" rather than falling back to `unknown`, so a computed type
 * expression produces no declared contract at all instead of a
 * confident-looking empty one.
 *
 * A bare `constant` is checked against `ctx.nesting` first, because a
 * project class sitting at some level of `Module.nesting` is exactly
 * what Ruby itself would resolve before it ever reaches a scalar
 * inherited from a base class. Only once nesting resolves nothing is
 * the bare name tried against the pack's scalar table. A compound
 * `scope_resolution` path is already absolute and can't be shadowed by
 * nesting, so it goes straight to the (possibly module-prefixed)
 * scalar lookup.
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
