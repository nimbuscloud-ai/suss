// @suss/stub-cloudformation — Generate behavioral summaries from
// CloudFormation / SAM templates that embed an OpenAPI definition under
// API Gateway resources.
//
// Strategy: walk the template's Resources map, find API Gateway-shaped
// entries, pull the inline OpenAPI document out of `Body` (REST + HTTP API)
// or `DefinitionBody` (SAM), and hand it to @suss/stub-openapi. Resources
// without an inline body are skipped — out-of-line `BodyS3Location` and
// pure CFN-native (`AWS::ApiGateway::Method`) shapes are deferred for v0.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { openApiToSummaries } from "@suss/stub-openapi";

import type { BehavioralSummary } from "@suss/behavioral-ir";
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

  return summaries;
}

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
  const parsed: unknown = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`CloudFormation template is not an object: ${resolved}`);
  }
  return cloudFormationToSummaries(parsed as CloudFormationTemplate, {
    source: options.source ?? `cloudformation:${path.basename(resolved)}`,
  });
}
