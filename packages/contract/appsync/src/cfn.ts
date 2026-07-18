// cfn.ts — CloudFormation template traversal for AppSync resources.
//
// Two authoring shapes converge on one normalized model:
//
//   Raw AWS::AppSync::* resources (this file):
//     AWS::AppSync::GraphQLApi        — the API itself (auth config, name)
//     AWS::AppSync::GraphQLSchema     — SDL (inline Definition or S3 location)
//     AWS::AppSync::Resolver          — binds (TypeName, FieldName) → DataSource
//     AWS::AppSync::FunctionConfiguration — pipeline sub-functions
//     AWS::AppSync::DataSource        — where resolvers read from / write to
//
//   SAM shorthand AWS::Serverless::GraphQLApi (sam.ts):
//     one resource carries SchemaUri/SchemaInline + DataSources + Functions
//     + Resolvers blocks, which the SAM transform expands into the raw
//     resources above. We normalize it into the same model here so both
//     shapes feed a single summaryBuilder path.
//
// Static-reader scope: inline / on-disk SDL, UNIT and PIPELINE resolvers,
// static TypeName/FieldName values. Dynamic intrinsic resolution (`!Ref`
// to a parameter, `!Join` of a dynamic string) is left unresolved and
// surfaces in accounting rather than being guessed.

import { asRecord, resolveLogicalRef, stringField } from "./refs.js";
import { readServerlessGraphQLApis } from "./sam.js";

export interface CfnTemplate {
  Resources?: Record<string, CfnResource | undefined>;
}

export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

/**
 * How an API's SDL was declared in the template, before any on-disk
 * resolution. `location` is the raw `DefinitionS3Location` / `SchemaUri`
 * string (a local path or an `s3://` URI); resolution to text happens in
 * schemaSource.ts.
 */
export type RawSchemaSource =
  | { kind: "inline"; sdl: string }
  | { kind: "location"; location: string }
  | { kind: "absent" };

export interface AppSyncApi {
  logicalId: string;
  name: string | null;
  schemaSource: RawSchemaSource;
  authenticationType: string | null;
}

export interface AppSyncResolver {
  logicalId: string;
  apiLogicalId: string | null;
  typeName: string;
  fieldName: string;
  dataSourceLogicalId: string | null;
  /** "UNIT" (single-datasource) or "PIPELINE" (function chain). */
  kind: "UNIT" | "PIPELINE" | "UNKNOWN";
  /**
   * For PIPELINE resolvers, the ordered list of FunctionConfiguration
   * logical IDs the resolver dispatches through. Each entry pairs
   * with an `AppSyncFunction` in `AppSyncConfig.functions`.
   * Empty for UNIT resolvers (and for PIPELINE resolvers whose
   * PipelineConfig we couldn't statically resolve — those still
   * report `kind: "PIPELINE"` so downstream consumers can filter).
   */
  pipelineFunctionLogicalIds: string[];
  /**
   * For SAM `AWS::Serverless::GraphQLApi` resolvers written as JS/VTL
   * resolver code, the `CodeUri` and `Runtime.Name` so the summary can
   * later correlate to the resolver source file. Null for raw
   * AWS::AppSync::Resolver resources (their code lives in separate
   * request/response mapping template properties).
   */
  codeUri: string | null;
  runtime: string | null;
}

export interface AppSyncFunction {
  logicalId: string;
  apiLogicalId: string | null;
  name: string | null;
  dataSourceLogicalId: string | null;
  codeUri: string | null;
  runtime: string | null;
}

/**
 * A resolver's / function's backing data source. `lambdaFunctionLogicalId`
 * is populated for Lambda data sources (raw `LambdaConfig.LambdaFunctionArn`
 * or SAM `DataSources.Lambdas.<name>.FunctionArn`) so a resolver summary
 * can correlate to the handler code behind it.
 */
export interface AppSyncDataSource {
  logicalId: string;
  apiLogicalId: string | null;
  /** "lambda" | "dynamodb" | "http" | "none" | "unknown" and similar. */
  type: string;
  lambdaFunctionLogicalId: string | null;
}

export interface AppSyncConfig {
  apis: AppSyncApi[];
  resolvers: AppSyncResolver[];
  functions: AppSyncFunction[];
  dataSources: AppSyncDataSource[];
}

/**
 * Walk a CloudFormation template and collect AppSync APIs, resolvers,
 * functions, and data sources from both the raw AWS::AppSync::* resources
 * and the SAM AWS::Serverless::GraphQLApi shorthand. Unknown / malformed
 * entries are skipped rather than thrown — a template can mix AppSync with
 * unrelated resources, and a partial block shouldn't fail the whole read.
 */
export function readAppSyncFromCfn(template: CfnTemplate): AppSyncConfig {
  const resources = template.Resources ?? {};
  const raw: AppSyncConfig = {
    apis: collectApis(resources),
    resolvers: collectResolvers(resources),
    functions: collectFunctions(resources),
    dataSources: collectDataSources(resources),
  };
  const sam = readServerlessGraphQLApis(resources);
  return {
    apis: [...raw.apis, ...sam.apis],
    resolvers: [...raw.resolvers, ...sam.resolvers],
    functions: [...raw.functions, ...sam.functions],
    dataSources: [...raw.dataSources, ...sam.dataSources],
  };
}

function collectApis(
  resources: Record<string, CfnResource | undefined>,
): AppSyncApi[] {
  const apis: AppSyncApi[] = [];
  const schemaByApi = indexSchemasByApi(resources);

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::GraphQLApi") {
      continue;
    }
    const props = resource.Properties ?? {};
    apis.push({
      logicalId,
      name: stringField(props.Name),
      schemaSource: schemaByApi.get(logicalId) ?? { kind: "absent" },
      authenticationType: stringField(props.AuthenticationType),
    });
  }
  return apis;
}

/**
 * Build `apiLogicalId -> RawSchemaSource` from every GraphQLSchema
 * resource's `ApiId` back-reference. Inline `Definition` is captured as
 * text; `DefinitionS3Location` is captured as a location string for
 * on-disk / remote resolution in schemaSource.ts.
 */
function indexSchemasByApi(
  resources: Record<string, CfnResource | undefined>,
): Map<string, RawSchemaSource> {
  const out = new Map<string, RawSchemaSource>();
  for (const resource of Object.values(resources)) {
    if (resource?.Type !== "AWS::AppSync::GraphQLSchema") {
      continue;
    }
    const props = resource.Properties ?? {};
    const apiRef = resolveLogicalRef(props.ApiId);
    if (apiRef === null) {
      continue;
    }
    const inline = stringField(props.Definition);
    if (inline !== null) {
      out.set(apiRef, { kind: "inline", sdl: inline });
      continue;
    }
    const location = stringField(props.DefinitionS3Location);
    if (location !== null) {
      out.set(apiRef, { kind: "location", location });
    }
  }
  return out;
}

function collectResolvers(
  resources: Record<string, CfnResource | undefined>,
): AppSyncResolver[] {
  const out: AppSyncResolver[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::Resolver") {
      continue;
    }
    const props = resource.Properties ?? {};
    const typeName = stringField(props.TypeName);
    const fieldName = stringField(props.FieldName);
    if (typeName === null || fieldName === null) {
      continue;
    }
    out.push({
      logicalId,
      apiLogicalId: resolveLogicalRef(props.ApiId),
      typeName,
      fieldName,
      dataSourceLogicalId: resolveLogicalRef(props.DataSourceName),
      kind: resolverKind(stringField(props.Kind)),
      pipelineFunctionLogicalIds: pipelineFunctionIds(props.PipelineConfig),
      codeUri: null,
      runtime: null,
    });
  }
  return out;
}

/**
 * Extract ordered FunctionConfiguration logical IDs from a PIPELINE
 * resolver's `PipelineConfig.Functions` array. Each entry is
 * typically `!GetAtt FunctionResource.FunctionId` — we collapse to
 * the logical-ID head. Non-resolvable entries (dynamic Fn::Sub,
 * ImportValue) fall out silently; the resolver still reports its
 * pipeline kind with an empty list.
 */
function pipelineFunctionIds(pipelineConfig: unknown): string[] {
  const config = asRecord(pipelineConfig);
  if (config === null) {
    return [];
  }
  const functions = config.Functions;
  if (!Array.isArray(functions)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of functions) {
    const ref = resolveLogicalRef(entry);
    if (ref !== null) {
      out.push(ref);
    }
  }
  return out;
}

function collectFunctions(
  resources: Record<string, CfnResource | undefined>,
): AppSyncFunction[] {
  const out: AppSyncFunction[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::FunctionConfiguration") {
      continue;
    }
    const props = resource.Properties ?? {};
    out.push({
      logicalId,
      apiLogicalId: resolveLogicalRef(props.ApiId),
      name: stringField(props.Name),
      dataSourceLogicalId: resolveLogicalRef(props.DataSourceName),
      codeUri: null,
      runtime: null,
    });
  }
  return out;
}

/**
 * Collect AWS::AppSync::DataSource resources, keyed by logical ID (the
 * form resolvers reference via `!Ref`). Lambda data sources carry the
 * backing function's logical ID from `LambdaConfig.LambdaFunctionArn`.
 */
function collectDataSources(
  resources: Record<string, CfnResource | undefined>,
): AppSyncDataSource[] {
  const out: AppSyncDataSource[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::DataSource") {
      continue;
    }
    const props = resource.Properties ?? {};
    const lambdaConfig = asRecord(props.LambdaConfig);
    out.push({
      logicalId,
      apiLogicalId: resolveLogicalRef(props.ApiId),
      type: dataSourceType(stringField(props.Type)),
      lambdaFunctionLogicalId:
        lambdaConfig === null
          ? null
          : resolveLogicalRef(lambdaConfig.LambdaFunctionArn),
    });
  }
  return out;
}

const DATA_SOURCE_TYPES: Record<string, string> = {
  AWS_LAMBDA: "lambda",
  AMAZON_DYNAMODB: "dynamodb",
  AMAZON_ELASTICSEARCH: "elasticsearch",
  AMAZON_OPENSEARCH_SERVICE: "opensearch",
  HTTP: "http",
  RELATIONAL_DATABASE: "relational",
  AMAZON_EVENTBRIDGE: "eventbridge",
  NONE: "none",
};

function dataSourceType(raw: string | null): string {
  if (raw === null) {
    return "unknown";
  }
  return DATA_SOURCE_TYPES[raw] ?? "unknown";
}

function resolverKind(raw: string | null): AppSyncResolver["kind"] {
  if (raw === "PIPELINE") {
    return "PIPELINE";
  }
  if (raw === "UNIT" || raw === null) {
    // AppSync defaults to UNIT when Kind is omitted.
    return "UNIT";
  }
  return "UNKNOWN";
}
