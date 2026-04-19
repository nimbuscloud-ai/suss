// shared.ts — Helpers used by both REST (v1) and HTTP API (v2).
// REST and HTTP API differ in routing structure (per-method+path vs
// `<METHOD> <path>` route keys) and authorizer types, but the platform
// contracts that produce 502/504/429 and the CORS preflight synthesis
// are identical. Centralize them here so both layers stay in lockstep.

import { restBinding } from "@suss/behavioral-ir";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type {
  CorsConfig,
  IntegrationConfig,
  ThrottleConfig,
} from "./config.js";

export const FRAMEWORK = "apigateway";
export const PROTOCOL = "http";

export function throttleEnforces(throttle: ThrottleConfig): boolean {
  // A config with both limits absent or set to 0 doesn't actually
  // throttle. -1 is API Gateway's "unlimited" sentinel and shouldn't
  // emit 429 either.
  const enforces = (v: number | undefined) => v !== undefined && v > 0;
  return enforces(throttle.burstLimit) || enforces(throttle.rateLimit);
}

export function integrationCanTimeOut(integration: IntegrationConfig): boolean {
  // Mock integrations are synthetic and can't time out. Unknown means
  // the manifest didn't declare an integration; we don't fabricate
  // 504 in that case. Everything else talks to a backend whose latency
  // we can't bound statically.
  return integration.type !== "mock" && integration.type !== "unknown";
}

export function integrationCanFail(integration: IntegrationConfig): boolean {
  // 502 fires when the backend produces a malformed response or, for
  // lambda integrations, when the function throws. HTTP and AWS-service
  // integrations also surface 502 on bad gateway. Mock integrations
  // produce only what their template defines; unknown means we don't
  // know what's behind the endpoint, so don't claim 502.
  return integration.type !== "mock" && integration.type !== "unknown";
}

export interface CorsPreflightOptions {
  apiId: string;
  path: string;
  cors: CorsConfig;
  sourceFile: string;
  /**
   * Extra metadata merged into the synthesized summary's top-level
   * `metadata`. Used by HTTP API to add `apiVersion: "v2"`.
   */
  extraMetadata?: Record<string, unknown>;
}

/**
 * Build a synthesized OPTIONS preflight summary for one resource path.
 * The platform genuinely responds at this boundary — there's no handler
 * code, but a real OPTIONS request gets a real 204 with CORS headers.
 * Treating it as a real boundary lets a TS consumer that does
 * `fetch(path, { method: "OPTIONS" })` pair against it normally.
 */
export function buildCorsPreflightSummary(
  options: CorsPreflightOptions,
): BehavioralSummary {
  const { apiId, path, cors, sourceFile, extraMetadata } = options;
  const ownerKey = `${apiId}:OPTIONS:${path}:cors`;

  const headers: Record<string, { type: "literal"; value: string }> = {
    "Access-Control-Allow-Origin": {
      type: "literal",
      value: cors.allowOrigins.join(","),
    },
    "Access-Control-Allow-Methods": {
      type: "literal",
      value: cors.allowMethods.join(","),
    },
  };
  if (cors.allowHeaders !== undefined && cors.allowHeaders.length > 0) {
    headers["Access-Control-Allow-Headers"] = {
      type: "literal",
      value: cors.allowHeaders.join(","),
    };
  }
  if (cors.exposeHeaders !== undefined && cors.exposeHeaders.length > 0) {
    headers["Access-Control-Expose-Headers"] = {
      type: "literal",
      value: cors.exposeHeaders.join(","),
    };
  }
  if (cors.allowCredentials === true) {
    headers["Access-Control-Allow-Credentials"] = {
      type: "literal",
      value: "true",
    };
  }
  if (cors.maxAge !== undefined) {
    headers["Access-Control-Max-Age"] = {
      type: "literal",
      value: String(cors.maxAge),
    };
  }

  const transition: Transition = {
    id: `${ownerKey}:platform:204`,
    conditions: [
      {
        type: "opaque",
        sourceText: "aws:apigateway:cors-preflight",
        reason: "externalFunction",
      },
    ],
    output: {
      type: "response",
      statusCode: { type: "literal", value: 204 },
      body: null,
      headers,
    },
    effects: [],
    location: { start: 0, end: 0 },
    isDefault: false,
    confidence: { source: "stub", level: "high" },
    metadata: {
      source: "aws::apigateway::platform",
      platform: "apiGateway",
      causes: ["cors-preflight"],
      ...(cors.configRef !== undefined ? { configRefs: [cors.configRef] } : {}),
    },
  };

  return {
    kind: "handler",
    location: {
      file: `${sourceFile}:${ownerKey}`,
      range: { start: 0, end: 0 },
      exportName: null,
    },
    identity: {
      name: ownerKey,
      exportPath: null,
      boundaryBinding: restBinding({
        transport: PROTOCOL,
        method: "OPTIONS",
        path,
        recognition: FRAMEWORK,
      }),
    },
    inputs: [],
    transitions: [transition],
    gaps: [],
    confidence: { source: "stub", level: "high" },
    metadata: {
      apiId,
      synthetic: "cors-preflight",
      ...(extraMetadata ?? {}),
    },
  };
}
