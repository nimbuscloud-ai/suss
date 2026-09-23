/**
 * @suss/contract-aws-apigateway builds summaries for AWS API Gateway REST
 * and HTTP APIs from a normalized configuration.
 *
 * A manifest reader such as the CloudFormation pack parses its own format
 * and builds a RestApiConfig or HttpApiConfig. This package decides which
 * responses the platform adds for each configuration setting.
 */

export { httpApiToSummaries } from "./http.js";
export { restApiToSummaries } from "./rest.js";

export type {
  AuthorizerConfig,
  AuthorizerType,
  ConfigRef,
  CorsConfig,
  HandlerPointer,
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
