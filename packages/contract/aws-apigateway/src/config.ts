/**
 * The configuration a manifest reader builds and passes to
 * restApiToSummaries or httpApiToSummaries, whatever format it read.
 *
 * Besides routes, it includes the settings that change behavior:
 * authorizers, CORS, throttling and request validation. Each one adds
 * responses the platform returns that no handler code shows.
 */

/**
 * Where in the source manifest a piece of configuration was written.
 * Inspect and diff use it to point a platform-added response at the line
 * that caused it. The file is always absolute, and the pointer is a hint
 * in the style of a JSON Pointer that nothing validates.
 */
export interface ConfigRef {
  /** Absolute path to the source manifest file. */
  file: string;
  /** Pointer into the manifest, e.g. "Resources/Auth/Properties". */
  pointer: string;
}

/**
 * The platform behaviors that add responses. Each value is the `cause` in
 * a platform transition's metadata, and every cause that lands on one
 * status code is merged into a single transition.
 */
export type PlatformCause =
  | "authorization"
  | "api-key"
  | "request-validation"
  | "throttle"
  | "integration-timeout"
  | "integration-failure"
  | "cors-preflight";

export type AuthorizerType =
  | "iam"
  | "cognito"
  | "lambda-token"
  | "lambda-request"
  | "jwt";

export interface AuthorizerConfig {
  type: AuthorizerType;
  /**
   * When true or unset, missing or invalid credentials return 401 and a
   * denied caller gets 403. When false, anonymous calls pass the
   * authorizer, so only 403 is added.
   */
  identitySourceRequired?: boolean;
  configRef?: ConfigRef;
}

export interface CorsConfig {
  allowOrigins: string[];
  allowMethods: string[];
  allowHeaders?: string[];
  exposeHeaders?: string[];
  allowCredentials?: boolean;
  maxAge?: number;
  configRef?: ConfigRef;
}

export interface ThrottleConfig {
  burstLimit?: number;
  rateLimit?: number;
  configRef?: ConfigRef;
}

export interface RequestValidationConfig {
  body?: boolean;
  params?: boolean;
  headers?: boolean;
  configRef?: ConfigRef;
}

/**
 * The code that implements a declared route. A manifest reader fills it
 * in when it can tell which module and export serve the route, as with a
 * SAM Lambda proxy integration whose `Handler` gives both.
 *
 * This package copies it to `metadata.http.implementingHandler` without
 * reading it, so the checker can match the declared route to the handler
 * summary extracted from that code.
 */
export interface HandlerPointer {
  /** Raw handler reference, e.g. "src/handlers/confirmToken.handler". */
  handler: string;
  /** Module-path portion (before the final dot), e.g. "src/handlers/confirmToken". */
  modulePath: string;
  /** The exported function, e.g. "handler". */
  exportName: string;
  /** Base directory the module path resolves against (SAM CodeUri). */
  codeUri?: string;
  /** Logical id of the function resource that declared the handler. */
  functionLogicalId?: string;
}

export type IntegrationType =
  | "lambda"
  | "lambda-proxy"
  | "http"
  | "http-proxy"
  | "mock"
  | "aws-service"
  | "vpc-link"
  /**
   * The manifest declared an endpoint without an integration type. A
   * reader uses this in place of a guess, and no 502 or 504 is added,
   * because nothing is known about the backend.
   */
  | "unknown";

export interface IntegrationConfig {
  type: IntegrationType;
  /**
   * Status codes the backend can return: what the handler returns for a
   * proxy integration, or what `IntegrationResponses` map to otherwise.
   * An empty array means they are unknown, and only the platform's
   * responses are emitted.
   */
  statusCodes: number[];
  /**
   * The integration timeout from the manifest. Summaries do not read it
   * yet: a 504 is added for every integration that can time out, since
   * the platform cap (29s for REST, 30s for HTTP APIs) always applies.
   */
  timeoutMs?: number;
  configRef?: ConfigRef;
}

/** Configuration for a single REST API endpoint (method + path). */
export interface RestEndpointConfig {
  method: string;
  path: string;
  integration: IntegrationConfig;
  /**
   * Undefined inherits the API's default authorizer, and `null` turns it
   * off for this endpoint.
   */
  authorizer?: AuthorizerConfig | null;
  apiKeyRequired?: boolean;
  requestValidation?: RequestValidationConfig;
  throttle?: ThrottleConfig;
  /** The summary's name. Defaults to `<api id>:<METHOD>:<path>`. */
  name?: string;
  /**
   * The code behind this endpoint, when the manifest says which, as a SAM
   * Lambda proxy `Handler` does. Copied to
   * `metadata.http.implementingHandler`.
   */
  implementingHandler?: HandlerPointer;
  configRef?: ConfigRef;
}

export interface RestApiConfig {
  /** The API's logical id, used in each summary's name. */
  id: string;
  /** Recorded as `SourceLocation.file` on each summary. */
  source?: string;
  endpoints: RestEndpointConfig[];
  /** Applies to every endpoint that does not set its own. */
  defaultAuthorizer?: AuthorizerConfig;
  defaultThrottle?: ThrottleConfig;
  /** Adds an OPTIONS preflight summary for each resource path. */
  cors?: CorsConfig;
  /** Recorded from the manifest. No transition depends on it. */
  binaryMediaTypes?: string[];
}

// An HTTP API (API Gateway v2) route key has the method and path together
// (`POST /foo`), CORS covers the whole API, and fewer authorizer types
// exist, so it gets its own types instead of reusing the REST ones.

export type HttpAuthorizerType = "jwt" | "lambda-request" | "iam";

export interface HttpAuthorizerConfig {
  type: HttpAuthorizerType;
  identitySourceRequired?: boolean;
  configRef?: ConfigRef;
}

export interface HttpRouteConfig {
  /**
   * API Gateway's route key, `"<METHOD> <path>"`, or `"$default"` for the
   * catch-all route. The method and path in the binding are parsed from
   * it, and a `$default` route gets no summary.
   */
  routeKey: string;
  integration: IntegrationConfig;
  authorizer?: HttpAuthorizerConfig | null;
  throttle?: ThrottleConfig;
  name?: string;
  /**
   * The code behind this route, when the manifest says which, as a SAM
   * Lambda proxy `Handler` does. Copied to
   * `metadata.http.implementingHandler`.
   */
  implementingHandler?: HandlerPointer;
  configRef?: ConfigRef;
}

export interface HttpApiConfig {
  id: string;
  source?: string;
  routes: HttpRouteConfig[];
  defaultAuthorizer?: HttpAuthorizerConfig;
  defaultThrottle?: ThrottleConfig;
  cors?: CorsConfig;
}
