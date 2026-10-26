// Converts GraphQL type references to TypeShapes. The schema reader uses
// it for field arguments and return types, and the documents reader for
// operation variables.

import {
  type DocumentNode,
  type EnumTypeDefinitionNode,
  type EnumTypeExtensionNode,
  parse as graphqlParse,
  Kind,
  type NamedTypeNode,
  type ScalarTypeDefinitionNode,
  type ScalarTypeExtensionNode,
  type TypeNode,
  type UnionTypeDefinitionNode,
  type UnionTypeExtensionNode,
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

/** A type a schema declares that has no fields: an enum, a union or a custom scalar. */
export interface DeclaredValueType {
  name: string;
  kind: "enum" | "union" | "scalar";
  /** An enum's values or a union's member types, in the order written, extensions included. */
  members: string[];
}

type ValueTypeNode =
  | EnumTypeDefinitionNode
  | EnumTypeExtensionNode
  | UnionTypeDefinitionNode
  | UnionTypeExtensionNode
  | ScalarTypeDefinitionNode
  | ScalarTypeExtensionNode;

const VALUE_TYPE_READERS: Partial<
  Record<
    string,
    (node: ValueTypeNode) => Pick<DeclaredValueType, "kind" | "members">
  >
> = {
  [Kind.ENUM_TYPE_DEFINITION]: enumOf,
  [Kind.ENUM_TYPE_EXTENSION]: enumOf,
  [Kind.UNION_TYPE_DEFINITION]: unionOf,
  [Kind.UNION_TYPE_EXTENSION]: unionOf,
  [Kind.SCALAR_TYPE_DEFINITION]: () => ({ kind: "scalar", members: [] }),
  [Kind.SCALAR_TYPE_EXTENSION]: () => ({ kind: "scalar", members: [] }),
};

// The table picks each reader by the node's kind, so the casts are safe.
function enumOf(
  node: ValueTypeNode,
): Pick<DeclaredValueType, "kind" | "members"> {
  const values = (node as EnumTypeDefinitionNode).values ?? [];
  return { kind: "enum", members: values.map((value) => value.name.value) };
}

function unionOf(
  node: ValueTypeNode,
): Pick<DeclaredValueType, "kind" | "members"> {
  const types = (node as UnionTypeDefinitionNode).types ?? [];
  return { kind: "union", members: types.map((type) => type.name.value) };
}

/**
 * The enums, unions and custom scalars a schema declares. They have no
 * fields, so they are not in `typeDefinitionsIn`, but a page that links
 * each type name a field returns needs them. Empty when the SDL does not
 * parse.
 */
export function declaredValueTypes(sdl: string): DeclaredValueType[] {
  let doc: DocumentNode;
  try {
    doc = graphqlParse(sdl);
  } catch {
    return [];
  }
  const found = new Map<string, DeclaredValueType>();
  for (const node of doc.definitions) {
    const read = VALUE_TYPE_READERS[node.kind];
    if (read === undefined) {
      continue;
    }
    const valueNode = node as ValueTypeNode;
    const { kind, members } = read(valueNode);
    const name = valueNode.name.value;
    const known = found.get(name);
    found.set(name, {
      name,
      kind,
      members: [...(known?.members ?? []), ...members],
    });
  }
  return [...found.values()];
}
