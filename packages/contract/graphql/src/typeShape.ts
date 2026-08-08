// SDL / operation TypeNode → TypeShape conversion, shared by the
// schema reader (field arguments, return types) and the documents
// reader (operation variable definitions).

import { Kind, type NamedTypeNode, type TypeNode } from "graphql";

import type { TypeShape } from "@suss/behavioral-ir";

/**
 * The five standard GraphQL scalars, mapped to the shapes they read
 * as. Exported so packs whose library exposes the same scalars under
 * its own spelling can build on this table instead of restating it.
 */
export const SCALAR_SHAPES: Record<string, TypeShape> = {
  String: { type: "text" },
  ID: { type: "text" },
  Int: { type: "number" },
  Float: { type: "number" },
  Boolean: { type: "boolean" },
};

export function typeNodeToShape(node: TypeNode): TypeShape {
  if (node.kind === Kind.NON_NULL_TYPE) {
    // Non-null is enforced by GraphQL, so drop the wrapper:
    // TypeShape's nullability is implicit (non-union with null/undefined).
    return typeNodeToShape(node.type);
  }

  if (node.kind === Kind.LIST_TYPE) {
    return { type: "array", items: typeNodeToShape(node.type) };
  }

  return scalarOrRef(node);
}

function scalarOrRef(node: NamedTypeNode): TypeShape {
  const name = node.name.value;
  return SCALAR_SHAPES[name] ?? { type: "ref", name };
}
