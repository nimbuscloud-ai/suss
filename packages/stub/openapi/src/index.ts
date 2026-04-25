// @suss/stub-openapi — Generate behavioral summaries from OpenAPI 3.x specs.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { specToSummaries } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "./spec.js";

export interface OpenApiToSummariesOptions {
  /** Override the logical source file recorded on each summary. */
  source?: string;
}

/**
 * Convert an in-memory OpenAPI specification into a `BehavioralSummary[]`.
 *
 * One summary is produced per `paths.<path>.<method>` operation, with one
 * transition per declared response status. `$ref`s in schemas are resolved
 * against `components.schemas` with cycle protection.
 */
export function openApiToSummaries(
  spec: OpenApiSpec,
  options: OpenApiToSummariesOptions = {},
): BehavioralSummary[] {
  return specToSummaries(spec, options);
}

/**
 * Load an OpenAPI specification from a YAML or JSON file and convert it
 * into behavioral summaries. Format is detected by extension; `.json` is
 * parsed as JSON, everything else (including `.yaml`/`.yml`) goes through
 * the YAML parser, which also accepts JSON.
 */
export function openApiFileToSummaries(
  specPath: string,
  options: OpenApiToSummariesOptions = {},
): BehavioralSummary[] {
  const resolved = path.resolve(specPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`OpenAPI spec not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  const ext = path.extname(resolved).toLowerCase();
  const parsed: unknown = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`OpenAPI spec is not an object: ${resolved}`);
  }
  return openApiToSummaries(parsed as OpenApiSpec, {
    source: options.source ?? `openapi:${path.basename(resolved)}`,
  });
}

export type { OpenApiSpec } from "./spec.js";
