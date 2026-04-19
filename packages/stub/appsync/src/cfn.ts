// cfn.ts — CloudFormation template traversal for AppSync resources.
//
// AppSync resource model in CFN:
//   AWS::AppSync::GraphQLApi        — the API itself (auth config, name)
//   AWS::AppSync::GraphQLSchema     — SDL (inline Definition or S3)
//   AWS::AppSync::Resolver          — binds (TypeName, FieldName) → DataSource
//   AWS::AppSync::FunctionConfiguration — pipeline sub-functions (deferred)
//   AWS::AppSync::DataSource        — where resolvers read from / write to
//
// v0 scope: inline schema Definitions, UNIT resolvers (not pipeline),
// static TypeName/FieldName values. Dynamic intrinsic resolution (!Ref
// to a parameter, !Join of a dynamic string) is left as a follow-up —
// matches the posture of the existing aws-apigateway stub.

export interface CfnTemplate {
  Resources?: Record<string, CfnResource | undefined>;
}

export interface CfnResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

export interface AppSyncApi {
  logicalId: string;
  name: string | null;
  /** Inline SDL from the associated GraphQLSchema resource (null when absent / only-S3). */
  schemaSdl: string | null;
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
}

export interface AppSyncFunction {
  logicalId: string;
  apiLogicalId: string | null;
  name: string | null;
  dataSourceLogicalId: string | null;
}

export interface AppSyncConfig {
  apis: AppSyncApi[];
  resolvers: AppSyncResolver[];
  functions: AppSyncFunction[];
}

/**
 * Walk a CloudFormation template and collect AppSync APIs + resolvers.
 * Unknown / malformed entries are skipped rather than thrown — a
 * template can mix AppSync with unrelated resources, and a partial
 * AppSync block shouldn't fail the whole read.
 */
export function readAppSyncFromCfn(template: CfnTemplate): AppSyncConfig {
  const resources = template.Resources ?? {};
  const apis = collectApis(resources);
  const resolvers = collectResolvers(resources);
  const functions = collectFunctions(resources);
  return { apis, resolvers, functions };
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
      schemaSdl: schemaByApi.get(logicalId) ?? null,
      authenticationType: stringField(props.AuthenticationType),
    });
  }
  return apis;
}

/**
 * Build `apiLogicalId -> inline SDL` from every GraphQLSchema
 * resource's `ApiId` back-reference. Resources that use
 * `DefinitionS3Location` rather than inline `Definition` stay unmapped
 * (the stub has no S3 fetcher by design — that'd pull the whole
 * package into AWS SDK territory).
 */
function indexSchemasByApi(
  resources: Record<string, CfnResource | undefined>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const resource of Object.values(resources)) {
    if (resource?.Type !== "AWS::AppSync::GraphQLSchema") {
      continue;
    }
    const props = resource.Properties ?? {};
    const apiRef = resolveLogicalRef(props.ApiId);
    const sdl = stringField(props.Definition);
    if (apiRef !== null && sdl !== null) {
      out.set(apiRef, sdl);
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
  if (pipelineConfig === null || typeof pipelineConfig !== "object") {
    return [];
  }
  const functions = (pipelineConfig as { Functions?: unknown }).Functions;
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
    });
  }
  return out;
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

/**
 * Resolve a CFN "reference-to-another-resource" field to its logical
 * ID when possible. Accepts:
 *   - `{ Ref: "LogicalId" }` — the canonical form
 *   - `{ "Fn::GetAtt": ["LogicalId", "..."] }` — when a resolver uses
 *     `!GetAtt Api.ApiId` to reference the API's computed ApiId
 *   - bare string — when a template author uses raw logical IDs
 *     (uncommon but legal)
 *
 * Dynamic references (`!Sub`, `!Join`, !ImportValue`) return null —
 * the stub can't resolve across deployment-time values statically.
 */
function resolveLogicalRef(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const ref = obj.Ref;
  if (typeof ref === "string") {
    return ref;
  }
  const getAtt = obj["Fn::GetAtt"];
  if (
    Array.isArray(getAtt) &&
    getAtt.length > 0 &&
    typeof getAtt[0] === "string"
  ) {
    return getAtt[0];
  }
  return null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
