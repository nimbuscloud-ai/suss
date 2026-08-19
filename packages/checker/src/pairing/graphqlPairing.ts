// graphql-pairing.ts: Pair graphql-operation consumers with
// graphql-resolver providers by walking the operation's selection
// set.
//
// Root-level selections pair by (rootTypeName, fieldName). When
// the matched provider resolver's schema is on hand, the pairing
// pass also walks the operation's NESTED selections on the
// resolved return type and flags any that the schema doesn't
// declare. That's the `graphqlSelectionFieldUnknown` finding,
// the second half of "what can go wrong across a GraphQL
// boundary" alongside the root-field not-implemented finding.
//
// The schema comes from the summary standing for the schema
// document, which the resolver points at through the document
// label both were read under. A reader with no document summary
// may write the SDL beside the resolver instead, and that is read
// too. See this directory's README.
//
// Parsing is lazy + cached: operation documents parse once per
// checker pass; SDLs parse once per unique text. Keeps the pass
// O(N operations + M resolvers) regardless of schema size.

import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  Kind,
  type ObjectTypeDefinitionNode,
  type ObjectTypeExtensionNode,
  type OperationDefinitionNode,
  parse,
  type TypeNode,
} from "graphql";

import {
  readGraphqlMetadata,
  readSourceDocumentMetadata,
  summaryRef,
} from "@suss/behavioral-ir";
import { boundaryKey, gqlIdentityKey } from "@suss/ir-core";

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
   * any nested sub-selections (recursively), with fragment spreads
   * and inline fragments flattened into the fields they contribute.
   */
  rootSelections: FieldSelection[];
}

interface FieldSelection {
  name: string;
  nested: FieldSelection[];
  /**
   * The fragment type condition this selection came through, or null
   * for a direct selection on its parent. `... on Dog { bark }` checks
   * `bark` against Dog, not against the field's declared return type.
   */
  onType: string | null;
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
  const schemas: SchemaLookup = {
    byDocument: schemasByDocument(summaries),
    parsed: new Map<string, SchemaIndex>(),
  };
  const pairs: SummaryPair[] = [];
  const findings: Finding[] = [];

  for (const operation of operations) {
    const doc = operationDocFor(operation);
    if (doc === null) {
      continue;
    }
    pairOneOperation(operation, doc, resolverIndex, schemas, pairs, findings);
  }

  return { pairs, findings };
}

function pairOneOperation(
  operation: BehavioralSummary,
  doc: OperationDoc,
  resolverIndex: Map<string, BehavioralSummary[]>,
  schemas: SchemaLookup,
  pairs: SummaryPair[],
  findings: Finding[],
): void {
  for (const selection of doc.rootSelections) {
    // __typename / __schema / __type are served by the GraphQL runtime
    // itself; no resolver implements them and none needs to (#225).
    if (isMetaField(selection.name)) {
      continue;
    }

    const key = gqlIdentityKey(doc.rootTypeName, selection.name);
    const matchingResolvers = scopeToBoundService(
      operation,
      resolverIndex.get(key) ?? [],
    );
    if (matchingResolvers.length === 0) {
      findings.push(fieldNotImplementedFinding(operation, doc, selection.name));
      continue;
    }

    // Two GraphQL services in one repo can declare the same root field,
    // and the key has no endpoint identity to tell them apart (#224).
    const workspaces = providerWorkspaces(matchingResolvers);
    if (workspaces.length > 1) {
      findings.push(
        ambiguousProviderFinding(
          operation,
          doc,
          selection.name,
          matchingResolvers,
          workspaces,
        ),
      );
    }

    for (const resolver of matchingResolvers) {
      pairs.push({
        provider: resolver,
        consumer: operation,
        key,
      });
      // When the provider's schema is on hand, walk nested selections
      // against the declared field set. Fifty resolvers out of one
      // schema document share one parse.
      if (selection.nested.length > 0) {
        const schema = resolverSchema(resolver, schemas);
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
 * return types stop the walk. You can't select fields on a scalar.
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
  for (const child of selection.nested) {
    // __typename exists on every composite type; the runtime serves
    // it without a schema declaration (#225).
    if (isMetaField(child.name)) {
      continue;
    }

    // A child from a fragment checks against the fragment's type
    // condition rather than the field's declared return type.
    const childParentName = child.onType ?? returnTypeName;
    const childParent = schema.objectTypes.get(childParentName);
    if (childParent === undefined) {
      // Scalar / enum / union / unknown type, v0 doesn't descend.
      continue;
    }

    if (!childParent.fields.has(child.name)) {
      findings.push(
        nestedFieldUnknownFinding(operation, doc, childParentName, child.name),
      );
      continue;
    }

    if (child.nested.length > 0) {
      walkNestedSelections(
        operation,
        doc,
        child,
        childParentName,
        schema,
        findings,
      );
    }
  }
}

/** GraphQL introspection fields: __typename, __schema, __type. */
function isMetaField(name: string): boolean {
  return name.startsWith("__");
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
    // The semantics' own key guards the null typeName a `@Resolver()`
    // class with no argument gets; the hand-built join indexed it
    // under the literal "null.fieldName" (#162).
    const key = boundaryKey(summary.identity.boundaryBinding);
    if (key === null) {
      continue;
    }
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
  return readGraphqlMetadata(summary)?.document ?? null;
}

function parseOperationDoc(
  bindingOperationType: "query" | "mutation" | "subscription",
  documentText: string,
): OperationDoc | null {
  const parsed = parseFirstOperation(documentText);
  if (parsed === null) {
    return null;
  }
  const { definition, fragments } = parsed;
  const operationType =
    definition.operation === "query" ||
    definition.operation === "mutation" ||
    definition.operation === "subscription"
      ? definition.operation
      : bindingOperationType;
  return {
    operationType,
    rootTypeName: rootTypeNameFor(operationType),
    rootSelections: fieldSelectionsFrom(
      definition.selectionSet.selections,
      fragments,
      null,
      new Set(),
    ),
  };
}

interface ParsedOperation {
  definition: OperationDefinitionNode;
  /** Fragment definitions in the same document, by fragment name. */
  fragments: Map<string, FragmentDefinitionNode>;
}

function parseFirstOperation(documentText: string): ParsedOperation | null {
  try {
    const doc = parse(documentText);
    let definition: OperationDefinitionNode | null = null;
    const fragments = new Map<string, FragmentDefinitionNode>();
    for (const def of doc.definitions) {
      if (def.kind === Kind.OPERATION_DEFINITION && definition === null) {
        definition = def;
      }
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        fragments.set(def.name.value, def);
      }
    }
    return definition === null ? null : { definition, fragments };
  } catch {
    return null;
  }
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

/**
 * Flatten a selection set to fields, following fragments. A spread
 * pulls in its definition's fields, an inline fragment its own, and
 * either kind stamps its type condition on the fields it contributes
 * so the nested walk checks them against the right type (#225). The
 * `expanding` set stops a spread cycle, which the spec forbids but a
 * malformed document can contain.
 */
function fieldSelectionsFrom(
  selections: OperationDefinitionNode["selectionSet"]["selections"],
  fragments: Map<string, FragmentDefinitionNode>,
  onType: string | null,
  expanding: ReadonlySet<string>,
): FieldSelection[] {
  const out: FieldSelection[] = [];
  for (const selection of selections) {
    if (selection.kind === Kind.FIELD) {
      const field = selection as FieldNode;
      const nested = field.selectionSet
        ? fieldSelectionsFrom(
            field.selectionSet.selections,
            fragments,
            null,
            expanding,
          )
        : [];
      out.push({ name: field.name.value, nested, onType });
      continue;
    }

    if (selection.kind === Kind.INLINE_FRAGMENT) {
      const condition = selection.typeCondition?.name.value ?? onType;
      out.push(
        ...fieldSelectionsFrom(
          selection.selectionSet.selections,
          fragments,
          condition,
          expanding,
        ),
      );
      continue;
    }

    if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const name = selection.name.value;
      const definition = fragments.get(name);
      if (definition === undefined || expanding.has(name)) {
        continue;
      }
      out.push(
        ...fieldSelectionsFrom(
          definition.selectionSet.selections,
          fragments,
          definition.typeCondition.name.value,
          new Set([...expanding, name]),
        ),
      );
    }
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

interface SchemaLookup {
  /** Document label → the SDL that document declares. */
  byDocument: Map<string, string>;
  /** Parsed and indexed SDL, keyed by its text. */
  parsed: Map<string, SchemaIndex>;
}

/**
 * The SDL out of every summary standing for a schema document. Two
 * documents under one label would each answer for the other's fields,
 * so a label whose summaries disagree drops out and its resolvers check
 * nothing, the same as a resolver with no schema at all.
 */
function schemasByDocument(
  summaries: BehavioralSummary[],
): Map<string, string> {
  const byLabel = new Map<string, string>();
  const disputed = new Set<string>();
  for (const summary of summaries) {
    const label = readSourceDocumentMetadata(summary)?.label;
    const sdl = readSchemaSdl(summary);
    if (label === undefined || sdl === null) {
      continue;
    }
    const seen = byLabel.get(label);
    if (seen !== undefined && seen !== sdl) {
      disputed.add(label);
    }
    byLabel.set(label, sdl);
  }
  for (const label of disputed) {
    byLabel.delete(label);
  }
  return byLabel;
}

/**
 * The schema behind a resolver: the one its document declares, or one
 * written beside the resolver itself by a reader with no document
 * summary to put it on.
 */
function resolverSchema(
  resolver: BehavioralSummary,
  schemas: SchemaLookup,
): SchemaIndex | null {
  const sdl = documentSdl(resolver, schemas) ?? readSchemaSdl(resolver);
  if (sdl === null) {
    return null;
  }
  const cached = schemas.parsed.get(sdl);
  if (cached !== undefined) {
    return cached;
  }
  const index = buildSchemaIndex(sdl);
  if (index !== null) {
    schemas.parsed.set(sdl, index);
  }
  return index;
}

function documentSdl(
  resolver: BehavioralSummary,
  schemas: SchemaLookup,
): string | null {
  const label = readSourceDocumentMetadata(resolver)?.label;
  if (label === undefined) {
    return null;
  }
  return schemas.byDocument.get(label) ?? null;
}

function readSchemaSdl(summary: BehavioralSummary): string | null {
  return readGraphqlMetadata(summary)?.schemaSdl ?? null;
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
  const sideSummary = summaryRef(operation);
  return {
    kind: "boundaryFieldUnknown",
    aspect: "read",
    boundary: binding,
    // Symmetric sides: the operation is both "provider" and
    // "consumer" here: the finding is about the operation as a
    // whole, not about a specific pair. A synthetic provider-less
    // side records the root type + field for discoverability.
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

/**
 * Keep only the resolvers from the service the operation's client is
 * bound to, when a per-project config bound one. An unbound consumer
 * keeps every match, ambiguity warning included. A binding that
 * matches no resolver also keeps every match, since dropping them all
 * would report "not implemented" for a field somebody does implement,
 * and the ambiguity warning surfaces the collision either way.
 */
function scopeToBoundService(
  operation: BehavioralSummary,
  resolvers: BehavioralSummary[],
): BehavioralSummary[] {
  const workspace = readGraphqlMetadata(operation)?.client?.workspace;
  if (workspace === undefined) {
    return resolvers;
  }

  const scoped = resolvers.filter(
    (resolver) => resolver.location.workspace === workspace,
  );
  return scoped.length > 0 ? scoped : resolvers;
}

/**
 * The distinct workspaces the matched resolvers came from. A resolver
 * without a workspace (a single-project run) counts as one bucket, so
 * two unlabeled services still collapse to one and stay quiet.
 */
function providerWorkspaces(resolvers: BehavioralSummary[]): string[] {
  const seen = new Set<string>();
  for (const resolver of resolvers) {
    seen.add(resolver.location.workspace ?? "");
  }
  return [...seen].sort();
}

function ambiguousProviderFinding(
  operation: BehavioralSummary,
  doc: OperationDoc,
  fieldName: string,
  resolvers: BehavioralSummary[],
  workspaces: string[],
): Finding {
  const binding = operation.identity.boundaryBinding;
  if (binding === null) {
    throw new Error("expected graphql-operation boundary binding");
  }
  const named = workspaces.map((w) => (w === "" ? "(unnamed)" : w));
  return {
    kind: "ambiguousProvider",
    boundary: binding,
    provider: {
      summary: summaryRef(resolvers[0] as BehavioralSummary),
      location: (resolvers[0] as BehavioralSummary).location,
    },
    consumer: {
      summary: summaryRef(operation),
      location: operation.location,
    },
    description: `GraphQL operation "${operation.identity.name}" selects "${doc.rootTypeName}.${fieldName}", which ${resolvers.length} resolvers implement across ${workspaces.length} services (${named.join(", ")}). The pairing key has no endpoint identity, so this operation pairs with all of them and some of those pairs are wrong.`,
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
  const sideSummary = summaryRef(operation);
  return {
    kind: "boundaryFieldUnknown",
    aspect: "read",
    boundary: binding,
    provider: {
      summary: `${parentTypeName}.${fieldName} (undeclared)`,
      location: operation.location,
    },
    consumer: {
      summary: sideSummary,
      location: operation.location,
    },
    description: `GraphQL operation "${operation.identity.name}" selects "${parentTypeName}.${fieldName}" but the provider's schema doesn't declare that field on "${parentTypeName}". Likely a stale selection after a schema change.`,
    // The schema is in the run and does not declare the field, so the
    // server rejects every operation using this selection at validation.
    severity: "error",
  };
}
