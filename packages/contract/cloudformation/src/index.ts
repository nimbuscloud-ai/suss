// @suss/contract-cloudformation — Generate behavioral summaries from
// CloudFormation / SAM templates.
//
// Three extraction paths run side by side:
//
//   1. Inline-OpenAPI: API Gateway resources whose Properties.Body or
//      Properties.DefinitionBody carries an OpenAPI document. Each body
//      is handed to @suss/contract-openapi.
//
//   2. CFN-native REST: AWS::ApiGateway::RestApi + AWS::ApiGateway::Method
//      + AWS::ApiGateway::Resource resources. The walker resolves the
//      resource graph to derive paths, reads authorization / integration
//      / api-key / validation knobs, and builds a normalized
//      RestApiConfig per RestApi. Delegates to @suss/contract-aws-apigateway
//      for the resource semantics — the CFN package is a *manifest reader*,
//      not a behavior model.
//
//   3. CFN-native HTTP API: AWS::ApiGatewayV2::Api + AWS::ApiGatewayV2::Route
//      + AWS::ApiGatewayV2::Integration + AWS::ApiGatewayV2::Authorizer.
//      Same shape as REST: build HttpApiConfig per Api, delegate.
//
// SAM AWS::Serverless::Function.Events { Api | HttpApi } blocks are
// expanded into synthetic Method / Route entries in the appropriate
// API's config — that's the dominant SAM authoring idiom.
//
// Reading a template from disk reads the templates it embeds too. Each
// document is walked on its own, because a logical id, a SAM `Globals`
// section and a relative path all mean something only inside the
// document that writes them.

import path from "node:path";

import { readRoutingMetadata, withRoutingMetadata } from "@suss/behavioral-ir";
import {
  type AuthorizerConfig,
  type AuthorizerType,
  type CorsConfig,
  type HandlerPointer,
  type HttpApiConfig,
  type HttpAuthorizerConfig,
  type HttpAuthorizerType,
  type HttpRouteConfig,
  httpApiToSummaries,
  type IntegrationConfig,
  type IntegrationType,
  type RestApiConfig,
  type RestEndpointConfig,
  restApiToSummaries,
} from "@suss/contract-aws-apigateway";
import { openApiToSummaries } from "@suss/contract-openapi";
import {
  type CloudFormationResource,
  type CloudFormationTemplate,
  inheritedEnvVars,
  loadTemplateTree,
  parseHandler,
  qualifiedLogicalId,
  refTarget,
  resourcesWithGlobals,
  unfollowedStackMessage,
} from "@suss/manifest-aws";

import { buildAlbFlowSummaries } from "./albFlow.js";
import { buildMessageBusSummaries } from "./messageBus.js";
import { buildRuntimeConfigSummaries } from "./runtimeConfig.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "@suss/contract-openapi";

// Re-exported so existing consumers of the parse layer keep working;
// the canonical home is @suss/manifest-aws.
export {
  type CloudFormationResource,
  type CloudFormationTemplate,
  loadCloudFormationTemplate,
  parseHandler,
  readServerlessFunctions,
  type ServerlessFunctionInfo,
  type ServerlessHttpRoute,
  type ServerlessNonHttpEvent,
} from "@suss/manifest-aws";

export interface CloudFormationToSummariesOptions {
  /** Override the logical source file recorded on each summary. */
  source?: string;
  /**
   * Logical ids of the stack resources leading from the root template
   * down to this document. Empty (the default) for a template nothing
   * embeds. A logical id is unique inside one document, so the stack
   * path is what tells two nested documents' resources apart.
   */
  stackPath?: string[];
}

/**
 * Resource types whose `Body` / `DefinitionBody` typically holds an OpenAPI
 * definition. Each entry names the property to read.
 */
const API_RESOURCE_BODIES: Record<string, "Body" | "DefinitionBody"> = {
  "AWS::ApiGateway::RestApi": "Body",
  "AWS::ApiGatewayV2::Api": "Body",
  "AWS::Serverless::Api": "DefinitionBody",
  "AWS::Serverless::HttpApi": "DefinitionBody",
};

/**
 * Convert an in-memory CloudFormation template into a `BehavioralSummary[]`.
 */
export function cloudFormationToSummaries(
  template: CloudFormationTemplate,
  options: CloudFormationToSummariesOptions = {},
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // Every walk below reads properties, and a SAM section can supply any
  // of them, so the section is applied once here rather than per walk.
  const resources = resourcesWithGlobals(template);

  // 1. Inline OpenAPI walk.
  for (const [logicalId, resource] of Object.entries(resources)) {
    const bodyKey = API_RESOURCE_BODIES[resource.Type ?? ""];
    if (bodyKey === undefined) {
      continue;
    }
    const body = resource.Properties?.[bodyKey];
    if (body === null || typeof body !== "object") {
      continue;
    }
    const sourceLabel =
      options.source !== undefined
        ? `${options.source}:${logicalId}`
        : `cloudformation:${logicalId}`;
    summaries.push(
      ...openApiToSummaries(body as OpenApiSpec, { source: sourceLabel }),
    );
  }

  const sourceFile = options.source ?? "cloudformation";

  // 2. CFN-native REST walk: build one RestApiConfig per AWS::ApiGateway::RestApi
  //    (or one per orphan Method group when no RestApi is declared).
  const restConfigs = buildRestApiConfigs(resources, sourceFile);
  for (const config of restConfigs) {
    summaries.push(...restApiToSummaries(config));
  }

  // 3. CFN-native HTTP API walk: same shape, v2 resource types.
  const httpConfigs = buildHttpApiConfigs(resources, sourceFile);
  for (const config of httpConfigs) {
    summaries.push(...httpApiToSummaries(config));
  }

  // 4. Runtime-config walk: Lambda / ECS task env-var contracts. Each
  //    resource that declares (or implicitly inherits, via platform
  //    injection) an env block emits one runtime-config provider
  //    summary. The pairing checker scopes code reads to these
  //    runtimes via metadata.codeScope.
  summaries.push(
    ...buildRuntimeConfigSummaries(
      resources,
      sourceFile,
      inheritedEnvVars(template),
    ),
  );

  // 5. Message-bus walk: AWS::SQS::Queue resources emit queue provider
  //    summaries; Lambdas with SAM Events:SQS or AWS::Lambda::EventSourceMapping
  //    emit consumer summaries with a queue boundaryBinding. Producer-side
  //    interaction effects from @suss/framework-aws-sqs pair against these.
  summaries.push(...buildMessageBusSummaries(resources, sourceFile));

  // 6. ALB flow walk: listener rules and a listener's own default
  //    action emit routesTo / answers edges with their match recorded
  //    as data; target groups emit fronts edges naming what backs
  //    them. No boundaryBinding, since these are the fact base a
  //    future reachability rule reads, not a pairing the checker
  //    matches today.
  summaries.push(...buildAlbFlowSummaries(resources, sourceFile));

  const stackPath = options.stackPath ?? [];
  return stackPath.length === 0
    ? summaries
    : summaries.map((summary) => deployedWithinStack(summary, stackPath));
}

/**
 * The same summary with the deployed thing it names qualified by the
 * stack path that reaches its document.
 *
 * A logical id is unique within one document and nowhere else, so two
 * nested documents can each declare `HandlerFunction` and mean two
 * different Lambdas. The deployed instance is the identity the checker
 * joins the code side against, so it is the one that has to carry the
 * path. A channel keeps the name its document writes, because a queue
 * name is what the code says and the code cannot know which document
 * declared the queue.
 *
 * A `fronts` edge's `resource` field follows the same rule as
 * `deployableUnit.instanceName`, not the channel rule, because a fronts
 * edge names a deployable unit's own identity (an ECS container's or a
 * Lambda's instanceName): the ALB flow reader and the runtime-config
 * reader must qualify it the same way for the two to still name the
 * same thing once nested. The router and target group logical ids on a
 * routing edge are ALB infrastructure nothing outside the template
 * ever names, so they stay bare, like a channel does.
 */
function deployedWithinStack(
  summary: BehavioralSummary,
  stackPath: string[],
): BehavioralSummary {
  const unit = summary.identity.deployableUnit;
  const binding = summary.identity.boundaryBinding;
  const routing = readRoutingMetadata(summary);
  const frontedResource =
    routing !== undefined &&
    routing.edge === "fronts" &&
    routing.resource !== undefined &&
    routing.resource !== null
      ? routing.resource
      : null;
  if (
    unit === undefined &&
    binding?.semantics.name !== "runtime-config" &&
    frontedResource === null
  ) {
    return summary;
  }
  return {
    ...summary,
    identity: {
      ...summary.identity,
      ...(unit !== undefined
        ? {
            deployableUnit: {
              ...unit,
              instanceName: qualifiedLogicalId(stackPath, unit.instanceName),
            },
          }
        : {}),
      // A runtime-config boundary is keyed on the instance, so the
      // binding holds its own copy of the name and both have to move.
      ...(binding !== null && binding?.semantics.name === "runtime-config"
        ? {
            boundaryBinding: {
              ...binding,
              semantics: {
                ...binding.semantics,
                instanceName: qualifiedLogicalId(
                  stackPath,
                  binding.semantics.instanceName,
                ),
              },
            },
          }
        : {}),
    },
    ...(frontedResource !== null && routing !== undefined
      ? {
          metadata: withRoutingMetadata(summary.metadata, {
            ...routing,
            resource: qualifiedLogicalId(stackPath, frontedResource),
          }),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// REST API config building
// ---------------------------------------------------------------------------

function buildRestApiConfigs(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): RestApiConfig[] {
  // Collect RestApi resources up front so we can look up cascading
  // defaults (CORS settings on Properties, throttle defaults from a
  // companion AWS::ApiGateway::Stage, etc.) when building per-endpoint
  // configs. SAM's AWS::Serverless::Api also lands here — it's the
  // SAM-side authoring shape that transforms into a RestApi.
  const restApis = new Map<string, CloudFormationResource>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (
      resource.Type === "AWS::ApiGateway::RestApi" ||
      resource.Type === "AWS::Serverless::Api"
    ) {
      restApis.set(logicalId, resource);
    }
  }

  // Group Methods by their RestApiId. Methods without a resolvable
  // RestApiId go into the orphan bucket so their endpoints still
  // surface (synthetic API id "RestApi").
  const methodsByApi = new Map<string, string[]>();
  const orphan: string[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ApiGateway::Method") {
      continue;
    }
    const restApiId = refTarget(resource.Properties?.RestApiId);
    if (restApiId !== null && restApis.has(restApiId)) {
      const list = methodsByApi.get(restApiId) ?? [];
      list.push(logicalId);
      methodsByApi.set(restApiId, list);
    } else {
      orphan.push(logicalId);
    }
  }

  const configs: RestApiConfig[] = [];

  // Iterate over every declared RestApi so APIs that exist only via
  // SAM Events (no native Method resources) still produce configs.
  for (const [apiId, api] of restApis) {
    const methodIds = methodsByApi.get(apiId) ?? [];
    configs.push(
      buildRestApiConfig(apiId, api, methodIds, resources, sourceFile),
    );
  }

  if (orphan.length > 0) {
    configs.push(
      buildRestApiConfig("RestApi", undefined, orphan, resources, sourceFile),
    );
  }

  // Drop configs that ended up with zero endpoints (a RestApi resource
  // with no Methods and no matching Events shouldn't produce summaries).
  return configs.filter((c) => c.endpoints.length > 0);
}

function buildRestApiConfig(
  apiId: string,
  api: CloudFormationResource | undefined,
  methodIds: string[],
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): RestApiConfig {
  const endpoints: RestEndpointConfig[] = [];
  const pathByLogicalId = new Map<string, string>();

  function pathFor(logicalId: string): string {
    const cached = pathByLogicalId.get(logicalId);
    if (cached !== undefined) {
      return cached;
    }
    const res = resources[logicalId];
    if (res === undefined || res.Type !== "AWS::ApiGateway::Resource") {
      pathByLogicalId.set(logicalId, "");
      return "";
    }
    const part = String(res.Properties?.PathPart ?? "");
    const parentRef = refTarget(res.Properties?.ParentId);
    const parentPath =
      parentRef !== null &&
      resources[parentRef]?.Type === "AWS::ApiGateway::Resource"
        ? pathFor(parentRef)
        : "";
    const full = `${parentPath}/${part}`;
    pathByLogicalId.set(logicalId, full);
    return full;
  }

  for (const logicalId of methodIds) {
    const resource = resources[logicalId];
    if (resource === undefined) {
      continue;
    }
    const props = resource.Properties ?? {};
    // ANY is API Gateway's spelling of the method wildcard.
    const method = wildcardOrMethod(String(props.HttpMethod ?? ""));
    if (method === null) {
      continue;
    }

    const resourceRef = refTarget(props.ResourceId);
    const path = resourceRef !== null ? pathFor(resourceRef) || "/" : "/";

    const integration = readRestIntegration(
      props.Integration,
      sourceFile,
      logicalId,
    );
    const statusCodes = readMethodResponseStatuses(props.MethodResponses);
    integration.statusCodes = statusCodes;

    const endpoint: RestEndpointConfig = {
      method,
      path,
      integration,
      name: logicalId,
      configRef: { file: sourceFile, pointer: `Resources/${logicalId}` },
    };

    const authorizer = readRestAuthorizer(
      props.AuthorizationType,
      props.AuthorizerId,
      resources,
      sourceFile,
    );
    if (authorizer !== undefined) {
      endpoint.authorizer = authorizer;
    } else if (looksLikeAnonymous(props.AuthorizationType)) {
      // Explicit "NONE" opts out of any inherited default.
      endpoint.authorizer = null;
    }

    if (props.ApiKeyRequired === true) {
      endpoint.apiKeyRequired = true;
    }

    if (refTarget(props.RequestValidatorId) !== null) {
      endpoint.requestValidation = {
        body: true,
        params: true,
        headers: true,
        configRef: { file: sourceFile, pointer: `Resources/${logicalId}` },
      };
    }

    endpoints.push(endpoint);
  }

  // Append SAM Events (AWS::Serverless::Function with Events.Api blocks
  // referencing this RestApi).
  endpoints.push(...readSamApiEvents(apiId, resources, sourceFile));

  const config: RestApiConfig = {
    id: apiId,
    source: sourceFile,
    endpoints,
  };

  // CORS configured at the RestApi level via SAM's CorsConfiguration
  // is the most common authoring shape; raw CFN requires per-method
  // OPTIONS resources, which the manifest already enumerates.
  if (api !== undefined) {
    const cors = readSamRestCors(
      api.Properties?.CorsConfiguration,
      sourceFile,
      apiId,
    );
    if (cors !== null) {
      config.cors = cors;
    }
  }

  return config;
}

function readRestIntegration(
  raw: unknown,
  sourceFile: string,
  ownerId: string,
): IntegrationConfig {
  if (raw === null || typeof raw !== "object") {
    return { type: "unknown", statusCodes: [] };
  }
  const obj = raw as Record<string, unknown>;
  const type = mapRestIntegrationType(obj.Type);
  const integration: IntegrationConfig = {
    type,
    statusCodes: [],
    configRef: {
      file: sourceFile,
      pointer: `Resources/${ownerId}/Integration`,
    },
  };
  if (typeof obj.TimeoutInMillis === "number") {
    integration.timeoutMs = obj.TimeoutInMillis;
  }
  return integration;
}

function mapRestIntegrationType(value: unknown): IntegrationType {
  if (typeof value !== "string") {
    return "unknown";
  }
  switch (value.toUpperCase()) {
    case "AWS_PROXY":
      return "lambda-proxy";
    case "AWS":
      return "lambda";
    case "HTTP":
      return "http";
    case "HTTP_PROXY":
      return "http-proxy";
    case "MOCK":
      return "mock";
    default:
      return "unknown";
  }
}

function readMethodResponseStatuses(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: number[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const code = parseStatus((entry as { StatusCode?: unknown }).StatusCode);
    if (code !== null) {
      out.push(code);
    }
  }
  return out;
}

function readRestAuthorizer(
  authorizationType: unknown,
  authorizerIdRaw: unknown,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): AuthorizerConfig | undefined {
  const at =
    typeof authorizationType === "string"
      ? authorizationType.toUpperCase()
      : "";
  if (at === "" || at === "NONE") {
    return undefined;
  }
  const authorizerId = refTarget(authorizerIdRaw);
  let type: AuthorizerType;
  switch (at) {
    case "AWS_IAM":
      type = "iam";
      break;
    case "COGNITO_USER_POOLS":
      type = "cognito";
      break;
    case "CUSTOM":
      type = readRestAuthorizerType(authorizerId, resources);
      break;
    default:
      // JWT is HTTP API only; if it shows up here treat as cognito-ish.
      type = "cognito";
  }
  const config: AuthorizerConfig = { type };
  if (authorizerId !== null) {
    config.configRef = {
      file: sourceFile,
      pointer: `Resources/${authorizerId}`,
    };
  }
  return config;
}

function readRestAuthorizerType(
  authorizerId: string | null,
  resources: Record<string, CloudFormationResource>,
): AuthorizerType {
  if (authorizerId === null) {
    return "lambda-token";
  }
  const auth = resources[authorizerId];
  if (auth?.Type !== "AWS::ApiGateway::Authorizer") {
    return "lambda-token";
  }
  const t = auth.Properties?.Type;
  if (typeof t === "string" && t.toUpperCase() === "REQUEST") {
    return "lambda-request";
  }
  return "lambda-token";
}

function looksLikeAnonymous(value: unknown): boolean {
  return typeof value === "string" && value.toUpperCase() === "NONE";
}

// ---------------------------------------------------------------------------
// HTTP API config building
// ---------------------------------------------------------------------------

function buildHttpApiConfigs(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): HttpApiConfig[] {
  const apis = new Map<string, CloudFormationResource>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (
      resource.Type === "AWS::ApiGatewayV2::Api" ||
      resource.Type === "AWS::Serverless::HttpApi"
    ) {
      apis.set(logicalId, resource);
    }
  }

  const routesByApi = new Map<string, string[]>();
  const orphan: string[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ApiGatewayV2::Route") {
      continue;
    }
    const apiRef = refTarget(resource.Properties?.ApiId);
    if (apiRef !== null && apis.has(apiRef)) {
      const list = routesByApi.get(apiRef) ?? [];
      list.push(logicalId);
      routesByApi.set(apiRef, list);
    } else {
      orphan.push(logicalId);
    }
  }

  const configs: HttpApiConfig[] = [];

  for (const [apiId, api] of apis) {
    const routeIds = routesByApi.get(apiId) ?? [];
    configs.push(
      buildHttpApiConfig(apiId, api, routeIds, resources, sourceFile),
    );
  }

  if (orphan.length > 0) {
    configs.push(
      buildHttpApiConfig("HttpApi", undefined, orphan, resources, sourceFile),
    );
  }

  return configs.filter((c) => c.routes.length > 0);
}

function buildHttpApiConfig(
  apiId: string,
  api: CloudFormationResource | undefined,
  routeIds: string[],
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): HttpApiConfig {
  const routes: HttpRouteConfig[] = [];
  for (const logicalId of routeIds) {
    const resource = resources[logicalId];
    if (resource === undefined) {
      continue;
    }
    const props = resource.Properties ?? {};
    const routeKey = String(props.RouteKey ?? "").trim();
    if (routeKey === "" || routeKey === "$default") {
      continue;
    }

    // The route's Target attribute references an Integration resource;
    // we use its Type to determine the IntegrationConfig.
    const integration = readHttpIntegration(
      props.Target,
      resources,
      sourceFile,
    );

    const route: HttpRouteConfig = {
      routeKey,
      integration,
      name: logicalId,
      configRef: { file: sourceFile, pointer: `Resources/${logicalId}` },
    };

    const authorizer = readHttpAuthorizer(
      props.AuthorizationType,
      props.AuthorizerId,
      resources,
      sourceFile,
    );
    if (authorizer !== undefined) {
      route.authorizer = authorizer;
    } else if (looksLikeAnonymous(props.AuthorizationType)) {
      route.authorizer = null;
    }

    routes.push(route);
  }

  routes.push(...readSamHttpApiEvents(apiId, resources, sourceFile));

  const config: HttpApiConfig = {
    id: apiId,
    source: sourceFile,
    routes,
  };

  if (api !== undefined) {
    const cors = readSamHttpCors(
      api.Properties?.CorsConfiguration,
      sourceFile,
      apiId,
    );
    if (cors !== null) {
      config.cors = cors;
    }
  }

  return config;
}

function readHttpIntegration(
  target: unknown,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): IntegrationConfig {
  // Target is "integrations/<integrationId>" string. The integrationId
  // can be a Ref/!Sub, but in the most common case it's a literal
  // logical id we can look up.
  const id = parseIntegrationTarget(target);
  if (id === null || resources[id] === undefined) {
    return { type: "unknown", statusCodes: [] };
  }
  const integration = resources[id];
  if (integration.Type !== "AWS::ApiGatewayV2::Integration") {
    return { type: "unknown", statusCodes: [] };
  }
  const props = integration.Properties ?? {};
  const config: IntegrationConfig = {
    type: mapHttpIntegrationType(props.IntegrationType),
    statusCodes: [],
    configRef: { file: sourceFile, pointer: `Resources/${id}` },
  };
  if (typeof props.TimeoutInMillis === "number") {
    config.timeoutMs = props.TimeoutInMillis;
  }
  return config;
}

function parseIntegrationTarget(target: unknown): string | null {
  if (typeof target === "string") {
    const m = /^integrations\/(.+)$/.exec(target.trim());
    return m !== null ? m[1] : null;
  }
  if (target !== null && typeof target === "object") {
    const sub = (target as { "Fn::Sub"?: unknown })["Fn::Sub"];
    if (typeof sub === "string") {
      return parseIntegrationTarget(sub);
    }
    if (Array.isArray(sub) && typeof sub[0] === "string") {
      return parseIntegrationTarget(sub[0]);
    }
  }
  return null;
}

function mapHttpIntegrationType(value: unknown): IntegrationType {
  if (typeof value !== "string") {
    return "unknown";
  }
  switch (value.toUpperCase()) {
    case "AWS_PROXY":
      return "lambda-proxy";
    case "HTTP_PROXY":
      return "http-proxy";
    case "MOCK":
      return "mock";
    default:
      return "unknown";
  }
}

function readHttpAuthorizer(
  authorizationType: unknown,
  authorizerIdRaw: unknown,
  _resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): HttpAuthorizerConfig | undefined {
  const at =
    typeof authorizationType === "string"
      ? authorizationType.toUpperCase()
      : "";
  if (at === "" || at === "NONE") {
    return undefined;
  }
  const authorizerId = refTarget(authorizerIdRaw);
  let type: HttpAuthorizerType;
  switch (at) {
    case "AWS_IAM":
      type = "iam";
      break;
    case "JWT":
      type = "jwt";
      break;
    case "CUSTOM":
      type = "lambda-request";
      break;
    default:
      type = "jwt";
  }
  const config: HttpAuthorizerConfig = { type };
  if (authorizerId !== null) {
    config.configRef = {
      file: sourceFile,
      pointer: `Resources/${authorizerId}`,
    };
  }
  return config;
}

// ---------------------------------------------------------------------------
// SAM Events block expansion
// ---------------------------------------------------------------------------
//
// AWS::Serverless::Function declares per-Lambda Events of type Api or
// HttpApi. This is the dominant SAM authoring idiom — instead of separate
// AWS::ApiGateway::Method resources, the routes are attached directly to
// each Function. We expand them into the same RestEndpointConfig /
// HttpRouteConfig shapes the manual Method walks produce.

/**
 * Build a code pointer from a Serverless::Function's Handler / CodeUri
 * so the declared route summary can name the implementation. Returns
 * undefined when the Handler isn't a parseable `module.export` string.
 */
function readHandlerPointer(
  fnId: string,
  resource: CloudFormationResource,
): HandlerPointer | undefined {
  const handlerRaw = resource.Properties?.Handler;
  if (typeof handlerRaw !== "string") {
    return undefined;
  }
  const parsed = parseHandler(handlerRaw);
  if (parsed === null) {
    return undefined;
  }
  const codeUri = resource.Properties?.CodeUri;
  return {
    handler: handlerRaw,
    modulePath: parsed.modulePath,
    exportName: parsed.exportName,
    functionLogicalId: fnId,
    ...(typeof codeUri === "string" ? { codeUri } : {}),
  };
}

function readSamApiEvents(
  apiId: string,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): RestEndpointConfig[] {
  const out: RestEndpointConfig[] = [];
  for (const [fnId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function") {
      continue;
    }
    const events = resource.Properties?.Events;
    if (
      events === null ||
      typeof events !== "object" ||
      Array.isArray(events)
    ) {
      continue;
    }
    for (const [eventId, raw] of Object.entries(
      events as Record<string, unknown>,
    )) {
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const event = raw as {
        Type?: unknown;
        Properties?: Record<string, unknown>;
      };
      if (event.Type !== "Api") {
        continue;
      }
      const props = event.Properties ?? {};
      const restApiRef = refTarget(props.RestApiId);
      if (restApiRef !== null && restApiRef !== apiId) {
        continue;
      }
      // No RestApiId → goes onto the implicit ServerlessRestApi; only
      // emit if we're building the orphan / implicit api config.
      if (restApiRef === null && apiId !== "RestApi" && !resources[apiId]) {
        continue;
      }
      const method = wildcardOrMethod(String(props.Method ?? ""));
      const path = String(props.Path ?? "");
      if (method === null || path === "") {
        continue;
      }
      const implementingHandler = readHandlerPointer(fnId, resource);
      out.push({
        method,
        path,
        integration: {
          type: "lambda-proxy",
          statusCodes: [],
          configRef: { file: sourceFile, pointer: `Resources/${fnId}` },
        },
        name: `${fnId}:${eventId}`,
        ...(implementingHandler !== undefined ? { implementingHandler } : {}),
        configRef: {
          file: sourceFile,
          pointer: `Resources/${fnId}/Events/${eventId}`,
        },
      });
    }
  }
  return out;
}

function readSamHttpApiEvents(
  apiId: string,
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): HttpRouteConfig[] {
  const out: HttpRouteConfig[] = [];
  for (const [fnId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::Serverless::Function") {
      continue;
    }
    const events = resource.Properties?.Events;
    if (
      events === null ||
      typeof events !== "object" ||
      Array.isArray(events)
    ) {
      continue;
    }
    for (const [eventId, raw] of Object.entries(
      events as Record<string, unknown>,
    )) {
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const event = raw as {
        Type?: unknown;
        Properties?: Record<string, unknown>;
      };
      if (event.Type !== "HttpApi") {
        continue;
      }
      const props = event.Properties ?? {};
      const apiRef = refTarget(props.ApiId);
      if (apiRef !== null && apiRef !== apiId) {
        continue;
      }
      if (apiRef === null && apiId !== "HttpApi" && !resources[apiId]) {
        continue;
      }
      const method = wildcardOrMethod(String(props.Method ?? ""));
      const pathProp = String(props.Path ?? "");
      if (method === null || pathProp === "") {
        continue;
      }
      const implementingHandler = readHandlerPointer(fnId, resource);
      out.push({
        routeKey: `${method} ${pathProp}`,
        integration: {
          type: "lambda-proxy",
          statusCodes: [],
          configRef: { file: sourceFile, pointer: `Resources/${fnId}` },
        },
        name: `${fnId}:${eventId}`,
        ...(implementingHandler !== undefined ? { implementingHandler } : {}),
        configRef: {
          file: sourceFile,
          pointer: `Resources/${fnId}/Events/${eventId}`,
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CORS readers
// ---------------------------------------------------------------------------

function readSamRestCors(
  raw: unknown,
  sourceFile: string,
  apiId: string,
): CorsConfig | null {
  return readCors(raw, sourceFile, apiId);
}

function readSamHttpCors(
  raw: unknown,
  sourceFile: string,
  apiId: string,
): CorsConfig | null {
  return readCors(raw, sourceFile, apiId);
}

function readCors(
  raw: unknown,
  sourceFile: string,
  apiId: string,
): CorsConfig | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  // SAM CorsConfiguration can be a string (single allowed origin) or an
  // object with AllowOrigins/AllowMethods/etc. arrays.
  if (typeof raw === "string") {
    return {
      allowOrigins: [raw],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      configRef: {
        file: sourceFile,
        pointer: `Resources/${apiId}/CorsConfiguration`,
      },
    };
  }
  if (typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const allowOrigins =
    readStringArray(obj.AllowOrigins) ?? readStringArray(obj.AllowOrigin);
  const allowMethods = readStringArray(obj.AllowMethods);
  if (allowOrigins === null) {
    return null;
  }
  const cors: CorsConfig = {
    allowOrigins,
    allowMethods: allowMethods ?? [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "OPTIONS",
    ],
    configRef: {
      file: sourceFile,
      pointer: `Resources/${apiId}/CorsConfiguration`,
    },
  };
  const allowHeaders = readStringArray(obj.AllowHeaders);
  if (allowHeaders !== null) {
    cors.allowHeaders = allowHeaders;
  }
  const exposeHeaders = readStringArray(obj.ExposeHeaders);
  if (exposeHeaders !== null) {
    cors.exposeHeaders = exposeHeaders;
  }
  if (obj.AllowCredentials === true) {
    cors.allowCredentials = true;
  }
  if (typeof obj.MaxAge === "number") {
    cors.maxAge = obj.MaxAge;
  }
  return cors;
}

/**
 * A template's HTTP method as a binding method: `ANY` is API
 * Gateway's spelling of the method wildcard, and a blank method is a
 * malformed template with nothing to bind.
 */
function wildcardOrMethod(raw: string): string | null {
  const method = raw.toUpperCase();
  if (method === "") {
    return null;
  }
  return method === "ANY" ? "*" : method;
}

function readStringArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const v of value) {
    if (typeof v === "string") {
      out.push(v);
    }
  }
  return out.length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// CFN reference helpers
// ---------------------------------------------------------------------------

function parseStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

/**
 * Load a CloudFormation template from disk, along with every template
 * it embeds through a stack resource, and convert them all into
 * behavioral summaries. Format is detected by extension; `.json` is
 * parsed as JSON, everything else (including `.yaml`/`.yml`/`.template`)
 * goes through the YAML parser.
 *
 * A child the reader could not open is reported on stderr and named,
 * so it reads as a template we did not get to rather than a template
 * that declares nothing.
 */
export function cloudFormationFileToSummaries(
  templatePath: string,
  options: CloudFormationToSummariesOptions = {},
): BehavioralSummary[] {
  const tree = loadTemplateTree(templatePath);
  for (const stack of tree.unfollowed) {
    process.stderr.write(
      `[suss] cloudformation: ${unfollowedStackMessage(stack)}\n`,
    );
  }
  const rootLabel =
    options.source ??
    `cloudformation:${path.basename(path.resolve(templatePath))}`;
  return tree.documents.flatMap((document) =>
    cloudFormationToSummaries(document.template, {
      source: documentLabel(rootLabel, document.stackPath),
      stackPath: document.stackPath,
    }),
  );
}

/**
 * The label summaries from one document carry. The root keeps the label
 * the caller asked for, and a child adds the path that reaches it,
 * which stays distinct even when two stack resources embed one file.
 */
function documentLabel(rootLabel: string, stackPath: string[]): string {
  return stackPath.length === 0
    ? rootLabel
    : `${rootLabel}#${stackPath.join("/")}`;
}
