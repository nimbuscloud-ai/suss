// rest.ts — Convert a normalized RestApiConfig into BehavioralSummary[].
//
// Manifest-agnostic: callers (CFN/CDK/Terraform readers) build
// RestApiConfig from their source format and pass it here. This module
// owns the AWS API Gateway v1 (REST) resource semantics: which platform
// transitions appear given which configuration knobs.

import {
  buildCorsPreflightSummary,
  FRAMEWORK,
  integrationCanFail,
  integrationCanTimeOut,
  PROTOCOL,
  throttleEnforces,
} from "./shared.js";
import {
  handlerTransition,
  makeContribution,
  type PlatformContribution,
  platformTransition,
} from "./transitions.js";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type {
  AuthorizerConfig,
  RestApiConfig,
  RestEndpointConfig,
  ThrottleConfig,
} from "./config.js";

export function restApiToSummaries(config: RestApiConfig): BehavioralSummary[] {
  const sourceFile = config.source ?? `aws-apigateway:${config.id}`;
  const summaries: BehavioralSummary[] = [];

  for (const endpoint of config.endpoints) {
    summaries.push(buildEndpointSummary(endpoint, config, sourceFile));
  }

  // Synthesize OPTIONS preflight per unique resource path when CORS is
  // configured at the API level. A real REST API can also declare CORS
  // per-method via "EnableCorsOnMethod" — readers should turn those
  // into explicit OPTIONS endpoints in `endpoints` and skip the
  // top-level `cors` field, so we don't double-emit.
  if (config.cors !== undefined) {
    for (const endpoint of dedupeByPath(config.endpoints)) {
      summaries.push(
        buildCorsPreflightSummary({
          apiId: config.id,
          path: endpoint.path,
          cors: config.cors,
          sourceFile,
        }),
      );
    }
  }

  return summaries;
}

function buildEndpointSummary(
  endpoint: RestEndpointConfig,
  api: RestApiConfig,
  sourceFile: string,
): BehavioralSummary {
  const method = endpoint.method.toUpperCase();
  const ownerKey = endpoint.name ?? `${api.id}:${method}:${endpoint.path}`;

  const transitions: Transition[] = [];

  for (const code of endpoint.integration.statusCodes) {
    transitions.push(
      handlerTransition({
        ownerKey,
        statusCode: code,
        source: `aws::apigateway::integration.${endpoint.integration.type}`,
        configRef: endpoint.integration.configRef,
      }),
    );
  }

  const platformByStatus = collectPlatformContributions(endpoint, api);
  for (const [status, contributions] of platformByStatus) {
    const transition = platformTransition({
      ownerKey,
      statusCode: status,
      contributions,
    });
    if (transition !== null) {
      transitions.push(transition);
    }
  }

  // Endpoints with no integration status codes AND no platform
  // contributions still need at least one transition so they pair
  // with consumers. Default isDefault transition is the honest fallback
  // — manifest didn't tell us what the integration returns.
  if (transitions.length === 0) {
    transitions.push({
      id: `${ownerKey}:integration:default`,
      conditions: [],
      output: {
        type: "response",
        statusCode: null,
        body: null,
        headers: {},
      },
      effects: [],
      location: { start: 0, end: 0 },
      isDefault: true,
      confidence: { source: "stub", level: "low" },
      metadata: {
        source: `aws::apigateway::integration.${endpoint.integration.type}`,
      },
    });
  }

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
      boundaryBinding: {
        protocol: PROTOCOL,
        method,
        path: endpoint.path,
        framework: FRAMEWORK,
      },
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "stub", level: "high" },
    metadata: {
      apiId: api.id,
      integrationType: endpoint.integration.type,
    },
  };
}

/**
 * Walk the configuration knobs that produce additional response
 * transitions and bucket them by status code. Cascading: API-level
 * defaults (authorizer, throttle) apply unless the endpoint sets the
 * corresponding field. Passing `null` opts out of an inherited default.
 */
function collectPlatformContributions(
  endpoint: RestEndpointConfig,
  api: RestApiConfig,
): Map<number, PlatformContribution[]> {
  const buckets = new Map<number, PlatformContribution[]>();
  const add = (status: number, contribution: PlatformContribution) => {
    const existing = buckets.get(status);
    if (existing === undefined) {
      buckets.set(status, [contribution]);
    } else {
      existing.push(contribution);
    }
  };

  const authorizer = resolveAuthorizer(endpoint, api);
  if (authorizer !== null) {
    if (authorizer.identitySourceRequired !== false) {
      add(401, makeContribution("authorization", authorizer.configRef));
    }
    add(403, makeContribution("authorization", authorizer.configRef));
  }

  if (endpoint.apiKeyRequired === true) {
    add(403, makeContribution("api-key", endpoint.configRef));
  }

  if (endpoint.requestValidation !== undefined) {
    const v = endpoint.requestValidation;
    if (v.body === true || v.params === true || v.headers === true) {
      add(
        400,
        makeContribution(
          "request-validation",
          v.configRef ?? endpoint.configRef,
        ),
      );
    }
  }

  const throttle = resolveThrottle(endpoint, api);
  if (throttle !== null && throttleEnforces(throttle)) {
    add(429, makeContribution("throttle", throttle.configRef));
  }

  if (integrationCanTimeOut(endpoint.integration)) {
    add(
      504,
      makeContribution("integration-timeout", endpoint.integration.configRef),
    );
  }

  if (integrationCanFail(endpoint.integration)) {
    add(
      502,
      makeContribution("integration-failure", endpoint.integration.configRef),
    );
  }

  return buckets;
}

function resolveAuthorizer(
  endpoint: RestEndpointConfig,
  api: RestApiConfig,
): AuthorizerConfig | null {
  if (endpoint.authorizer === null) {
    return null;
  }
  if (endpoint.authorizer !== undefined) {
    return endpoint.authorizer;
  }
  return api.defaultAuthorizer ?? null;
}

function resolveThrottle(
  endpoint: RestEndpointConfig,
  api: RestApiConfig,
): ThrottleConfig | null {
  if (endpoint.throttle !== undefined) {
    return endpoint.throttle;
  }
  return api.defaultThrottle ?? null;
}

function dedupeByPath(endpoints: RestEndpointConfig[]): RestEndpointConfig[] {
  const seen = new Set<string>();
  const out: RestEndpointConfig[] = [];
  for (const e of endpoints) {
    if (seen.has(e.path)) {
      continue;
    }
    seen.add(e.path);
    out.push(e);
  }
  return out;
}
