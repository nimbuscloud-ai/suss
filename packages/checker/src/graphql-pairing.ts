// graphql-pairing.ts — Pair graphql-operation consumers with
// graphql-resolver providers by walking the operation's selection
// set.
//
// Root-level selections pair by (rootTypeName, fieldName). When
// the matched provider resolver carries an SDL (via
// `metadata.graphql.schemaSdl` — AppSync stubs or Apollo
// code-first servers with statically-resolvable `typeDefs`), the
// pairing pass also walks the operation's NESTED selections on
// the resolved return type and flags any that the schema doesn't
// declare. That's the `graphqlSelectionFieldUnknown` finding —
// the second half of "what can go wrong across a GraphQL
// boundary" alongside the root-field not-implemented finding.
//
// Parsing is lazy + cached: operation documents parse once per
// checker pass; SDLs parse once per unique text. Keeps the pass
// O(N operations + M resolvers) regardless of schema size.

import {
  type DocumentNode,
  type FieldNode,
  Kind,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type OperationDefinitionNode,
  parse,
  type TypeNode,
} from "graphql";

import type {
  BehavioralSummary,
  Finding,
  GraphqlResolverSemantics,
} from "@suss/behavioral-ir";
import type { SummaryPair } from "./pairing.js";

interface OperationDoc {
  operationType: "query" | "mutation" | "subscription";
  /** Root-type name corresponding to operationType (Query/Mutation/Subscription). */
  rootTypeName: string;
  /**
   * Root-level selections. Each entry captures the field name plus
   * any nested sub-selections (recursively). Only FIELD selections
   * count for v0 — fragments pass through without interpretation.
   */
  rootSelections: FieldSelection[];
}

interface FieldSelection {
  name: string;
  nested: FieldSelection[];
}

export interface GraphqlPairingResult {
  pairs: SummaryPair[];
  findings: Finding[];
}

export function pairGraphqlOperations(
  summaries: BehavioralSummary[],
): GraphqlPairingResult {
  const operations = summaries.filter(isGraphqlOperation);
  if (operations.length === 0) {
    return { pairs: [], findings: [] };
  }
  const resolverIndex = indexResolvers(summaries);
  const schemaCache = new Map<string, SchemaIndex>();
  const pairs: SummaryPair[] = [];
  const findings: Finding[] = [];

  for (const operation of operations) {
    const doc = operationDocFor(operation);
    if (doc === null) {
      continue;
    }
    pairOneOperation(
      operation,
      doc,
      resolverIndex,
      schemaCache,
      pairs,
      findings,
    );
  }

  return { pairs, findings };
}

function pairOneOperation(
  operation: BehavioralSummary,
  doc: OperationDoc,
  resolverIndex: Map<string, BehavioralSummary[]>,
  schemaCache: Map<string, SchemaIndex>,
  pairs: SummaryPair[],
  findings: Finding[],
): void {
  for (const selection of doc.rootSelections) {
    const key = `${doc.rootTypeName}.${selection.name}`;
    const matchingResolvers = resolverIndex.get(key) ?? [];
    if (matchingResolvers.length === 0) {
      findings.push(fieldNotImplementedFinding(operation, doc, selection.name));
      continue;
    }
    for (const resolver of matchingResolvers) {
      pairs.push({
        provider: resolver,
        consumer: operation,
        key: `gql:${key}`,
      });
      // When the provider carries an SDL, walk nested selections
      // against the declared field set. The same SDL text cached
      // once per pass — a monolithic schema from 50 resolvers
      // parses once, not 50 times.
      if (selection.nested.length > 0) {
        const schema = resolverSchema(resolver, schemaCache);
        if (schema !== null) {
          walkNestedSelections(
            operation,
            doc,
            selection,
            doc.rootTypeName,
            schema,
            findings,
          );
        }
      }
    }
  }
}

/**
 * Look up the return type of `rootTypeName.<selection.name>` in the
 * provider's SDL, then recursively walk each nested selection. Each
 * selection name that isn't a field on the resolved object type
 * emits `graphqlSelectionFieldUnknown`. List / non-null / scalar
 * return types stop the walk — you can't select fields on a scalar.
 */
function walkNestedSelections(
  operation: BehavioralSummary,
  doc: OperationDoc,
  selection: FieldSelection,
  parentTypeName: string,
  schema: SchemaIndex,
  findings: Finding[],
): void {
  const parentType = schema.objectTypes.get(parentTypeName);
  if (parentType === undefined) {
    return;
  }
  const fieldType = parentType.fields.get(selection.name);
  if (fieldType === undefined) {
    return;
  }
  const returnTypeName = unwrapToNamedType(fieldType);
  const returnType = schema.objectTypes.get(returnTypeName);
  if (returnType === undefined) {
    // Scalar / enum / union / interface — v0 doesn't descend.
    return;
  }
  for (const child of selection.nested) {
    if (!returnType.fields.has(child.name)) {
      findings.push(
        nestedFieldUnknownFinding(operation, doc, returnTypeName, child.name),
      );
      continue;
    }
    if (child.nested.length > 0) {
      walkNestedSelections(
        operation,
        doc,
        child,
        returnTypeName,
        schema,
        findings,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Operation parsing
// ---------------------------------------------------------------------------

function isGraphqlOperation(summary: BehavioralSummary): boolean {
  return (
    summary.identity.boundaryBinding?.semantics.name === "graphql-operation"
  );
}

function isGraphqlResolver(
  summary: BehavioralSummary,
): summary is BehavioralSummary & {
  identity: { boundaryBinding: { semantics: GraphqlResolverSemantics } };
} {
  return (
    summary.identity.boundaryBinding?.semantics.name === "graphql-resolver"
  );
}

function indexResolvers(
  summaries: BehavioralSummary[],
): Map<string, BehavioralSummary[]> {
  const index = new Map<string, BehavioralSummary[]>();
  for (const summary of summaries) {
    if (!isGraphqlResolver(summary)) {
      continue;
    }
    const sem = summary.identity.boundaryBinding.semantics;
    const key = `${sem.typeName}.${sem.fieldName}`;
    const bucket = index.get(key);
    if (bucket === undefined) {
      index.set(key, [summary]);
    } else {
      bucket.push(summary);
    }
  }
  return index;
}

function operationDocFor(summary: BehavioralSummary): OperationDoc | null {
  const binding = summary.identity.boundaryBinding;
  if (binding?.semantics.name !== "graphql-operation") {
    return null;
  }
  const documentText = readOperationDocument(summary);
  if (documentText === null) {
    return null;
  }
  return parseOperationDoc(binding.semantics.operationType, documentText);
}

function readOperationDocument(summary: BehavioralSummary): string | null {
  const graphqlMeta = summary.metadata?.graphql;
  if (typeof graphqlMeta !== "object" || graphqlMeta === null) {
    return null;
  }
  const document = (graphqlMeta as { document?: unknown }).document;
  return typeof document === "string" ? document : null;
}

function parseOperationDoc(
  bindingOperationType: "query" | "mutation" | "subscription",
  documentText: string,
): OperationDoc | null {
  const definition = parseFirstOperation(documentText);
  if (definition === null) {
    return null;
  }
  const operationType =
    definition.operation === "query" ||
    definition.operation === "mutation" ||
    definition.operation === "subscription"
      ? definition.operation
      : bindingOperationType;
  return {
    operationType,
    rootTypeName: rootTypeNameFor(operationType),
    rootSelections: rootFieldSelectionsOf(definition),
  };
}

function parseFirstOperation(
  documentText: string,
): OperationDefinitionNode | null {
  try {
    const doc = parse(documentText);
    for (const def of doc.definitions) {
      if (def.kind === Kind.OPERATION_DEFINITION) {
        return def;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function rootTypeNameFor(
  operationType: "query" | "mutation" | "subscription",
): string {
  if (operationType === "mutation") {
    return "Mutation";
  }
  if (operationType === "subscription") {
    return "Subscription";
  }
  return "Query";
}

function rootFieldSelectionsOf(op: OperationDefinitionNode): FieldSelection[] {
  return fieldSelectionsFrom(op.selectionSet.selections);
}

function fieldSelectionsFrom(
  selections: OperationDefinitionNode["selectionSet"]["selections"],
): FieldSelection[] {
  const out: FieldSelection[] = [];
  for (const selection of selections) {
    // Only direct Field selections count — fragments / inline
    // fragments pass through without interpretation (handling them
    // requires walking fragment definitions + type conditions,
    // which lands when a concrete use case arrives).
    if (selection.kind !== Kind.FIELD) {
      continue;
    }
    const field = selection as FieldNode;
    const nested = field.selectionSet
      ? fieldSelectionsFrom(field.selectionSet.selections)
      : [];
    out.push({ name: field.name.value, nested });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema indexing (for nested-selection checks)
// ---------------------------------------------------------------------------

interface SchemaIndex {
  /** typeName → { fieldName → TypeNode (raw return type) }. */
  objectTypes: Map<string, { fields: Map<string, TypeNode> }>;
}

function resolverSchema(
  resolver: BehavioralSummary,
  cache: Map<string, SchemaIndex>,
): SchemaIndex | null {
  const sdl = readSchemaSdl(resolver);
  if (sdl === null) {
    return null;
  }
  const cached = cache.get(sdl);
  if (cached !== undefined) {
    return cached;
  }
  const index = buildSchemaIndex(sdl);
  if (index !== null) {
    cache.set(sdl, index);
  }
  return index;
}

function readSchemaSdl(summary: BehavioralSummary): string | null {
  const meta = summary.metadata?.graphql;
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const sdl = (meta as { schemaSdl?: unknown }).schemaSdl;
  return typeof sdl === "string" ? sdl : null;
}

function buildSchemaIndex(sdl: string): SchemaIndex | null {
  const doc = safeParse(sdl);
  if (doc === null) {
    return null;
  }
  return indexDocument(doc);
}

function safeParse(sdl: string): DocumentNode | null {
  try {
    return parse(sdl);
  } catch {
    return null;
  }
}

function indexDocument(doc: DocumentNode): SchemaIndex {
  const objectTypes = new Map<string, { fields: Map<string, TypeNode> }>();
  for (const def of doc.definitions) {
    if (
      def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      def.kind !== Kind.OBJECT_TYPE_EXTENSION &&
      def.kind !== Kind.INTERFACE_TYPE_DEFINITION
    ) {
      continue;
    }
    const typed = def as ObjectTypeDefinitionNode | ObjectTypeExtensionNode;
    const typeName = typed.name.value;
    const existing = objectTypes.get(typeName);
    const fields = existing?.fields ?? new Map<string, TypeNode>();
    for (const field of typed.fields ?? []) {
      fields.set(field.name.value, field.type);
    }
    objectTypes.set(typeName, { fields });
  }
  return { objectTypes };
}

function unwrapToNamedType(node: TypeNode): string {
  if (node.kind === Kind.NON_NULL_TYPE || node.kind === Kind.LIST_TYPE) {
    return unwrapToNamedType(node.type);
  }
  return node.name.value;
}

// ---------------------------------------------------------------------------
// Finding construction
// ---------------------------------------------------------------------------

function fieldNotImplementedFinding(
  operation: BehavioralSummary,
  doc: OperationDoc,
  fieldName: string,
): Finding {
  const binding = operation.identity.boundaryBinding;
  if (binding === null) {
    throw new Error("expected graphql-operation boundary binding");
  }
  const sideSummary = `${operation.location.file}::${operation.identity.name}`;
  return {
    kind: "graphqlFieldNotImplemented",
    boundary: binding,
    // Symmetric sides: the operation is both "provider" and
    // "consumer" here — the finding is about the operation as a
    // whole, not about a specific pair. A synthetic provider-less
    // side carries the root type + field for discoverability.
    provider: {
      summary: `${doc.rootTypeName}.${fieldName} (unresolved)`,
      location: operation.location,
    },
    consumer: {
      summary: sideSummary,
      location: operation.location,
    },
    description: `GraphQL operation "${operation.identity.name}" selects root field "${doc.rootTypeName}.${fieldName}" but no provider summary implements it.`,
    severity: "warning",
  };
}

function nestedFieldUnknownFinding(
  operation: BehavioralSummary,
  _doc: OperationDoc,
  parentTypeName: string,
  fieldName: string,
): Finding {
  const binding = operation.identity.boundaryBinding;
  if (binding === null) {
    throw new Error("expected graphql-operation boundary binding");
  }
  const sideSummary = `${operation.location.file}::${operation.identity.name}`;
  return {
    kind: "graphqlSelectionFieldUnknown",
    boundary: binding,
    provider: {
      summary: `${parentTypeName}.${fieldName} (undeclared)`,
      location: operation.location,
    },
    consumer: {
      summary: sideSummary,
      location: operation.location,
    },
    description: `GraphQL operation "${operation.identity.name}" selects "${parentTypeName}.${fieldName}" but the provider's schema doesn't declare that field on "${parentTypeName}". Likely a stale selection after a schema change — the server response will not include it.`,
    severity: "warning",
  };
}
