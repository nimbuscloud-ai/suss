/**
 * Reads the raw AWS::AppSync resources in a template and adds what the
 * SAM AWS::Serverless::GraphQLApi reader finds, so both ways of writing
 * an API reach the summary builder as one model.
 *
 * A value written with a dynamic intrinsic is left unresolved and
 * reported. The reader never guesses it. A `!Ref` to a parameter the
 * parent stack sets to a resource is read as that resource, which is how
 * a nested stack's resolvers find the API their parent declares.
 */

import { apiScopedKey } from "@suss/manifest-aws";

import {
  asRecord,
  type DocumentRefs,
  OWN_DOCUMENT,
  stringField,
} from "./refs.js";
import { readServerlessGraphQLApis } from "./sam.js";

export interface CfnTemplate {
  Resources?: Record<string, CfnResource | undefined>;
}

export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

/**
 * How the template declares an API's SDL, before anything is read from
 * disk. `location` is the `DefinitionS3Location` or `SchemaUri` string as
 * written, either a local path or a remote URI.
 */
export type RawSchemaSource =
  | { kind: "inline"; sdl: string }
  | { kind: "location"; location: string }
  | { kind: "computed" }
  | { kind: "absent" };

export interface AppSyncApi {
  logicalId: string;
  name: string | null;
  schemaSource: RawSchemaSource;
  authenticationType: string | null;
}

export interface AppSyncResolver extends DataSourceReference {
  logicalId: string;
  typeName: string;
  fieldName: string;
  /** `"UNKNOWN"` when the template sets a Kind AppSync does not define. */
  kind: "UNIT" | "PIPELINE" | "UNKNOWN";
  /**
   * The FunctionConfiguration logical ids a pipeline runs, in order. Empty
   * when the list cannot be read statically; `kind` stays `"PIPELINE"`.
   */
  pipelineFunctionLogicalIds: string[];
  /**
   * Where a SAM resolver's JS or VTL code lives, so the summary can later
   * be matched to it. Null on a raw resolver, whose mapping templates are
   * separate properties.
   */
  codeUri: string | null;
  runtime: string | null;
}

export interface AppSyncFunction extends DataSourceReference {
  logicalId: string;
  name: string | null;
  codeUri: string | null;
  runtime: string | null;
}

/**
 * `lambdaFunctionLogicalId` is set for a Lambda data source, from the raw
 * `LambdaConfig.LambdaFunctionArn` or the SAM
 * `DataSources.Lambdas.<name>.FunctionArn`, so a resolver summary can be
 * matched to the handler code behind it.
 */
export interface AppSyncDataSource {
  logicalId: string;
  apiLogicalId: string | null;
  /** The `Name` a resolver can refer to it by, within its API. */
  name: string | null;
  /**
   * The AppSync type in lowercase, such as `"lambda"`, or `"unknown"` for
   * a type AppSync does not define.
   */
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
 * Collects AppSync APIs, resolvers, functions and data sources from both
 * the raw resources and the SAM shorthand. An entry missing a required
 * field is skipped, so one partial block does not fail the whole read.
 * `refs` qualifies every logical id by the document it comes from.
 */
export function readAppSyncFromCfn(
  template: CfnTemplate,
  refs: DocumentRefs = OWN_DOCUMENT,
): AppSyncConfig {
  const resources = template.Resources ?? {};
  const raw: AppSyncConfig = {
    apis: collectApis(resources, refs),
    resolvers: collectResolvers(resources, refs),
    functions: collectFunctions(resources, refs),
    dataSources: collectDataSources(resources, refs),
  };
  const sam = readServerlessGraphQLApis(resources, refs);
  return {
    apis: [...raw.apis, ...sam.apis],
    resolvers: [...raw.resolvers, ...sam.resolvers],
    functions: [...raw.functions, ...sam.functions],
    dataSources: [...raw.dataSources, ...sam.dataSources],
  };
}

/** Several documents of one stack tree, read as one model. */
export function mergeConfigs(configs: AppSyncConfig[]): AppSyncConfig {
  const merged: AppSyncConfig = {
    apis: configs.flatMap((c) => c.apis),
    resolvers: configs.flatMap((c) => c.resolvers),
    functions: configs.flatMap((c) => c.functions),
    dataSources: configs.flatMap((c) => c.dataSources),
  };
  return withDataSourcesByName(merged);
}

/**
 * A resolver or a function can name its data source by the `Name`
 * property instead of the logical id, and a name means something only
 * within one API. A reference that is not a data source's logical id is
 * looked up by name against the referring resource's own API.
 */
function withDataSourcesByName(config: AppSyncConfig): AppSyncConfig {
  const byId = new Set(config.dataSources.map((ds) => ds.logicalId));
  const byName = new Map<string, string>();
  for (const ds of config.dataSources) {
    if (ds.name !== null) {
      byName.set(apiScopedKey(ds.apiLogicalId, ds.name), ds.logicalId);
    }
  }
  const resolve = <T extends DataSourceReference>(entry: T): T => {
    const { dataSourceLogicalId, dataSourceWritten } = entry;
    if (dataSourceLogicalId !== null && byId.has(dataSourceLogicalId)) {
      return entry;
    }
    const named =
      dataSourceWritten === null
        ? undefined
        : byName.get(apiScopedKey(entry.apiLogicalId, dataSourceWritten));
    return named === undefined
      ? entry
      : { ...entry, dataSourceLogicalId: named };
  };
  return {
    ...config,
    resolvers: config.resolvers.map(resolve),
    functions: config.functions.map(resolve),
  };
}

/** A resolver or a function, which both point at a data source. */
export interface DataSourceReference {
  apiLogicalId: string | null;
  dataSourceLogicalId: string | null;
  /**
   * `DataSourceName` when it is a plain string, which is either a data
   * source's logical id or its `Name`. Null for a reference.
   */
  dataSourceWritten: string | null;
}

function collectApis(
  resources: Record<string, CfnResource | undefined>,
  refs: DocumentRefs,
): AppSyncApi[] {
  const apis: AppSyncApi[] = [];
  const schemaByApi = indexSchemasByApi(resources, refs);

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::GraphQLApi") {
      continue;
    }
    const props = resource.Properties ?? {};
    const id = refs.own(logicalId);
    apis.push({
      logicalId: id,
      name: stringField(props.Name),
      schemaSource: schemaByApi.get(id) ?? { kind: "absent" },
      authenticationType: stringField(props.AuthenticationType),
    });
  }
  return apis;
}

/** A GraphQLSchema resource points back at its API through `ApiId`. */
function indexSchemasByApi(
  resources: Record<string, CfnResource | undefined>,
  refs: DocumentRefs,
): Map<string, RawSchemaSource> {
  const out = new Map<string, RawSchemaSource>();
  for (const resource of Object.values(resources)) {
    if (resource?.Type !== "AWS::AppSync::GraphQLSchema") {
      continue;
    }
    const props = resource.Properties ?? {};
    const apiRef = refs.ref(props.ApiId);
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
      continue;
    }

    // A schema set through an intrinsic, such as `!Sub` on the S3 URI,
    // still exists. Recording it as computed keeps it apart from an API
    // that declares no schema.
    if (
      props.Definition !== undefined ||
      props.DefinitionS3Location !== undefined
    ) {
      out.set(apiRef, { kind: "computed" });
    }
  }
  return out;
}

function collectResolvers(
  resources: Record<string, CfnResource | undefined>,
  refs: DocumentRefs,
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
      logicalId: refs.own(logicalId),
      apiLogicalId: refs.ref(props.ApiId),
      typeName,
      fieldName,
      dataSourceLogicalId: refs.ref(props.DataSourceName),
      dataSourceWritten: stringField(props.DataSourceName),
      kind: resolverKind(stringField(props.Kind)),
      pipelineFunctionLogicalIds: pipelineFunctionIds(
        props.PipelineConfig,
        refs,
      ),
      codeUri: null,
      runtime: null,
    });
  }
  return out;
}

/**
 * An entry is usually `!GetAtt Fn.FunctionId`, which reduces to the
 * logical id `Fn`. An entry only known at deploy time, such as `Fn::Sub`,
 * is dropped.
 */
function pipelineFunctionIds(
  pipelineConfig: unknown,
  refs: DocumentRefs,
): string[] {
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
    const ref = refs.ref(entry);
    if (ref !== null) {
      out.push(ref);
    }
  }
  return out;
}

function collectFunctions(
  resources: Record<string, CfnResource | undefined>,
  refs: DocumentRefs,
): AppSyncFunction[] {
  const out: AppSyncFunction[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::FunctionConfiguration") {
      continue;
    }
    const props = resource.Properties ?? {};
    out.push({
      logicalId: refs.own(logicalId),
      apiLogicalId: refs.ref(props.ApiId),
      name: stringField(props.Name),
      dataSourceLogicalId: refs.ref(props.DataSourceName),
      dataSourceWritten: stringField(props.DataSourceName),
      codeUri: null,
      runtime: null,
    });
  }
  return out;
}

function collectDataSources(
  resources: Record<string, CfnResource | undefined>,
  refs: DocumentRefs,
): AppSyncDataSource[] {
  const out: AppSyncDataSource[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource?.Type !== "AWS::AppSync::DataSource") {
      continue;
    }
    const props = resource.Properties ?? {};
    const lambdaConfig = asRecord(props.LambdaConfig);
    out.push({
      logicalId: refs.own(logicalId),
      apiLogicalId: refs.ref(props.ApiId),
      name: stringField(props.Name),
      type: dataSourceType(stringField(props.Type)),
      lambdaFunctionLogicalId:
        lambdaConfig === null ? null : refs.ref(lambdaConfig.LambdaFunctionArn),
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
