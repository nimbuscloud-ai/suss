/**
 * Helpers for both REST (v1) and HTTP (v2) APIs. The two differ in how
 * routes and authorizers are declared, and they produce 502, 504 and 429
 * and the CORS preflight response the same way, so that logic lives here
 * once.
 */

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
  // A limit that is absent or 0 does not throttle, and API Gateway uses
  // -1 to mean unlimited, so neither produces a 429.
  const enforces = (v: number | undefined) => v !== undefined && v > 0;
  return enforces(throttle.burstLimit) || enforces(throttle.rateLimit);
}

export function integrationCanTimeOut(integration: IntegrationConfig): boolean {
  // A mock integration responds from its template and cannot time out. An
  // unknown one was never declared in the manifest, so no 504 is claimed.
  // Any other integration waits on a backend with unbounded latency.
  return integration.type !== "mock" && integration.type !== "unknown";
}

export function integrationCanFail(integration: IntegrationConfig): boolean {
  // A backend returns 502 on a malformed response, and a Lambda also does
  // when the function throws. A mock returns only its template, and with an
  // unknown integration nothing is known about the backend.
  return integration.type !== "mock" && integration.type !== "unknown";
}

export interface CorsPreflightOptions {
  apiId: string;
  path: string;
  cors: CorsConfig;
  sourceFile: string;
  /**
   * Merged into the summary's top-level `metadata`. The HTTP API adds
   * `apiVersion: "v2"` here.
   */
  extraMetadata?: Record<string, unknown>;
}

/**
 * A summary for the OPTIONS preflight on one resource path. No handler
 * code exists for it, but API Gateway responds to an OPTIONS request with a
 * 204 and the CORS headers, so a consumer that sends
 * `fetch(path, { method: "OPTIONS" })` has a provider to pair with.
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
    confidence: { source: "derived", level: "high" },
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
    confidence: { source: "derived", level: "high" },
    metadata: {
      apiId,
      synthetic: "cors-preflight",
      ...(extraMetadata ?? {}),
    },
  };
}
