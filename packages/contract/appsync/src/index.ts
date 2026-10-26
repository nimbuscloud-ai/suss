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

import { defaultProjectRoot, pathInProject } from "@suss/behavioral-ir/files";
import { loadTemplateTree, unfollowedStackMessage } from "@suss/manifest-aws";

import { mergeConfigs, readAppSyncFromCfn } from "./cfn.js";
import { documentRefsOf } from "./refs.js";
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

export interface AppsyncFileToSummariesOptions
  extends AppsyncToSummariesOptions {
  /** Absolute. The directory the template's path is measured from. */
  projectRoot?: string;
  /** Collects each child template that could not be opened. Without it, each goes to stderr. */
  warnings?: string[];
}

/**
 * Converts a template already in memory, such as a CDK
 * `Template.fromStack` result, to AppSync resolver summaries.
 */
export function appsyncToSummaries(
  template: CfnTemplate,
  options: AppsyncToSummariesOptions = {},
): BehavioralSummary[] {
  const config = mergeConfigs([readAppSyncFromCfn(template)]);
  const baseDir = options.baseDir ?? null;
  return summariesOf(
    config,
    new Map(config.apis.map((api) => [api.logicalId, baseDir])),
    options.source,
  );
}

function summariesOf(
  config: AppSyncConfig,
  baseDirByApi: Map<string, string | null>,
  source: string | undefined,
): BehavioralSummary[] {
  const resolvedByApi = resolveSchemas(config, baseDirByApi);
  const schemasByApi = indexSchemas(resolvedByApi);
  return buildResolverSummaries(config, resolvedByApi, schemasByApi, {
    ...(source !== undefined ? { source } : {}),
  });
}

function resolveSchemas(
  config: AppSyncConfig,
  baseDirByApi: Map<string, string | null>,
): Map<string, ResolvedSchema> {
  const out = new Map<string, ResolvedSchema>();
  for (const api of config.apis) {
    out.set(
      api.logicalId,
      resolveSchemaSource(
        api.schemaSource,
        baseDirByApi.get(api.logicalId) ?? null,
      ),
    );
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
 * Reads a CloudFormation or SAM template, in JSON or YAML, and every
 * template it embeds as a nested stack, and converts them as one API
 * surface. A child's resolvers often belong to an API the root declares
 * and passes down as a parameter. A relative schema path resolves
 * against the directory of the template that declares it.
 */
export function appsyncFileToSummaries(
  filePath: string,
  options: AppsyncFileToSummariesOptions = {},
): BehavioralSummary[] {
  const tree = loadTemplateTree(filePath);
  for (const stack of tree.unfollowed) {
    const message = unfollowedStackMessage(stack);
    if (options.warnings !== undefined) {
      options.warnings.push(message);
      continue;
    }

    process.stderr.write(`[suss] appsync: ${message}\n`);
  }
  const baseDirByApi = new Map<string, string | null>();
  const configs = tree.documents.map((document) => {
    const config = readAppSyncFromCfn(
      document.template,
      documentRefsOf(document),
    );
    const baseDir =
      document.stackPath.length === 0 && options.baseDir !== undefined
        ? options.baseDir
        : path.dirname(document.path);
    for (const api of config.apis) {
      baseDirByApi.set(api.logicalId, baseDir);
    }
    return config;
  });
  const root = options.projectRoot ?? defaultProjectRoot(filePath);
  return summariesOf(
    mergeConfigs(configs),
    baseDirByApi,
    options.source ?? pathInProject(filePath, root),
  );
}
