// @suss/contract-graphql — generate resolver-kind behavioral summaries
// from a plain GraphQL SDL file.
//
// Each field on Query / Mutation / Subscription becomes one resolver
// summary with a `graphql-resolver` boundary binding (typeName,
// fieldName), inputs derived from field arguments, and a default
// success transition returning the field's declared return shape.
// A generic throw transition models the GraphQL `errors[]` path.
//
// This is the schema-only counterpart to @suss/contract-appsync (which
// does the same for AppSync resolvers declared in CloudFormation
// templates). Use this when you have a vanilla GraphQL schema and want
// to compare it against server-side resolver implementations.

import fs from "node:fs";

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

import { graphqlResolverBinding } from "@suss/behavioral-ir";

import type {
  BehavioralSummary,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

const ROOT_TYPES = ["Query", "Mutation", "Subscription"] as const;
type RootType = (typeof ROOT_TYPES)[number];

export interface GraphqlContractOptions {
  /**
   * Logical source path recorded on each summary's `location.file`.
   * Defaults to `"graphql"` so summaries are identifiable even when
   * the SDL came from a non-file source (in-memory string).
   */
  source?: string;
  /**
   * Recognition tag for the resolver binding. Defaults to `"graphql"`.
   * Override when the same SDL is used by multiple deployments
   * (`apollo-prod`, `apollo-staging`) and you want findings to
   * distinguish them.
   */
  recognition?: string;
  /**
   * Transport to record on the boundary binding. Defaults to
   * `"http-graphql"` — most GraphQL servers run over HTTPS.
   */
  transport?: string;
}

/**
 * Convert an SDL string into resolver-kind summaries. Used directly
 * when the caller has the SDL in memory; tests and the file-based
 * entry point share this code path.
 */
export function graphqlSdlToSummaries(
  sdl: string,
  options: GraphqlContractOptions = {},
): BehavioralSummary[] {
  let doc: DocumentNode;
  try {
    doc = parse(sdl);
  } catch (_err) {
    return [];
  }

  const source = options.source ?? "graphql";
  const recognition = options.recognition ?? "graphql";
  const transport = options.transport ?? "http-graphql";

  const out: BehavioralSummary[] = [];
  const rootFields = collectRootFields(doc);

  for (const { rootType, field } of rootFields) {
    out.push(
      buildResolverSummary(rootType, field, source, recognition, transport),
    );
  }

  return out;
}

/**
 * Read an SDL file from disk and convert it to summaries. Convenience
 * wrapper for the CLI's `suss contract --from graphql <file>` path.
 */
export function graphqlSdlFileToSummaries(
  filepath: string,
  options: GraphqlContractOptions = {},
): BehavioralSummary[] {
  const sdl = fs.readFileSync(filepath, "utf8");
  return graphqlSdlToSummaries(sdl, {
    source: filepath,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RootField {
  rootType: RootType;
  field: FieldDefinitionNode;
}

function collectRootFields(doc: DocumentNode): RootField[] {
  // SDL allows extending root types via `extend type Query { ... }`.
  // Walk both ObjectTypeDefinition and ObjectTypeExtension to merge.
  const fieldsByRoot = new Map<RootType, FieldDefinitionNode[]>();
  for (const def of doc.definitions) {
    const node =
      def.kind === Kind.OBJECT_TYPE_DEFINITION ||
      def.kind === Kind.OBJECT_TYPE_EXTENSION
        ? (def as ObjectTypeDefinitionNode | ObjectTypeExtensionNode)
        : null;
    if (node === null) {
      continue;
    }
    const name = node.name.value;
    if (!isRootType(name)) {
      continue;
    }
    const existing = fieldsByRoot.get(name) ?? [];
    for (const field of node.fields ?? []) {
      existing.push(field);
    }
    fieldsByRoot.set(name, existing);
  }

  const out: RootField[] = [];
  for (const rootType of ROOT_TYPES) {
    const fields = fieldsByRoot.get(rootType);
    if (fields === undefined) {
      continue;
    }
    for (const field of fields) {
      out.push({ rootType, field });
    }
  }
  return out;
}

function isRootType(name: string): name is RootType {
  return ROOT_TYPES.includes(name as RootType);
}

function buildResolverSummary(
  rootType: RootType,
  field: FieldDefinitionNode,
  source: string,
  recognition: string,
  transport: string,
): BehavioralSummary {
  const fieldName = field.name.value;
  const ownerKey = `${rootType}.${fieldName}`;

  return {
    kind: "resolver",
    location: {
      file: `${source}:${ownerKey}`,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: ownerKey,
      exportPath: null,
      boundaryBinding: graphqlResolverBinding({
        transport,
        recognition,
        typeName: rootType,
        fieldName,
      }),
    },
    inputs: buildInputs(field),
    transitions: buildTransitions(ownerKey, field),
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: {
      graphql: {
        rootType,
        fieldName,
      },
    },
  };
}

function buildInputs(field: FieldDefinitionNode): Input[] {
  const args = field.arguments ?? [];
  return args.map<Input>((arg, index) => ({
    type: "parameter",
    name: arg.name.value,
    position: index,
    role: "args",
    shape: typeNodeToShape(arg.type),
  }));
}

function buildTransitions(
  ownerKey: string,
  field: FieldDefinitionNode,
): Transition[] {
  const returnShape = typeNodeToShape(field.type);
  return [
    {
      id: `${ownerKey}:return:success`,
      conditions: [],
      output: { type: "return", value: returnShape },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: true,
      confidence: { source: "derived", level: "high" },
      metadata: {
        source: "graphql:resolver.success",
      },
    },
    {
      id: `${ownerKey}:throw:error`,
      conditions: [
        {
          type: "opaque",
          sourceText: "graphql:resolver-error",
          reason: "externalFunction",
        },
      ],
      output: {
        type: "throw",
        exceptionType: "GraphQLError",
        message: null,
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      confidence: { source: "derived", level: "low" },
      metadata: {
        source: "graphql:resolver.error",
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// SDL TypeNode → TypeShape
// ---------------------------------------------------------------------------

function typeNodeToShape(node: TypeNode): TypeShape {
  if (node.kind === Kind.NON_NULL_TYPE) {
    // Non-null is enforced by GraphQL — drop the wrapper since
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
