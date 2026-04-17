// @suss/stub-cloudformation — Generate behavioral summaries from
// CloudFormation / SAM templates.
//
// Two extraction paths run side by side:
//
//   1. Inline-OpenAPI: API Gateway resources whose Properties.Body or
//      Properties.DefinitionBody carries an OpenAPI document. Each body
//      is handed to @suss/stub-openapi and its summaries flow through.
//
//   2. CFN-native: stacks that define routes one resource at a time
//      via AWS::ApiGateway::Method (REST) or AWS::ApiGatewayV2::Route
//      (HTTP API). The resource graph is resolved to derive the path
//      segments; each Method becomes one summary with one transition
//      per declared MethodResponse status, each Route becomes one
//      summary with a single default transition.
//
// Both walks coexist because real templates often mix the two — a SAM
// HTTP API with an inline body for some routes plus a few CFN-native
// Routes attached.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { openApiToSummaries } from "@suss/stub-openapi";

import type { BehavioralSummary, Transition } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "@suss/stub-openapi";

export interface CloudFormationToSummariesOptions {
  /** Override the logical source file recorded on each summary. */
  source?: string;
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

interface CloudFormationTemplate {
  Resources?: Record<string, CloudFormationResource>;
}

interface CloudFormationResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

/**
 * Convert an in-memory CloudFormation template into a `BehavioralSummary[]`.
 * One summary is produced per OpenAPI operation across all API Gateway-shaped
 * resources in the template.
 */
export function cloudFormationToSummaries(
  template: CloudFormationTemplate,
  options: CloudFormationToSummariesOptions = {},
): BehavioralSummary[] {
  const summaries: BehavioralSummary[] = [];
  const resources = template.Resources ?? {};

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

  // Native CFN walk: AWS::ApiGateway::Method (REST) + AWS::ApiGatewayV2::Route
  // (HTTP API). These do NOT depend on the inline-OpenAPI walk above; both
  // run unconditionally so a mixed template surfaces every kind of route.
  const sourceFile = options.source ?? "cloudformation";
  summaries.push(...walkRestApiMethods(resources, sourceFile));
  summaries.push(...walkHttpApiRoutes(resources, sourceFile));

  return summaries;
}

// ---------------------------------------------------------------------------
// CFN-native walks
// ---------------------------------------------------------------------------

/**
 * AWS::ApiGateway::Method (REST API). Each Method resource binds an HTTP
 * verb to a path defined as a chain of AWS::ApiGateway::Resource resources;
 * we walk that chain to materialise the path. MethodResponses (when set)
 * provide the declared status codes; absent, we emit a single default
 * 200 transition so pairing still works.
 */
function walkRestApiMethods(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const out: BehavioralSummary[] = [];
  const pathByLogicalId = new Map<string, string>();

  // Compute paths for every AWS::ApiGateway::Resource by walking ParentId
  // chains until we hit a RestApi (the root has no PathPart).
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

  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ApiGateway::Method") {
      continue;
    }
    const props = resource.Properties ?? {};
    const method = String(props.HttpMethod ?? "").toUpperCase();
    if (method === "" || method === "ANY") {
      // ANY would explode into 7 verbs; v0 skips it rather than guess.
      continue;
    }

    const resourceRef = refTarget(props.ResourceId);
    const path = resourceRef !== null ? pathFor(resourceRef) || "/" : "/";

    const transitions: Transition[] = [];
    const methodResponses = props.MethodResponses;
    if (Array.isArray(methodResponses) && methodResponses.length > 0) {
      for (const mr of methodResponses) {
        if (mr === null || typeof mr !== "object") {
          continue;
        }
        const code = parseStatus((mr as { StatusCode?: unknown }).StatusCode);
        if (code === null) {
          continue;
        }
        transitions.push({
          id: `${logicalId}:response:${code}:cfn`,
          conditions: [],
          output: {
            type: "response",
            statusCode: { type: "literal", value: code },
            body: null,
            headers: {},
          },
          effects: [],
          location: { start: 0, end: 0 },
          isDefault: false,
        });
      }
    }
    if (transitions.length === 0) {
      // No declared responses — emit a single default so pairing has
      // something to match against.
      transitions.push({
        id: `${logicalId}:response:default:cfn`,
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
      });
    }

    out.push({
      kind: "handler",
      location: {
        file: `${sourceFile}:${logicalId}`,
        range: { start: 0, end: 0 },
        exportName: null,
      },
      identity: {
        name: logicalId,
        exportPath: null,
        boundaryBinding: {
          protocol: "http",
          method,
          path,
          framework: "apigateway",
        },
      },
      inputs: [],
      transitions,
      gaps: [],
      confidence: { source: "stub", level: "high" },
      metadata: {
        cloudformation: { resource: logicalId, type: resource.Type },
      },
    });
  }

  return out;
}

/**
 * AWS::ApiGatewayV2::Route (HTTP API). RouteKey is "<METHOD> <path>" or
 * "$default" — only the explicit form is modeled here. Status codes aren't
 * declared at the route level, so the summary carries a single default
 * transition.
 */
function walkHttpApiRoutes(
  resources: Record<string, CloudFormationResource>,
  sourceFile: string,
): BehavioralSummary[] {
  const out: BehavioralSummary[] = [];
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::ApiGatewayV2::Route") {
      continue;
    }
    const routeKey = String(resource.Properties?.RouteKey ?? "").trim();
    if (routeKey === "" || routeKey === "$default") {
      continue;
    }
    const space = routeKey.indexOf(" ");
    if (space < 0) {
      continue;
    }
    const method = routeKey.slice(0, space).toUpperCase();
    const path = routeKey.slice(space + 1).trim();
    if (method === "" || path === "") {
      continue;
    }

    out.push({
      kind: "handler",
      location: {
        file: `${sourceFile}:${logicalId}`,
        range: { start: 0, end: 0 },
        exportName: null,
      },
      identity: {
        name: logicalId,
        exportPath: null,
        boundaryBinding: {
          protocol: "http",
          method,
          path,
          framework: "apigateway",
        },
      },
      inputs: [],
      transitions: [
        {
          id: `${logicalId}:response:default:cfn`,
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
        },
      ],
      gaps: [],
      confidence: { source: "stub", level: "high" },
      metadata: {
        cloudformation: { resource: logicalId, type: resource.Type },
      },
    });
  }
  return out;
}

/**
 * CloudFormation references show up in three shapes after parsing:
 *   - { Ref: "LogicalId" }
 *   - { "Fn::GetAtt": ["LogicalId", "Attr"] }
 *   - the bare logical id when the parser doesn't recognise the YAML tag
 *
 * Returns the target logical id for any of these or null when the value
 * isn't a reference we can resolve.
 */
function refTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.Ref === "string") {
    return obj.Ref;
  }
  const getAtt = obj["Fn::GetAtt"];
  if (Array.isArray(getAtt) && typeof getAtt[0] === "string") {
    return getAtt[0];
  }
  return null;
}

function parseStatus(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d{3}$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CloudFormation YAML intrinsic tags
// ---------------------------------------------------------------------------
//
// CloudFormation YAML uses shorthand tags (`!Ref X`, `!GetAtt X.Y`,
// `!Sub "..."`) that the default `yaml` schema doesn't know about. Without
// a handler, the parser would either error or leave them as opaque tagged
// nodes. We register a small set covering the intrinsics that affect
// resource references — anything else collapses to its raw scalar value
// rather than failing the whole parse.

const CLOUDFORMATION_YAML_TAGS = [
  {
    tag: "!Ref",
    resolve: (value: string) => ({ Ref: value }),
  },
  {
    tag: "!GetAtt",
    resolve: (value: string) => ({
      "Fn::GetAtt": value.includes(".") ? value.split(".") : [value],
    }),
  },
  // Pass-through tags for intrinsics we don't interpret but want to tolerate
  // so the parser doesn't reject the document. The value is preserved so
  // downstream code that does inspect it gets something sensible.
  ...[
    "!Sub",
    "!Join",
    "!Select",
    "!Split",
    "!FindInMap",
    "!ImportValue",
    "!Base64",
    "!Cidr",
    "!If",
    "!Not",
    "!And",
    "!Or",
    "!Equals",
  ].map((tag) => ({ tag, resolve: (value: unknown) => value })),
];

/**
 * Load a CloudFormation template from disk and convert it into behavioral
 * summaries. Format is detected by extension; `.json` is parsed as JSON,
 * everything else (including `.yaml`/`.yml`/`.template`) goes through the
 * YAML parser.
 */
export function cloudFormationFileToSummaries(
  templatePath: string,
  options: CloudFormationToSummariesOptions = {},
): BehavioralSummary[] {
  const resolved = path.resolve(templatePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`CloudFormation template not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  const ext = path.extname(resolved).toLowerCase();
  const parsed: unknown =
    ext === ".json"
      ? JSON.parse(raw)
      : YAML.parse(raw, { customTags: CLOUDFORMATION_YAML_TAGS });
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`CloudFormation template is not an object: ${resolved}`);
  }
  return cloudFormationToSummaries(parsed as CloudFormationTemplate, {
    source: options.source ?? `cloudformation:${path.basename(resolved)}`,
  });
}
