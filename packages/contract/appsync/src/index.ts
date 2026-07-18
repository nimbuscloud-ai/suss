// @suss/contract-appsync — Generate behavioral summaries from AWS AppSync
// CloudFormation / SAM templates.
//
// AppSync is schema-first: the SDL is authored by hand, either inline in
// the template or in a separate `.graphql` file. This reader covers both
// authoring shapes for the resolver surface:
//
//   - Raw AWS::AppSync::* resources (GraphQLApi + GraphQLSchema + Resolver
//     + FunctionConfiguration + DataSource).
//   - The SAM shorthand AWS::Serverless::GraphQLApi, whose inline
//     DataSources / Functions / Resolvers blocks are normalized into the
//     same model.
//
// Schema text is read from inline `Definition` / `SchemaInline`, or loaded
// from disk when `DefinitionS3Location` / `SchemaUri` is a local path
// (via @suss/contract-graphql's SDL loader). Genuinely-remote `s3://`
// schema URIs can't be fetched statically and surface as an explicit
// unresolved-schema gap in each affected resolver's accounting metadata.
//
// Fields are indexed by (TypeName, FieldName); one `resolver`-kind
// BehavioralSummary is emitted per resolver with `graphql-resolver`
// semantics — pairing key `gql:<TypeName>.<fieldName>` matches the Apollo
// side of the story without additional plumbing. Lambda data-source
// attribution rides on each summary so it can later correlate to handler
// code.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { readAppSyncFromCfn } from "./cfn.js";
import { parseSchema } from "./schema.js";
import { resolveSchemaSource } from "./schemaSource.js";
import { buildResolverSummaries } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { AppSyncConfig, CfnTemplate } from "./cfn.js";
import type { SchemaIndex } from "./schema.js";
import type { ResolvedSchema } from "./schemaSource.js";

export type { CfnTemplate } from "./cfn.js";

export interface AppsyncToSummariesOptions {
  /** Logical source path recorded on each summary's `location.file`. */
  source?: string;
  /**
   * Directory used to resolve relative external schema paths
   * (`DefinitionS3Location` / `SchemaUri`). `appsyncFileToSummaries`
   * sets this to the template's directory; in-memory callers pass it
   * when their schema references are relative.
   */
  baseDir?: string;
}

/**
 * Convert an already-parsed CloudFormation / SAM template to AppSync
 * resolver summaries. Call this when the caller has a template object in
 * memory (CDK `Template.fromStack`, JSON from a build tool, etc.).
 */
export function appsyncToSummaries(
  template: CfnTemplate,
  options: AppsyncToSummariesOptions = {},
): BehavioralSummary[] {
  const config = readAppSyncFromCfn(template);
  const baseDir = options.baseDir ?? null;
  const resolvedByApi = resolveSchemas(config, baseDir);
  const schemasByApi = indexSchemas(resolvedByApi);
  return buildResolverSummaries(config, resolvedByApi, schemasByApi, {
    ...(options.source !== undefined ? { source: options.source } : {}),
  });
}

function resolveSchemas(
  config: AppSyncConfig,
  baseDir: string | null,
): Map<string, ResolvedSchema> {
  const out = new Map<string, ResolvedSchema>();
  for (const api of config.apis) {
    out.set(api.logicalId, resolveSchemaSource(api.schemaSource, baseDir));
  }
  return out;
}

function indexSchemas(
  resolvedByApi: Map<string, ResolvedSchema>,
): Map<string, SchemaIndex> {
  const out = new Map<string, SchemaIndex>();
  for (const [logicalId, resolved] of resolvedByApi) {
    if (resolved.status === "inline" || resolved.status === "external-file") {
      out.set(logicalId, parseSchema(resolved.sdl));
    }
  }
  return out;
}

/**
 * Read a CloudFormation / SAM template from disk and emit resolver
 * summaries. Accepts JSON and YAML (SAM / CDK-synth shapes). Relative
 * external schema paths resolve against the template's directory.
 */
export function appsyncFileToSummaries(
  filePath: string,
  options: AppsyncToSummariesOptions = {},
): BehavioralSummary[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const template = parseTemplate(filePath, raw);
  return appsyncToSummaries(template, {
    source: options.source ?? path.relative(process.cwd(), filePath),
    baseDir: options.baseDir ?? path.dirname(filePath),
  });
}

// CloudFormation YAML uses shorthand intrinsic tags (`!Ref`, `!GetAtt`,
// `!Sub`, ...) the default `yaml` schema doesn't know. We fold the
// reference-bearing tags into their `Fn::`/`Ref` object form and collapse
// the rest to their raw scalar so an unrelated tag never fails the parse.
const CLOUDFORMATION_YAML_TAGS = [
  { tag: "!Ref", resolve: (value: string) => ({ Ref: value }) },
  {
    tag: "!GetAtt",
    resolve: (value: string) => ({
      "Fn::GetAtt": value.includes(".") ? value.split(".") : [value],
    }),
  },
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

function parseTemplate(filePath: string, raw: string): CfnTemplate {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    return JSON.parse(raw) as CfnTemplate;
  }
  return YAML.parse(raw, {
    customTags: CLOUDFORMATION_YAML_TAGS,
  }) as CfnTemplate;
}
