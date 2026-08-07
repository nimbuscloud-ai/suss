// typeShape.ts: read a graphql-ruby type expression as a declared
// shape.
//
// A `field`/`argument`/`type` call's type argument is a literal
// constant (`String`, `Types::CampaignType`), a one-element array
// literal wrapping one (`[Types::CampaignType]`, graphql-ruby's list
// type), or, when a project writes it as a lambda or a method call
// instead, an expression this module does not read. That last shape is
// the one the language-adapters proposal calls out for Ruby: a field
// whose type is anything other than a literal abstains rather than
// guessing, the same convention the Python adapter's annotation reader
// follows for a shape it doesn't recognize.
//
// Scalar names mirror @suss/contract-graphql's own SDL scalar mapping
// (String/ID -> text, Int/Float -> number, Boolean -> boolean) so a
// contract read here compares against one read from SDL without a
// vocabulary mismatch.

import {
  graphqlTypeNameFromQualified,
  qualifyConstantRef,
  shadowingClassFor,
} from "./scope.js";

import type { TypeShape } from "@suss/behavioral-ir";
import type { RbNode } from "./parser.js";

const BUILTIN_SCALARS: Record<string, TypeShape> = {
  String: { type: "text" },
  ID: { type: "text" },
  Int: { type: "number" },
  Float: { type: "number" },
  Boolean: { type: "boolean" },
  // Native Ruby classes graphql-ruby accepts as a convenience synonym
  // for its own Int/Float scalars (`field :age, Integer, null: true`),
  // coerced internally the same way `String` is.
  Integer: { type: "number" },
};

const GRAPHQL_TYPES_PREFIX = "GraphQL::Types::";

/**
 * graphql-ruby's built-in scalars are reachable either bare (`String`)
 * or module-pathed (`GraphQL::Types::String`), the "including
 * module-pathed ones" case the language-adapters proposal names. Strip
 * the module path before the scalar lookup; anything else keeps its
 * full qualified name for the ref fallback.
 */
function scalarLookupName(qualifiedName: string): string {
  return qualifiedName.startsWith(GRAPHQL_TYPES_PREFIX)
    ? qualifiedName.slice(GRAPHQL_TYPES_PREFIX.length)
    : qualifiedName;
}

/**
 * Convert a type expression node into a `TypeShape`. Null for anything
 * that is not a literal constant path or a one-element array of one: a
 * method call, a lambda, a variable. Callers treat null as "this field
 * abstains" rather than falling back to `unknown`, so a computed type
 * expression produces no declared contract at all instead of a
 * confident-looking empty one.
 *
 * `knownClasses` is every class this file itself defines, by qualified
 * name (see scope.ts's `walkClasses`): a bare `constant` is checked
 * against `nesting` first, because a project class sitting at some
 * level of `Module.nesting` is exactly what Ruby itself would resolve
 * before it ever reaches a scalar inherited from a base class. Only
 * once nesting resolves nothing is the bare name tried against the
 * scalar table. A compound `scope_resolution` path is already
 * absolute and can't be shadowed by nesting, so it goes straight to
 * the (possibly module-pathed) scalar lookup.
 */
export function typeShapeFromNode(
  node: RbNode,
  nesting: readonly string[],
  knownClasses: ReadonlySet<string>,
): TypeShape | null {
  if (node.type === "array") {
    const inner = node.namedChild(0);
    if (inner === null) {
      return null;
    }
    const items = typeShapeFromNode(inner, nesting, knownClasses);
    return items === null ? null : { type: "array", items };
  }

  if (node.type === "constant") {
    const shadow = shadowingClassFor(node, nesting, knownClasses);
    if (shadow !== null) {
      return { type: "ref", name: graphqlTypeNameFromQualified(shadow) };
    }
    const bareScalar = BUILTIN_SCALARS[node.text];
    if (bareScalar !== undefined) {
      return bareScalar;
    }
    const qualified = qualifyConstantRef(node, nesting);
    return qualified === null
      ? null
      : { type: "ref", name: graphqlTypeNameFromQualified(qualified) };
  }

  if (node.type === "scope_resolution") {
    const qualified = node.text;
    const scalar = BUILTIN_SCALARS[scalarLookupName(qualified)];
    if (scalar !== undefined) {
      return scalar;
    }
    return { type: "ref", name: graphqlTypeNameFromQualified(qualified) };
  }

  return null;
}
