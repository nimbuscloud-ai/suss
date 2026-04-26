// config.ts — Normalized, manifest-agnostic configuration shapes.
//
// All readers (CFN, CDK, Terraform) build one of these and hand it to
// restApiToSummaries / httpApiToSummaries. Carry the *behavioral* knobs,
// not just structural identity — authorizers, CORS, throttling, etc.
// produce platform-injected transitions that wouldn't otherwise show up
// in a handler's static summary.

/**
 * Reference back into the source manifest that introduced a piece of
 * configuration. Carried in `Transition.metadata.configRef` so inspect/
 * diff can attribute platform-injected transitions to the file + path
 * where the user authored them. Always emit an absolute file path; the
 * pointer is a JSON-Pointer-ish hint, intentionally not validated.
 */
export interface ConfigRef {
  /** Absolute path to the source manifest file. */
  file: string;
  /** Pointer into the manifest, e.g. "Resources/Auth/Properties". */
  pointer: string;
}

/**
 * One of the well-known platform contracts that produce extra response
 * transitions. Used as the `cause` token in opaque predicates and as a
 * key for collapsing per-status transitions. Closed enum so the checker
 * and renderers can switch on it.
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
   * When true, missing/invalid credentials produce 401; authenticated
   * but denied produces 403. When false, the authorizer is configured
   * but anonymous calls bypass it (mostly relevant for public-fallback
   * IAM and Lambda authorizers with caching off).
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

export type IntegrationType =
  | "lambda"
  | "lambda-proxy"
  | "http"
  | "http-proxy"
  | "mock"
  | "aws-service"
  | "vpc-link"
  /**
   * The manifest declared an endpoint but didn't specify the integration
   * type. We can't claim 502/504 will fire without knowing what's behind
   * the route, so platform-failure transitions are suppressed for this
   * type. Used by manifest readers as a fallback rather than fabricating
   * a guessed integration.
   */
  | "unknown";

export interface IntegrationConfig {
  type: IntegrationType;
  /**
   * Status codes the backend integration can produce. For proxy
   * integrations this is what the handler emits; for non-proxy it's
   * what `IntegrationResponses` map to. Empty array is allowed and
   * means "we don't know" — only platform-injected transitions will
   * be emitted.
   */
  statusCodes: number[];
  /**
   * REST API Gateway hard cap is 29s; HTTP API is 30s. When set,
   * a synthetic 504 is added if the integration could exceed it.
   * Default behavior: emit 504 unconditionally for lambda/http/aws-service
   * integrations because the timeout *can* fire.
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
   * `null` (or undefined) means no authorizer. To opt out of an
   * inherited API-level default, pass `null` explicitly.
   */
  authorizer?: AuthorizerConfig | null;
  apiKeyRequired?: boolean;
  requestValidation?: RequestValidationConfig;
  throttle?: ThrottleConfig;
  /**
   * Optional override label for the synthesized handler name. Defaults
   * to `${method.toUpperCase()} ${path}`.
   */
  name?: string;
  configRef?: ConfigRef;
}

export interface RestApiConfig {
  /** Logical identifier for the API (used in summary identity). */
  id: string;
  /** Recorded as `SourceLocation.file` on each summary. */
  source?: string;
  endpoints: RestEndpointConfig[];
  /** API-level defaults that cascade onto endpoints unless overridden. */
  defaultAuthorizer?: AuthorizerConfig;
  defaultThrottle?: ThrottleConfig;
  /** API-level CORS — produces an OPTIONS endpoint per resource path. */
  cors?: CorsConfig;
  /** Binary media types declared on the API; doesn't affect transitions. */
  binaryMediaTypes?: string[];
}

// HTTP API (API Gateway v2) differs structurally: routes carry the
// method and path together (`POST /foo`), CORS is API-wide rather than
// per-method, and the authorizer set is restricted to JWT + Lambda.
// Express the differences in the type rather than overloading the REST
// shape.

export type HttpAuthorizerType = "jwt" | "lambda-request" | "iam";

export interface HttpAuthorizerConfig {
  type: HttpAuthorizerType;
  identitySourceRequired?: boolean;
  configRef?: ConfigRef;
}

export interface HttpRouteConfig {
  /**
   * Route key in API Gateway's native form: `"<METHOD> <path>"`, or
   * `"$default"` for the catch-all route. The package re-parses this
   * to fill `BoundaryBinding.method` / `path`.
   */
  routeKey: string;
  integration: IntegrationConfig;
  authorizer?: HttpAuthorizerConfig | null;
  throttle?: ThrottleConfig;
  name?: string;
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
