/**
 * Reads an AWS AppSync API from a CloudFormation or SAM template and
 * writes one resolver summary per resolver. Each is keyed by type and
 * field name, the same way as a resolver found in code, so the two pair
 * directly. The Lambda behind each data source is recorded so the
 * summary can later be matched to handler code.
 *
 * The README lists the resources and schema sources this reads.
 */

import path from "node:path";

import { loadCloudFormationTemplate } from "@suss/manifest-aws";

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
  /** Path recorded on each summary's `location.file`. */
  source?: string;
  /**
   * The directory a relative `DefinitionS3Location` or `SchemaUri`
   * resolves against. `appsyncFileToSummaries` sets it to the template's.
   */
  baseDir?: string;
}

/**
 * Converts a template already in memory, such as a CDK
 * `Template.fromStack` result, to AppSync resolver summaries.
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
 * Reads a CloudFormation or SAM template, in JSON or YAML, and converts
 * it. A relative schema path resolves against the template's directory.
 */
export function appsyncFileToSummaries(
  filePath: string,
  options: AppsyncToSummariesOptions = {},
): BehavioralSummary[] {
  const template = loadCloudFormationTemplate(filePath);
  return appsyncToSummaries(template, {
    source: options.source ?? path.relative(process.cwd(), filePath),
    baseDir: options.baseDir ?? path.dirname(filePath),
  });
}
