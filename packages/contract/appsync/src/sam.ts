// sam.ts — Normalize the SAM shorthand AWS::Serverless::GraphQLApi into
// the same AppSync model the raw AWS::AppSync::* walk produces.
//
// One AWS::Serverless::GraphQLApi resource carries what the SAM transform
// would otherwise expand into a GraphQLApi + GraphQLSchema + DataSources +
// FunctionConfigurations + Resolvers. We read those inline blocks and emit
// the same normalized records so both authoring shapes feed a single
// summaryBuilder path.
//
//   Properties:
//     Name                          — optional API name
//     SchemaInline | SchemaUri      — SDL text or a path/URI to a .graphql file
//     Auth.Type                     — authentication type
//     DataSources.<Category>.<Name> — Lambdas carry FunctionArn; others typed
//     Functions.<Name>              — Runtime/CodeUri + DataSource (pipeline steps)
//     Resolvers.<Type>.<Field>      — Runtime/CodeUri + DataSource (UNIT) or
//                                     Pipeline: [functionName...] (PIPELINE)
//
// Synthesized logical IDs prefix the API's logical ID so cross-references
// (resolver → data source, resolver → pipeline function, function → data
// source) line up without a separate lookup table, and so summaries stay
// distinct when a template declares several GraphQL APIs.

import { asRecord, resolveLogicalRef, stringField } from "./refs.js";

import type {
  AppSyncConfig,
  AppSyncDataSource,
  AppSyncFunction,
  AppSyncResolver,
  CfnResource,
  RawSchemaSource,
} from "./cfn.js";

const RESOLVER_ROOT_TYPES = ["Query", "Mutation", "Subscription"];

/** Map SAM `DataSources` category keys to normalized data-source types. */
const DATA_SOURCE_CATEGORIES: Record<string, string> = {
  Lambdas: "lambda",
  DynamoDb: "dynamodb",
  DynamoDBs: "dynamodb",
  OpenSearch: "opensearch",
  ElasticSearch: "elasticsearch",
  Http: "http",
  EventBridge: "eventbridge",
  RelationalDatabase: "relational",
  RelationalDatabases: "relational",
  None: "none",
};

export function readServerlessGraphQLApis(
  resources: Record<string, CfnResource | undefined>,
): AppSyncConfig {
  const out: AppSyncConfig = {
    apis: [],
    resolvers: [],
    functions: [],
    dataSources: [],
  };
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::Serverless::GraphQLApi") {
      continue;
    }
    readOne(logicalId, resource.Properties ?? {}, out);
  }
  return out;
}

function readOne(
  apiLogicalId: string,
  props: Record<string, unknown>,
  out: AppSyncConfig,
): void {
  out.apis.push({
    logicalId: apiLogicalId,
    name: stringField(props.Name),
    schemaSource: readSchemaSource(props),
    authenticationType: readAuthType(props.Auth),
  });
  out.dataSources.push(...readDataSources(apiLogicalId, props.DataSources));
  out.functions.push(...readFunctions(apiLogicalId, props.Functions));
  out.resolvers.push(...readResolvers(apiLogicalId, props.Resolvers));
}

function readSchemaSource(props: Record<string, unknown>): RawSchemaSource {
  const inline = stringField(props.SchemaInline);
  if (inline !== null) {
    return { kind: "inline", sdl: inline };
  }
  const location = stringField(props.SchemaUri);
  if (location !== null) {
    return { kind: "location", location };
  }
  return { kind: "absent" };
}

function readAuthType(auth: unknown): string | null {
  const record = asRecord(auth);
  return record === null ? null : stringField(record.Type);
}

function readDataSources(
  apiLogicalId: string,
  raw: unknown,
): AppSyncDataSource[] {
  const dataSources = asRecord(raw);
  if (dataSources === null) {
    return [];
  }
  const out: AppSyncDataSource[] = [];
  for (const [category, entriesRaw] of Object.entries(dataSources)) {
    const type = DATA_SOURCE_CATEGORIES[category] ?? "unknown";
    const entries = asRecord(entriesRaw);
    if (entries === null) {
      continue;
    }
    for (const [name, defRaw] of Object.entries(entries)) {
      const def = asRecord(defRaw);
      out.push({
        logicalId: dataSourceId(apiLogicalId, name),
        apiLogicalId,
        type,
        lambdaFunctionLogicalId:
          type === "lambda" && def !== null
            ? resolveLogicalRef(def.FunctionArn)
            : null,
      });
    }
  }
  return out;
}

function readFunctions(apiLogicalId: string, raw: unknown): AppSyncFunction[] {
  const functions = asRecord(raw);
  if (functions === null) {
    return [];
  }
  const out: AppSyncFunction[] = [];
  for (const [name, defRaw] of Object.entries(functions)) {
    const def = asRecord(defRaw) ?? {};
    out.push({
      logicalId: functionId(apiLogicalId, name),
      apiLogicalId,
      name,
      dataSourceLogicalId: referencedDataSourceId(apiLogicalId, def.DataSource),
      codeUri: stringField(def.CodeUri),
      runtime: readRuntime(def.Runtime),
    });
  }
  return out;
}

function readResolvers(apiLogicalId: string, raw: unknown): AppSyncResolver[] {
  const byType = asRecord(raw);
  if (byType === null) {
    return [];
  }
  const out: AppSyncResolver[] = [];
  for (const typeName of RESOLVER_ROOT_TYPES) {
    const fields = asRecord(byType[typeName]);
    if (fields === null) {
      continue;
    }
    for (const [fieldName, defRaw] of Object.entries(fields)) {
      const def = asRecord(defRaw) ?? {};
      out.push(buildResolver(apiLogicalId, typeName, fieldName, def));
    }
  }
  return out;
}

function buildResolver(
  apiLogicalId: string,
  typeName: string,
  fieldName: string,
  def: Record<string, unknown>,
): AppSyncResolver {
  const pipeline = readPipeline(apiLogicalId, def.Pipeline);
  const isPipeline = pipeline.length > 0;
  return {
    logicalId: `${apiLogicalId}${typeName}${fieldName}Resolver`,
    apiLogicalId,
    typeName,
    fieldName,
    dataSourceLogicalId: isPipeline
      ? null
      : referencedDataSourceId(apiLogicalId, def.DataSource),
    kind: isPipeline ? "PIPELINE" : "UNIT",
    pipelineFunctionLogicalIds: pipeline,
    codeUri: stringField(def.CodeUri),
    runtime: readRuntime(def.Runtime),
  };
}

function readPipeline(apiLogicalId: string, raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    const name = stringField(entry) ?? resolveLogicalRef(entry);
    if (name !== null) {
      out.push(functionId(apiLogicalId, name));
    }
  }
  return out;
}

function readRuntime(raw: unknown): string | null {
  const record = asRecord(raw);
  return record === null ? null : stringField(record.Name);
}

/**
 * A resolver / function references a data source by its SAM-local name.
 * Map that to the synthesized data-source logical ID so the builder can
 * resolve Lambda attribution. Unknown / dynamic references collapse to
 * null (no data source to attribute).
 */
function referencedDataSourceId(
  apiLogicalId: string,
  raw: unknown,
): string | null {
  const name = stringField(raw);
  return name === null ? null : dataSourceId(apiLogicalId, name);
}

function dataSourceId(apiLogicalId: string, name: string): string {
  return `${apiLogicalId}${name}`;
}

function functionId(apiLogicalId: string, name: string): string {
  return `${apiLogicalId}${name}`;
}
