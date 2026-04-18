// @suss/stub-aws-apigateway — Generate behavioral summaries for AWS
// API Gateway (REST + HTTP API) given normalized configuration.
//
// Manifest readers (CFN, CDK, Terraform) are responsible for parsing
// their own format and constructing a RestApiConfig / HttpApiConfig.
// This package owns the resource semantics: which response transitions
// fire given which configuration knobs.

export { httpApiToSummaries } from "./http.js";
export { restApiToSummaries } from "./rest.js";

export type {
  AuthorizerConfig,
  AuthorizerType,
  ConfigRef,
  CorsConfig,
  HttpApiConfig,
  HttpAuthorizerConfig,
  HttpAuthorizerType,
  HttpRouteConfig,
  IntegrationConfig,
  IntegrationType,
  PlatformCause,
  RequestValidationConfig,
  RestApiConfig,
  RestEndpointConfig,
  ThrottleConfig,
} from "./config.js";
