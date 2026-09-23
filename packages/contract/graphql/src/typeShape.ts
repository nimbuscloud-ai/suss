// Converts GraphQL type references to TypeShapes. The schema reader uses
// it for field arguments and return types, and the documents reader for
// operation variables.

import {
  type DocumentNode,
  parse as graphqlParse,
  Kind,
  type NamedTypeNode,
  type TypeNode,
} from "graphql";

import type { TypeShape } from "@suss/behavioral-ir";

/**
 * The TypeShape for each of the five standard GraphQL scalars. A pack
 * whose library spells the same scalars its own way can build on this
 * table instead of copying it.
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
    // A TypeShape is non-null unless its union includes null, so the
    // wrapper adds nothing.
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
 * A record shape for every object, interface and input type the document
 * defines, keyed by type name. An `extend type` adds its fields to the
 * same record.
 *
 * A field's return type is only a name, which gives nothing to compare
 * with what a resolver in code returns. The summary stores these records
 * under `definitions`, and loading the summary substitutes them back into
 * the shapes that refer to them by name.
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

/** Definition kinds that only appear in a schema. */
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

/** True when the document declares a type, which makes it a schema. */
export function describesTypes(text: string): boolean {
  return definitionKinds(text).some((kind) => SCHEMA_KINDS.has(kind));
}

/** True when the document has at least one operation. A file of fragments has none. */
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
