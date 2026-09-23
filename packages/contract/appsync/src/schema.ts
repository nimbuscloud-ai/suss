// Parses an API's SDL once and indexes every field by type and field
// name, so each resolver can look up its argument and return types.

import {
  type DocumentNode,
  type FieldDefinitionNode,
  Kind,
  parse,
} from "graphql";

import type { TypeShape } from "@suss/behavioral-ir";

export interface FieldInfo {
  typeName: string;
  fieldName: string;
  returnShape: TypeShape;
  /**
   * Each argument's shape is a `ref` named with the SDL type as written,
   * such as `[ID!]!`.
   */
  args: Array<{ name: string; shape: TypeShape; required: boolean }>;
}

export type SchemaIndex = Map<string, FieldInfo>;

export function schemaKey(typeName: string, fieldName: string): string {
  return `${typeName}.${fieldName}`;
}

/**
 * Indexes every field on every object type and interface, extensions
 * included. SDL that does not parse gives an empty index, so one bad
 * schema does not stop the rest of the template from being read.
 */
export function parseSchema(sdl: string): SchemaIndex {
  const index: SchemaIndex = new Map();
  const doc = safeParse(sdl);
  if (doc === null) {
    return index;
  }

  for (const def of doc.definitions) {
    if (
      def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      def.kind !== Kind.OBJECT_TYPE_EXTENSION &&
      def.kind !== Kind.INTERFACE_TYPE_DEFINITION &&
      // `extend interface` splits an interface the same way `extend type`
      // splits a type.
      def.kind !== Kind.INTERFACE_TYPE_EXTENSION
    ) {
      continue;
    }
    const typeName = def.name.value;
    for (const field of def.fields ?? []) {
      const info = describeField(typeName, field);
      index.set(schemaKey(typeName, info.fieldName), info);
    }
  }

  return index;
}

function safeParse(sdl: string): DocumentNode | null {
  try {
    return parse(sdl);
  } catch {
    return null;
  }
}

function describeField(
  typeName: string,
  field: FieldDefinitionNode,
): FieldInfo {
  return {
    typeName,
    fieldName: field.name.value,
    returnShape: typeReference(sourceOfType(field.type)),
    args: (field.arguments ?? []).map((arg) => ({
      name: arg.name.value,
      shape: typeReference(sourceOfType(arg.type)),
      required: isNonNull(arg.type),
    })),
  };
}

/**
 * Prints a type node as the SDL wrote it, such as `[ID!]!`, so a summary
 * shows the type the way the schema spells it.
 */
function sourceOfType(node: FieldDefinitionNode["type"]): string {
  if (node.kind === Kind.NON_NULL_TYPE) {
    return `${sourceOfType(node.type)}!`;
  }
  if (node.kind === Kind.LIST_TYPE) {
    return `[${sourceOfType(node.type)}]`;
  }
  return node.name.value;
}

function isNonNull(node: FieldDefinitionNode["type"]): boolean {
  return node.kind === Kind.NON_NULL_TYPE;
}

function typeReference(name: string): TypeShape {
  return { type: "ref", name };
}
