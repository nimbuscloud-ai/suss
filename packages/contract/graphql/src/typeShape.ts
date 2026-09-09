// SDL / operation TypeNode → TypeShape conversion, shared by the
// schema reader (field arguments, return types) and the documents
// reader (operation variable definitions).

import {
  type DocumentNode,
  parse as graphqlParse,
  Kind,
  type NamedTypeNode,
  type TypeNode,
} from "graphql";

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

/**
 * Every named type the document defines, as the shape it stands for.
 *
 * A field's return type is a name, and a name has no structure to
 * compare against what a resolver in code returns. A summary states
 * these under `definitions`, and the reader that loads it puts them
 * back into the shapes that refer to them.
 */
export function typeDefinitionsIn(
  doc: DocumentNode,
): Record<string, TypeShape> {
  const definitions: Record<string, TypeShape> = {};
  for (const node of doc.definitions) {
    if (
      node.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      node.kind !== Kind.OBJECT_TYPE_EXTENSION &&
      node.kind !== Kind.INTERFACE_TYPE_DEFINITION &&
      node.kind !== Kind.INPUT_OBJECT_TYPE_DEFINITION
    ) {
      continue;
    }

    const properties: Record<string, TypeShape> = {
      ...(definitions[node.name.value]?.type === "record"
        ? (
            definitions[node.name.value] as {
              properties: Record<string, TypeShape>;
            }
          ).properties
        : {}),
    };
    for (const field of node.fields ?? []) {
      properties[field.name.value] = typeNodeToShape(field.type);
    }
    definitions[node.name.value] = { type: "record", properties };
  }
  return definitions;
}

/** The definitions a schema is made of, as graphql-js names them. */
const SCHEMA_KINDS: ReadonlySet<string> = new Set([
  Kind.SCHEMA_DEFINITION,
  Kind.SCHEMA_EXTENSION,
  Kind.OBJECT_TYPE_DEFINITION,
  Kind.OBJECT_TYPE_EXTENSION,
  Kind.INTERFACE_TYPE_DEFINITION,
  Kind.INTERFACE_TYPE_EXTENSION,
  Kind.INPUT_OBJECT_TYPE_DEFINITION,
  Kind.INPUT_OBJECT_TYPE_EXTENSION,
  Kind.ENUM_TYPE_DEFINITION,
  Kind.ENUM_TYPE_EXTENSION,
  Kind.UNION_TYPE_DEFINITION,
  Kind.UNION_TYPE_EXTENSION,
  Kind.SCALAR_TYPE_DEFINITION,
  Kind.SCALAR_TYPE_EXTENSION,
]);

/** Whether a document declares types. A document that does is a schema. */
export function describesTypes(text: string): boolean {
  return definitionKinds(text).some((kind) => SCHEMA_KINDS.has(kind));
}

/** Whether a document has an operation to read, rather than fragments alone. */
export function describesOperations(text: string): boolean {
  return definitionKinds(text).includes(Kind.OPERATION_DEFINITION);
}

function definitionKinds(text: string): string[] {
  try {
    return graphqlParse(text).definitions.map((definition) => definition.kind);
  } catch {
    return [];
  }
}
