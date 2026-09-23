/**
 * Builds one resolver summary per resolver in the AppSync model, and one
 * schema document summary per API whose SDL resolved. A resolver's
 * inputs and return type come from its SDL field.
 *
 * A resolver whose field the SDL does not declare still gets a summary.
 * AppSync would reject that stack at deploy time, so the boundary is
 * reported instead of dropped.
 */

import {
  graphqlResolverBinding,
  nestedDocumentLabel,
  withGraphqlMetadata,
  withSourceDocumentMetadata,
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
  /** Path recorded on each summary's `location.file`. */
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
  const resolverApis = new Set(
    config.resolvers.map((resolver) => resolver.apiLogicalId),
  );
  return [
    ...schemaDocumentSummaries(
      resolvedByApi,
      resolverApis,
      indexes,
      sourceFile,
    ),
    ...config.resolvers.map((resolver) =>
      buildOne(resolver, indexes, resolvedByApi, schemasByApi, sourceFile),
    ),
  ];
}

/**
 * The SDL belongs to the whole API, so it goes on its own summary. The
 * label includes the API's logical id, as a nested stack's does, since
 * one template can declare two APIs.
 */
function schemaDocumentSummaries(
  resolvedByApi: Map<string, ResolvedSchema>,
  resolverApis: ReadonlySet<string | null>,
  indexes: Indexes,
  sourceFile: string,
): BehavioralSummary[] {
  const out: BehavioralSummary[] = [];
  for (const [apiLogicalId, resolved] of resolvedByApi) {
    const sdl = resolvedSdl(resolved);
    if (sdl === null || !resolverApis.has(apiLogicalId)) {
      continue;
    }
    const label = schemaDocumentLabel(sourceFile, apiLogicalId);
    out.push({
      kind: "library",
      location: { file: label, range: { start: 0, end: 0 }, exportName: null },
      identity: {
        name: indexes.apiById.get(apiLogicalId)?.name ?? apiLogicalId,
        exportPath: null,
        boundaryBinding: null,
      },
      inputs: [],
      transitions: [],
      gaps: [],
      confidence: { source: "derived", level: "high" },
      metadata: withGraphqlMetadata(
        withSourceDocumentMetadata(undefined, { label }),
        { schemaSdl: sdl },
      ),
    });
  }
  return out;
}

function schemaDocumentLabel(
  sourceFile: string,
  apiLogicalId: string | null,
): string {
  return nestedDocumentLabel(
    sourceFile,
    apiLogicalId === null ? [] : [apiLogicalId],
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
  const schemaDocument =
    resolved === null || resolvedSdl(resolved) === null
      ? null
      : schemaDocumentLabel(sourceFile, resolver.apiLogicalId);

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
        // Clients reach AppSync over HTTPS to an AWS endpoint.
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
    metadata: buildMetadata(
      resolver,
      api,
      resolved,
      field,
      indexes,
      schemaDocument,
    ),
  };
}

function buildMetadata(
  resolver: AppSyncResolver,
  api: AppSyncApi | null,
  resolved: ResolvedSchema | null,
  field: FieldInfo | null,
  indexes: Indexes,
  schemaDocument: string | null,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    appsync: buildAppsyncMetadata(resolver, api, resolved, field, indexes),
  };
  // The checker follows this label to the SDL to resolve a consumer's
  // nested selections against the resolver's return type.
  if (schemaDocument === null) {
    return metadata;
  }
  return withSourceDocumentMetadata(metadata, { label: schemaDocument });
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
    // Only a UNIT resolver has its own data source. A pipeline records
    // the Lambda behind each of its functions instead.
    lambdaFunctionLogicalId: lambdaBehind(
      resolver.dataSourceLogicalId,
      indexes,
    ),
    kind: resolver.kind,
    authenticationType: api?.authenticationType ?? null,
    codeUri: resolver.codeUri,
    runtime: resolver.runtime,
    // Keeps a field the SDL does not declare apart from a schema that was
    // never read, such as a remote one.
    schemaMatched: field !== null,
    schemaSource: schemaSourceMetadata(resolved),
    // Left out for a UNIT resolver, and for a pipeline whose Functions
    // list cannot be read statically.
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
 * A default success returning the declared type, or `unknown` when the
 * SDL lacks the field, and one generic throw for `errors[]`. Telling
 * failures apart would need the VTL or JS resolver code read.
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
