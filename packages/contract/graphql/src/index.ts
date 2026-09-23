/**
 * Reads a plain GraphQL SDL file and writes one resolver summary for each
 * field on Query, Mutation and Subscription. @suss/contract-appsync does
 * the same for AppSync schemas declared in CloudFormation. The README
 * describes what each summary contains.
 */

import fs from "node:fs";

import {
  type DocumentNode,
  type FieldDefinitionNode,
  Kind,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  parse,
} from "graphql";

import {
  graphqlResolverBinding,
  withGraphqlMetadata,
  withSourceDocumentMetadata,
} from "@suss/behavioral-ir";

import { typeDefinitionsIn, typeNodeToShape } from "./typeShape.js";

import type {
  BehavioralSummary,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";

export {
  type GraphqlDocumentsOptions,
  graphqlDocumentFilesToSummaries,
  graphqlDocumentsPathToSummaries,
  graphqlDocumentsToSummaries,
} from "./documents.js";
export {
  describesOperations,
  describesTypes,
  SCALAR_SHAPES,
} from "./typeShape.js";

const ROOT_TYPES = ["Query", "Mutation", "Subscription"] as const;
type RootType = (typeof ROOT_TYPES)[number];

export interface GraphqlContractOptions {
  /**
   * The path recorded on each summary's `location.file`. Defaults to
   * `"graphql"`, for SDL passed in as a string with no file behind it.
   */
  source?: string;
  /**
   * Recognition tag for the resolver binding. Defaults to `"graphql"`.
   * When several deployments serve the same SDL, give each its own tag
   * (`apollo-prod`, `apollo-staging`) so findings tell them apart.
   */
  recognition?: string;
  /**
   * Transport recorded on the boundary binding. Defaults to
   * `"http-graphql"`, since most GraphQL servers are served over HTTP.
   */
  transport?: string;
}

/**
 * Converts SDL text into one resolver summary per root field, plus one
 * summary for the schema document. Returns an empty array when the SDL
 * does not parse or has no root fields.
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

  const settings: ReaderSettings = {
    sdl,
    source: options.source ?? "graphql",
    recognition: options.recognition ?? "graphql",
    transport: options.transport ?? "http-graphql",
  };

  const rootFields = collectRootFields(doc);
  if (rootFields.length === 0) {
    return [];
  }

  const definitions = typeDefinitionsIn(doc);
  const out: BehavioralSummary[] = [buildSchemaDocumentSummary(settings)];
  for (const { rootType, field } of rootFields) {
    out.push(buildResolverSummary(rootType, field, settings, definitions));
  }

  return out;
}

interface ReaderSettings {
  sdl: string;
  source: string;
  recognition: string;
  transport: string;
}

/**
 * Reads an SDL file and converts it, recording the file path as the
 * source. `suss contract --from graphql <file>` calls this.
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

/**
 * Reads an SDL file and returns its text, or `null` when the file cannot
 * be read. @suss/contract-appsync uses it for the schema file a template
 * points at through `DefinitionS3Location` or `SchemaUri`, and records a
 * gap on `null` so a missing file does not fail the run.
 */
export function loadSdlFile(filepath: string): string | null {
  try {
    return fs.readFileSync(filepath, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface RootField {
  rootType: RootType;
  field: FieldDefinitionNode;
}

function collectRootFields(doc: DocumentNode): RootField[] {
  // `extend type Query { ... }` adds fields to a root type, so extensions
  // are merged with the definition.
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
  settings: ReaderSettings,
  definitions: Record<string, TypeShape>,
): BehavioralSummary {
  const { source, recognition, transport } = settings;
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
    // Every type record in the document, so a comparison with the
    // implementation has a structure to compare and not only a type name.
    ...(Object.keys(definitions).length > 0 ? { definitions } : {}),
    gaps: [],
    confidence: { source: "derived", level: "high" },
    // Provenance is "derived" because the transitions come from the same
    // field declaration, so comparing the contract with them finds nothing.
    metadata: withGraphqlMetadata(
      withSourceDocumentMetadata(undefined, { label: source }),
      {
        rootType,
        fieldName,
        declaredContract: buildDeclaredContract(field, recognition),
      },
    ),
  };
}

/**
 * The SDL belongs to the whole schema, so it goes on its own summary. The
 * checker reaches it from a resolver through the document label. It does
 * not bind to a boundary, so pairing leaves it out.
 */
function buildSchemaDocumentSummary(
  settings: ReaderSettings,
): BehavioralSummary {
  const { source, sdl } = settings;
  return {
    kind: "library",
    location: { file: source, range: { start: 0, end: 0 }, exportName: null },
    identity: { name: source, exportPath: null, boundaryBinding: null },
    inputs: [],
    transitions: [],
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: withGraphqlMetadata(
      withSourceDocumentMetadata(undefined, { label: source }),
      { schemaSdl: sdl },
    ),
  };
}

function buildDeclaredContract(
  field: FieldDefinitionNode,
  recognition: string,
) {
  return {
    returnType: typeNodeToShape(field.type),
    args: (field.arguments ?? []).map((arg) => ({
      name: arg.name.value,
      type: typeNodeToShape(arg.type),
      required: arg.type.kind === Kind.NON_NULL_TYPE,
    })),
    provenance: "derived" as const,
    framework: recognition,
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
