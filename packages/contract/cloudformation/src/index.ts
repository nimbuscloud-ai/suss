/**
 * Builds summaries from a CloudFormation or SAM template, with one walk
 * per family of resources in cloudFormationToSummaries.
 *
 * For API Gateway this package only reads the template. It builds a
 * RestApiConfig or HttpApiConfig, including one entry per SAM `Events`
 * route, and @suss/contract-aws-apigateway decides what the platform
 * adds.
 *
 * Reading a template from disk also reads the templates it embeds. Each
 * document is walked on its own, because a logical id, a SAM `Globals`
 * section and a relative path only mean something inside their document.
 */

import {
  nestedDocumentLabel,
  readRoutingMetadata,
  withRoutingMetadata,
} from "@suss/behavioral-ir";
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
import { buildDnsFlowSummaries } from "./dnsFlow.js";
import { documentSourceLabel } from "./documentLabel.js";
import { buildDynamoTableSummaries } from "./dynamoTables.js";
import { buildMessageBusSummaries } from "./messageBus.js";
import { buildRuntimeConfigSummaries } from "./runtimeConfig.js";

import type { BehavioralSummary, RoutingMetadata } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "@suss/contract-openapi";

// These live in @suss/manifest-aws. Callers that import them from this
// package still get them.
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

export { ALB_MATCH_LANGUAGE, albRouterSelector } from "./albMatch.js";
// A document's label decides which flow scope its resources join, so
// every manifest reader has to label documents the same way.
export { documentSourceLabel } from "./documentLabel.js";
// @suss/contract-serverless runs this walk over SAM-shaped resources, so
// both readers record environment variables the same way.
export { buildRuntimeConfigSummaries } from "./runtimeConfig.js";

export interface CloudFormationToSummariesOptions {
  /** The source label recorded on each summary, in place of the default. */
  source?: string;
  /**
   * Logical ids of the stack resources from the root template down to
   * this document, empty for a template nothing embeds. Logical ids are
   * only unique within one document, so this path keeps two nested
   * documents' resources apart.
   */
  stackPath?: string[];
  /**
   * The `recognition` recorded on each binding. A manifest format that
   * compiles to these resource types passes its own name, so the summary
   * points at the file a person wrote. Defaults to "cloudformation".
   */
  recognition?: string;
}

// Resource types whose `Body` or `DefinitionBody` usually contains an
// OpenAPI definition.
const API_RESOURCE_BODIES: Record<string, "Body" | "DefinitionBody"> = {
  "AWS::ApiGateway::RestApi": "Body",
  "AWS::ApiGatewayV2::Api": "Body",
  "AWS::Serverless::Api": "DefinitionBody",
  "AWS::Serverless::HttpApi": "DefinitionBody",
};

/** Summaries for one CloudFormation template already in memory. */
export function cloudFormationToSummaries(
  template: CloudFormationTemplate,
  options: CloudFormationToSummariesOptions = {},
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  // SAM Globals can supply any property a walk below reads, so they are
  // applied once up front.
  const resources = resourcesWithGlobals(template);
  const recognition = options.recognition ?? "cloudformation";

  // 1. OpenAPI documents inline in an API resource.
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

  // 2. One RestApiConfig per RestApi, plus one for Methods with no RestApi.
  const restConfigs = buildRestApiConfigs(resources, sourceFile);
  for (const config of restConfigs) {
    summaries.push(...restApiToSummaries(config));
  }

  // 3. The same for HTTP APIs (API Gateway v2).
  const httpConfigs = buildHttpApiConfigs(resources, sourceFile);
  for (const config of httpConfigs) {
    summaries.push(...httpApiToSummaries(config));
  }

  // 4. Environment variables for each Lambda function and ECS container.
  summaries.push(
    ...buildRuntimeConfigSummaries(
      resources,
      sourceFile,
      inheritedEnvVars(template),
      recognition,
    ),
  );

  // 5. SQS, SNS, EventBridge and S3 notification channels and consumers.
  summaries.push(
    ...buildMessageBusSummaries(resources, sourceFile, recognition),
  );

  // 6. Load balancer and DNS routing edges for the reachability walk.
  summaries.push(...buildAlbFlowSummaries(resources, sourceFile));
  summaries.push(...buildDnsFlowSummaries(resources, sourceFile));

  // 7. DynamoDB tables and their secondary indexes.
  summaries.push(
    ...buildDynamoTableSummaries(resources, sourceFile, recognition),
  );

  const stackPath = options.stackPath ?? [];
  return stackPath.length === 0
    ? summaries
    : summaries.map((summary) =>
        deployedWithinStack(summary, stackPath, resources),
      );
}

/**
 * Prefixes the deployed instance a summary belongs to with the stack
 * path that leads to its document. The README explains why the instance
 * gets the path and a channel does not.
 *
 * A `fronts` edge that points at a Lambda or an ECS container gets the
 * same prefix, so it still matches the runtime-config summary for that
 * unit. An edge that points at another load balancer stays bare, like the
 * other ALB logical ids, since nothing outside the template refers to it.
 */
function deployedWithinStack(
  summary: BehavioralSummary,
  stackPath: string[],
  resources: Record<string, CloudFormationResource>,
): BehavioralSummary {
  const unit = summary.identity.deployableUnit;
  const binding = summary.identity.boundaryBinding;
  const routing = readRoutingMetadata(summary);
  const frontedResource =
    routing !== undefined ? frontedUnitResource(routing, resources) : null;
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
      // A runtime-config binding has its own copy of the instance name,
      // so it gets the prefix too.
      ...(binding !== null &&
      binding.semantics.name === "runtime-config" &&
      binding.semantics.instanceName !== undefined
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

// The resource of a `fronts` edge that needs the stack path, or null for
// any other edge, an unresolved one, or one that points at a load balancer.
function frontedUnitResource(
  routing: RoutingMetadata,
  resources: Record<string, CloudFormationResource>,
): string | null {
  if (
    routing.edge !== "fronts" ||
    routing.resource === undefined ||
    routing.resource === null
  ) {
    return null;
  }

  const declared = resources[routing.resource];
  if (declared?.Type === "AWS::ElasticLoadBalancingV2::LoadBalancer") {
    return null;
  }

  return routing.resource;
}

// ---------------------------------------------------------------------------
// REST API config building
// ---------------------------------------------------------------------------

function buildRestApiConfigs(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): RestApiConfig[] {
  // SAM's AWS::Serverless::Api becomes a RestApi when deployed, so it
  // counts as one here.
  const restApis = new Map<string, CloudFormationResource>();
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (
      resource.Type === "AWS::ApiGateway::RestApi" ||
      resource.Type === "AWS::Serverless::Api"
    ) {
      restApis.set(logicalId, resource);
    }
  }

  // A Method whose RestApiId does not resolve still gets a summary, under
  // an API with the made-up id "RestApi".
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

  // An API whose routes all come from SAM Events has no Methods, so every
  // RestApi gets a config.
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
  // Null when some PathPart on the way is computed, so no path is known.
  const pathByLogicalId = new Map<string, string | null>();

  function pathFor(logicalId: string): string | null {
    const cached = pathByLogicalId.get(logicalId);
    if (cached !== undefined) {
      return cached;
    }
    const res = resources[logicalId];
    if (res === undefined || res.Type !== "AWS::ApiGateway::Resource") {
      pathByLogicalId.set(logicalId, "");
      return "";
    }
    const part = plainString(res.Properties?.PathPart);
    const parentRef = refTarget(res.Properties?.ParentId);
    const parentPath =
      parentRef !== null &&
      resources[parentRef]?.Type === "AWS::ApiGateway::Resource"
        ? pathFor(parentRef)
        : "";
    const full =
      part === null || parentPath === null ? null : `${parentPath}/${part}`;
    pathByLogicalId.set(logicalId, full);
    return full;
  }

  for (const logicalId of methodIds) {
    const resource = resources[logicalId];
    if (resource === undefined) {
      continue;
    }
    const props = resource.Properties ?? {};
    const method = wildcardOrMethod(plainString(props.HttpMethod) ?? "");
    if (method === null) {
      continue;
    }

    const resourceRef = refTarget(props.ResourceId);
    const resolvedPath = resourceRef !== null ? pathFor(resourceRef) : "";
    if (resolvedPath === null) {
      continue;
    }
    const path = resolvedPath === "" ? "/" : resolvedPath;

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
      // "NONE" turns off any default authorizer the API sets.
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

  endpoints.push(...readSamApiEvents(apiId, resources, sourceFile));

  const config: RestApiConfig = {
    id: apiId,
    source: sourceFile,
    endpoints,
  };

  // Only SAM has an API-wide CorsConfiguration. Plain CloudFormation
  // declares OPTIONS Methods, which the loop above already read.
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
      // Any other type, JWT included, is treated like Cognito: a 401 and
      // a 403 either way.
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
    const routeKey = (plainString(props.RouteKey) ?? "").trim();
    if (routeKey === "" || routeKey === "$default") {
      continue;
    }

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
  // A route's Target is "integrations/<logical id>", written as a string
  // or inside an `Fn::Sub`.
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

// Undefined when the Handler is not a `module.export` string.
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
      // An event with no RestApiId belongs to SAM's implicit API. Every
      // config here is "RestApi" or a declared API, so this never skips one.
      if (restApiRef === null && apiId !== "RestApi" && !resources[apiId]) {
        continue;
      }
      const method = wildcardOrMethod(plainString(props.Method) ?? "");
      const path = plainString(props.Path) ?? "";
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
      const method = wildcardOrMethod(plainString(props.Method) ?? "");
      const pathProp = plainString(props.Path) ?? "";
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
  // SAM accepts a single origin string or an object of arrays.
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

// Null for a value computed with an intrinsic. Turning one into a string
// put "[object Object]" into route identities (#127).
function plainString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// `ANY` is API Gateway's method wildcard. A blank method has nothing to bind.
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
 * Summaries for a template on disk and every template it embeds through
 * a stack resource. A `.json` file is parsed as JSON, and any other
 * extension as YAML.
 *
 * A child template that cannot be opened is reported on stderr by name,
 * so nobody mistakes it for a template that declares nothing.
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
    options.source ?? documentSourceLabel("cloudformation", templatePath);
  return tree.documents.flatMap((document) =>
    cloudFormationToSummaries(document.template, {
      source: nestedDocumentLabel(rootLabel, document.stackPath),
      stackPath: document.stackPath,
    }),
  );
}
