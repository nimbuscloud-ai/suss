// summaryBuilder.ts — Assemble BehavioralSummary objects from the
// normalized AppSync model (raw AWS::AppSync::* and SAM
// AWS::Serverless::GraphQLApi converge here).
//
// The schema-first angle drives most of the shape: every resolver's
// observable behavior is gated by its SDL field declaration. One summary
// is emitted per (TypeName, FieldName) declared by a resolver. Dangling
// resolvers (no SDL declaration for the target field) still produce a
// summary — they're a boundary AppSync would fail at deploy time, and
// surfacing them beats silently dropping. Lambda data-source attribution
// rides on each summary so it can later correlate to handler code.

import {
  graphqlResolverBinding,
  withGraphqlMetadata,
} from "@suss/behavioral-ir";

import { schemaKey } from "./schema.js";
import { resolvedSdl } from "./schemaSource.js";

import type {
  BehavioralSummary,
  Input,
  Transition,
  TypeShape,
} from "@suss/behavioral-ir";
import type {
  AppSyncApi,
  AppSyncConfig,
  AppSyncDataSource,
  AppSyncFunction,
  AppSyncResolver,
} from "./cfn.js";
import type { FieldInfo, SchemaIndex } from "./schema.js";
import type { ResolvedSchema } from "./schemaSource.js";

export interface BuildOptions {
  /** Logical source path recorded on each summary's `location.file`. */
  source?: string;
}

interface PipelineFunctionMeta {
  logicalId: string;
  name: string | null;
  dataSourceLogicalId: string | null;
  lambdaFunctionLogicalId: string | null;
  codeUri: string | null;
  runtime: string | null;
}

interface Indexes {
  apiById: Map<string, AppSyncApi>;
  functionById: Map<string, AppSyncFunction>;
  dataSourceById: Map<string, AppSyncDataSource>;
}

export function buildResolverSummaries(
  config: AppSyncConfig,
  resolvedByApi: Map<string, ResolvedSchema>,
  schemasByApi: Map<string, SchemaIndex>,
  options: BuildOptions = {},
): BehavioralSummary[] {
  const sourceFile = options.source ?? "appsync";
  const indexes: Indexes = {
    apiById: byLogicalId(config.apis),
    functionById: byLogicalId(config.functions),
    dataSourceById: byLogicalId(config.dataSources),
  };
  return config.resolvers.map((resolver) =>
    buildOne(resolver, indexes, resolvedByApi, schemasByApi, sourceFile),
  );
}

function byLogicalId<T extends { logicalId: string }>(
  items: T[],
): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    out.set(item.logicalId, item);
  }
  return out;
}

function buildOne(
  resolver: AppSyncResolver,
  indexes: Indexes,
  resolvedByApi: Map<string, ResolvedSchema>,
  schemasByApi: Map<string, SchemaIndex>,
  sourceFile: string,
): BehavioralSummary {
  const api =
    resolver.apiLogicalId === null
      ? null
      : (indexes.apiById.get(resolver.apiLogicalId) ?? null);
  const resolved =
    resolver.apiLogicalId === null
      ? null
      : (resolvedByApi.get(resolver.apiLogicalId) ?? null);
  const schema =
    resolver.apiLogicalId === null
      ? null
      : (schemasByApi.get(resolver.apiLogicalId) ?? null);
  const field =
    schema?.get(schemaKey(resolver.typeName, resolver.fieldName)) ?? null;

  const ownerKey = `${resolver.typeName}.${resolver.fieldName}`;
  const schemaSdl = resolved === null ? null : resolvedSdl(resolved);

  return {
    kind: "resolver",
    location: {
      file: `${sourceFile}:${resolver.logicalId}`,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: ownerKey,
      exportPath: null,
      boundaryBinding: graphqlResolverBinding({
        // AppSync is invoked over HTTPS-to-AWS. Keeping transport
        // explicit here matches the aws-apigateway reader's posture
        // and leaves room for a future AWS-SDK-direct transport
        // ("aws-sdk") once Lambda-invoke semantics land.
        transport: "aws-https",
        recognition: "appsync",
        typeName: resolver.typeName,
        fieldName: resolver.fieldName,
      }),
    },
    inputs: buildInputs(field),
    transitions: buildTransitions(ownerKey, resolver, field),
    gaps: [],
    confidence: { source: "derived", level: "high" },
    metadata: buildMetadata(resolver, api, resolved, field, indexes, schemaSdl),
  };
}

function buildMetadata(
  resolver: AppSyncResolver,
  api: AppSyncApi | null,
  resolved: ResolvedSchema | null,
  field: FieldInfo | null,
  indexes: Indexes,
  schemaSdl: string | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    appsync: buildAppsyncMetadata(resolver, api, resolved, field, indexes),
  };
  // Surface the resolved SDL so the checker can resolve nested
  // selections against this resolver's return type. Repeated across
  // every resolver from the same API by design — each summary travels
  // independently; keeping the SDL on-hand is simpler than
  // cross-summary schema lookup, and the checker caches parses per-SDL.
  if (schemaSdl === null) {
    return metadata;
  }
  return withGraphqlMetadata(metadata, { schemaSdl });
}

function buildAppsyncMetadata(
  resolver: AppSyncResolver,
  api: AppSyncApi | null,
  resolved: ResolvedSchema | null,
  field: FieldInfo | null,
  indexes: Indexes,
): Record<string, unknown> {
  const pipelineFunctions = resolver.pipelineFunctionLogicalIds.map(
    (logicalId) => pipelineFunctionMeta(logicalId, indexes),
  );
  return {
    apiLogicalId: resolver.apiLogicalId,
    apiName: api?.name ?? null,
    dataSourceLogicalId: resolver.dataSourceLogicalId,
    // Lambda behind this resolver's own data source (UNIT resolvers).
    // PIPELINE resolvers attribute per-function below; their top-level
    // data source is null, so this is null too.
    lambdaFunctionLogicalId: lambdaBehind(
      resolver.dataSourceLogicalId,
      indexes,
    ),
    kind: resolver.kind,
    authenticationType: api?.authenticationType ?? null,
    // SAM JS/VTL resolver code location + runtime (null for raw
    // AWS::AppSync::Resolver resources).
    codeUri: resolver.codeUri,
    runtime: resolver.runtime,
    // Distinguish "schema said X" from "we didn't see a schema at all"
    // (field-level), and record how the SDL itself was obtained
    // (source-level) so a genuinely-remote schema is never silent.
    schemaMatched: field !== null,
    schemaSource: schemaSourceMetadata(resolved),
    // For PIPELINE resolvers, surface the ordered function chain so
    // downstream tools can show the dispatch path. Empty for UNIT
    // resolvers; empty with `kind: "PIPELINE"` means the Functions
    // array was dynamically-referenced and we couldn't resolve it.
    ...(pipelineFunctions.length > 0 ? { pipelineFunctions } : {}),
  };
}

function pipelineFunctionMeta(
  logicalId: string,
  indexes: Indexes,
): PipelineFunctionMeta {
  const fn = indexes.functionById.get(logicalId) ?? null;
  return {
    logicalId,
    name: fn?.name ?? null,
    dataSourceLogicalId: fn?.dataSourceLogicalId ?? null,
    lambdaFunctionLogicalId: lambdaBehind(
      fn?.dataSourceLogicalId ?? null,
      indexes,
    ),
    codeUri: fn?.codeUri ?? null,
    runtime: fn?.runtime ?? null,
  };
}

function lambdaBehind(
  dataSourceLogicalId: string | null,
  indexes: Indexes,
): string | null {
  if (dataSourceLogicalId === null) {
    return null;
  }
  return (
    indexes.dataSourceById.get(dataSourceLogicalId)?.lambdaFunctionLogicalId ??
    null
  );
}

function schemaSourceMetadata(
  resolved: ResolvedSchema | null,
): Record<string, unknown> {
  if (resolved === null || resolved.status === "absent") {
    return { status: "absent" };
  }
  if (resolved.status === "inline") {
    return { status: "inline" };
  }
  if (resolved.status === "external-file") {
    return { status: "external-file", location: resolved.location };
  }
  return {
    status: "unresolved",
    location: resolved.location,
    reason: resolved.reason,
  };
}

function buildInputs(field: FieldInfo | null): Input[] {
  if (field === null) {
    return [];
  }
  return field.args.map<Input>((arg, index) => ({
    type: "parameter",
    name: arg.name,
    position: index,
    role: "args",
    shape: arg.shape,
  }));
}

/**
 * Default transitions for a v0 AppSync resolver summary:
 *
 *   1. Success: returns the SDL-declared shape. Marked default so
 *      unmatched consumer branches pair against it.
 *   2. Throw: AppSync resolvers surface failures as errors[] on the
 *      response (per GraphQL spec). V0 emits one generic throw
 *      transition so downstream consumer-satisfaction checking has
 *      somewhere to pair against when the consumer branches on an
 *      error path. Richer modeling (request-mapping validation 400,
 *      auth 401, datasource 502) is a follow-up tied to VTL / JS
 *      resolver parsing.
 *
 * When the schema doesn't declare the field, the success transition
 * falls back to a `ref: unknown` return — we still model the boundary,
 * just without shape detail.
 */
function buildTransitions(
  ownerKey: string,
  resolver: AppSyncResolver,
  field: FieldInfo | null,
): Transition[] {
  const returnShape: TypeShape = field?.returnShape ?? { type: "unknown" };
  const successSource =
    field !== null
      ? "aws::appsync::resolver.success"
      : "aws::appsync::resolver.success-no-schema";

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
        source: successSource,
        resolverKind: resolver.kind,
      },
    },
    {
      id: `${ownerKey}:throw:error`,
      conditions: [
        {
          type: "opaque",
          sourceText: "aws:appsync:resolver-error",
          reason: "externalFunction",
        },
      ],
      output: {
        type: "throw",
        exceptionType: null,
        message: null,
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: false,
      confidence: { source: "derived", level: "medium" },
      metadata: {
        source: "aws::appsync::resolver.error-path",
      },
    },
  ];
}
