// @suss/contract-appsync — Generate behavioral summaries from AWS AppSync
// CloudFormation templates.
//
// AppSync is schema-first: the SDL is authored by hand (directly in
// the CFN template via inline `Definition`, or separately via
// `DefinitionS3Location`). This stub parses inline definitions,
// indexes fields by (TypeName, FieldName), and emits one
// `resolver`-kind BehavioralSummary per `AWS::AppSync::Resolver`
// resource. Boundary bindings carry `graphql-resolver` semantics with
// the type/field pair — pairing key `gql:<TypeName>.<fieldName>`
// matches the Apollo side of the story without additional plumbing.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { readAppSyncFromCfn } from "./cfn.js";
import { parseSchema } from "./schema.js";
import { buildResolverSummaries } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CfnTemplate } from "./cfn.js";
import type { SchemaIndex } from "./schema.js";

export type { CfnTemplate } from "./cfn.js";

/**
 * Convert an already-parsed CloudFormation template to AppSync
 * resolver summaries. Call this when the caller has a template
 * object in memory (CDK `Template.fromStack`, JSON from a build
 * tool, etc.).
 */
export function appsyncToSummaries(
  template: CfnTemplate,
  options: { source?: string } = {},
): BehavioralSummary[] {
  const { apis, resolvers, functions } = readAppSyncFromCfn(template);
  const schemasByApi = indexSchemas(apis);
  return buildResolverSummaries(
    apis,
    resolvers,
    functions,
    schemasByApi,
    options,
  );
}

function indexSchemas(
  apis: ReturnType<typeof readAppSyncFromCfn>["apis"],
): Map<string, SchemaIndex> {
  const out = new Map<string, SchemaIndex>();
  for (const api of apis) {
    if (api.schemaSdl === null) {
      continue;
    }
    out.set(api.logicalId, parseSchema(api.schemaSdl));
  }
  return out;
}

/**
 * Read a CloudFormation template from disk and emit resolver summaries.
 * Accepts JSON and YAML (SAM / CDK-synth shapes), matching the
 * `cloudFormationFileToSummaries` posture of the aws-apigateway stub.
 */
export function appsyncFileToSummaries(
  filePath: string,
  options: { source?: string } = {},
): BehavioralSummary[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const template = parseTemplate(filePath, raw);
  return appsyncToSummaries(template, {
    source: options.source ?? path.relative(process.cwd(), filePath),
  });
}

function parseTemplate(filePath: string, raw: string): CfnTemplate {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(raw) as CfnTemplate;
  }
  // yaml package handles both .yaml and .yml; CFN shorthand intrinsic
  // tags (!Ref, !GetAtt, !Sub) aren't registered here for v0 — the
  // cloudformation stub's tag-aware loader will fold in when the
  // two stubs share a loader.
  return YAML.parse(raw) as CfnTemplate;
}
