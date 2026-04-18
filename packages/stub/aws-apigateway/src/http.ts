// http.ts — Convert a normalized HttpApiConfig (API Gateway v2) into
// BehavioralSummary[]. The mechanics are mostly the same as REST: the
// same platform contracts produce the same status codes. Differences:
// authorizer set is restricted, throttling lives at API/stage level
// only, and CORS is API-wide rather than per-method.

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
  HttpApiConfig,
  HttpAuthorizerConfig,
  HttpRouteConfig,
  ThrottleConfig,
} from "./config.js";

export function httpApiToSummaries(config: HttpApiConfig): BehavioralSummary[] {
  const sourceFile = config.source ?? `aws-apigateway:${config.id}`;
  const summaries: BehavioralSummary[] = [];

  for (const route of config.routes) {
    const parsed = parseRouteKey(route.routeKey);
    if (parsed === null) {
      continue;
    }
    summaries.push(buildRouteSummary(route, parsed, config, sourceFile));
  }

  if (config.cors !== undefined) {
    for (const path of uniquePaths(config.routes)) {
      summaries.push(
        buildCorsPreflightSummary({
          apiId: config.id,
          path,
          cors: config.cors,
          sourceFile,
          extraMetadata: { apiVersion: "v2" },
        }),
      );
    }
  }

  return summaries;
}

interface ParsedRoute {
  method: string;
  path: string;
}

function parseRouteKey(routeKey: string): ParsedRoute | null {
  const trimmed = routeKey.trim();
  if (trimmed === "" || trimmed === "$default") {
    return null;
  }
  const space = trimmed.indexOf(" ");
  if (space < 0) {
    return null;
  }
  const method = trimmed.slice(0, space).toUpperCase();
  const path = trimmed.slice(space + 1).trim();
  if (method === "" || path === "") {
    return null;
  }
  return { method, path };
}

function buildRouteSummary(
  route: HttpRouteConfig,
  parsed: ParsedRoute,
  api: HttpApiConfig,
  sourceFile: string,
): BehavioralSummary {
  const ownerKey = route.name ?? `${api.id}:${parsed.method}:${parsed.path}`;
  const transitions: Transition[] = [];

  for (const code of route.integration.statusCodes) {
    transitions.push(
      handlerTransition({
        ownerKey,
        statusCode: code,
        source: `aws::apigateway::integration.${route.integration.type}`,
        configRef: route.integration.configRef,
      }),
    );
  }

  const platformByStatus = collectPlatformContributions(route, api);
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
        source: `aws::apigateway::integration.${route.integration.type}`,
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
        method: parsed.method,
        path: parsed.path,
        framework: FRAMEWORK,
      },
    },
    inputs: [],
    transitions,
    gaps: [],
    confidence: { source: "stub", level: "high" },
    metadata: {
      apiId: api.id,
      apiVersion: "v2",
      integrationType: route.integration.type,
      http: {
        declaredContract: {
          framework: FRAMEWORK,
          provenance: "independent",
          responses: route.integration.statusCodes.map((statusCode) => ({
            statusCode,
          })),
        },
      },
    },
  };
}

function collectPlatformContributions(
  route: HttpRouteConfig,
  api: HttpApiConfig,
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

  const authorizer = resolveAuthorizer(route, api);
  if (authorizer !== null) {
    if (authorizer.identitySourceRequired !== false) {
      add(401, makeContribution("authorization", authorizer.configRef));
    }
    add(403, makeContribution("authorization", authorizer.configRef));
  }

  const throttle = resolveThrottle(route, api);
  if (throttle !== null && throttleEnforces(throttle)) {
    add(429, makeContribution("throttle", throttle.configRef));
  }

  if (integrationCanTimeOut(route.integration)) {
    add(
      504,
      makeContribution("integration-timeout", route.integration.configRef),
    );
  }

  if (integrationCanFail(route.integration)) {
    add(
      502,
      makeContribution("integration-failure", route.integration.configRef),
    );
  }

  return buckets;
}

function resolveAuthorizer(
  route: HttpRouteConfig,
  api: HttpApiConfig,
): HttpAuthorizerConfig | null {
  if (route.authorizer === null) {
    return null;
  }
  if (route.authorizer !== undefined) {
    return route.authorizer;
  }
  return api.defaultAuthorizer ?? null;
}

function resolveThrottle(
  route: HttpRouteConfig,
  api: HttpApiConfig,
): ThrottleConfig | null {
  if (route.throttle !== undefined) {
    return route.throttle;
  }
  return api.defaultThrottle ?? null;
}

function uniquePaths(routes: HttpRouteConfig[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of routes) {
    const parsed = parseRouteKey(r.routeKey);
    if (parsed === null || seen.has(parsed.path)) {
      continue;
    }
    seen.add(parsed.path);
    out.push(parsed.path);
  }
  return out;
}
