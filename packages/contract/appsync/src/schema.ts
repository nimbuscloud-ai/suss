// schema.ts — SDL parsing for AppSync schema-first resolver info.
//
// AppSync's schema is hand-authored SDL. The stub parses it once per
// API and indexes every (TypeName, FieldName) pair with its argument
// shape and return-type reference. Resolvers then look themselves up
// by (TypeName, FieldName) and pick up the shape declared in SDL.
//
// Uses graphql-js's parser (the same reference impl AppSync itself
// uses) so compatibility is guaranteed — any SDL AppSync accepts, we
// accept.

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
  /** Type shape of this field's return (schema-declared). */
  returnShape: TypeShape;
  /**
   * Input arguments declared on this field. Each arg has a name and a
   * reference-typed TypeShape (the SDL type printed as-is). Consumers
   * that want structural details can re-parse the name later.
   */
  args: Array<{ name: string; shape: TypeShape; required: boolean }>;
}

export type SchemaIndex = Map<string, FieldInfo>;

/** Key format: `${typeName}.${fieldName}`. */
export function schemaKey(typeName: string, fieldName: string): string {
  return `${typeName}.${fieldName}`;
}

/**
 * Parse an SDL string and index every field across Query, Mutation,
 * Subscription, and object-type extensions. Returns an empty index if
 * the SDL fails to parse — matches the stub's broader posture that
 * partial input shouldn't halt extraction.
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
      def.kind !== Kind.INTERFACE_TYPE_DEFINITION
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
 * Reconstruct the source-form of a GraphQL type node. `User!`, `[ID!]!`,
 * `[[Int]]` etc. read the same way as written. Keeps the downstream
 * IR representation aligned with what a human reader would expect
 * when inspecting a summary.
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
