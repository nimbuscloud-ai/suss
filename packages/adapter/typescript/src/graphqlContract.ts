// graphqlContract.ts — derive a declared-contract object for a single
// resolver field from an SDL string. Mirrors what
// @suss/contract-graphql does at the SDL-source level, but used by the
// adapter when an Apollo / yoga / graphql-tools pack supplies the SDL
// inline alongside the discovered resolver (resolverInfo.schemaSdl).
//
// Stamped onto the assembled summary as
// `metadata.graphql.declaredContract` so the checker's
// checkGraphqlContractAgreement pass can pair this server-side
// derivation against any other source declaring a contract for the
// same boundary (for example, an SDL-based @suss/contract-graphql
// run).
//
// The parser is graphql-js — same library @suss/contract-graphql uses.
// Failures are silent (return null) so a malformed schema doesn't
// crash extraction; the SDL stays attached at metadata.graphql.schemaSdl
// for inspection / fallback.

import {
  type DocumentNode,
  type FieldDefinitionNode,
  Kind,
  type NamedTypeNode,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  parse,
  type TypeNode,
} from "graphql";

import type { TypeShape } from "@suss/behavioral-ir";

export interface GraphqlContractData {
  returnType: TypeShape;
  args: Array<{ name: string; type: TypeShape; required: boolean }>;
  /** Always "derived" for adapter-emitted contracts — the SDL field
   *  declaration is what drives both the contract and the resolver's
   *  declared identity, so self-comparison would be tautological. */
  provenance: "derived";
  /** Tag the producing pack so cross-source agreement findings can
   *  point at where the contract came from. */
  framework: string;
}

// SDL parsing is hot when many resolvers share the same SDL (a typical
// Apollo Server config). Cache the parsed document by SDL text.
const parseCache = new Map<string, DocumentNode | null>();

function parseSchema(sdl: string): DocumentNode | null {
  const cached = parseCache.get(sdl);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const doc = parse(sdl);
    parseCache.set(sdl, doc);
    return doc;
  } catch (_err) {
    parseCache.set(sdl, null);
    return null;
  }
}

export function deriveGraphqlContract(
  sdl: string,
  typeName: string,
  fieldName: string,
  framework: string,
): GraphqlContractData | null {
  const doc = parseSchema(sdl);
  if (doc === null) {
    return null;
  }
  const field = findField(doc, typeName, fieldName);
  if (field === null) {
    return null;
  }
  return {
    returnType: typeNodeToShape(field.type),
    args: (field.arguments ?? []).map((arg) => ({
      name: arg.name.value,
      type: typeNodeToShape(arg.type),
      required: arg.type.kind === Kind.NON_NULL_TYPE,
    })),
    provenance: "derived",
    framework,
  };
}

function findField(
  doc: DocumentNode,
  typeName: string,
  fieldName: string,
): FieldDefinitionNode | null {
  for (const def of doc.definitions) {
    if (
      def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      def.kind !== Kind.OBJECT_TYPE_EXTENSION
    ) {
      continue;
    }
    const node = def as ObjectTypeDefinitionNode | ObjectTypeExtensionNode;
    if (node.name.value !== typeName) {
      continue;
    }
    for (const field of node.fields ?? []) {
      if (field.name.value === fieldName) {
        return field;
      }
    }
  }
  return null;
}

function typeNodeToShape(node: TypeNode): TypeShape {
  if (node.kind === Kind.NON_NULL_TYPE) {
    return typeNodeToShape(node.type);
  }
  if (node.kind === Kind.LIST_TYPE) {
    return { type: "array", items: typeNodeToShape(node.type) };
  }
  return scalarOrRef(node);
}

function scalarOrRef(node: NamedTypeNode): TypeShape {
  const name = node.name.value;
  switch (name) {
    case "String":
    case "ID":
      return { type: "text" };
    case "Int":
    case "Float":
      return { type: "number" };
    case "Boolean":
      return { type: "boolean" };
    default:
      return { type: "ref", name };
  }
}
