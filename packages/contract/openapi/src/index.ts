// Reads an OpenAPI 3.x or Swagger 2.0 document into one handler summary
// per operation.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { specToSummaries } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { OpenApiSpec } from "./spec.js";

export interface OpenApiToSummariesOptions {
  /** The source label recorded on each summary, in place of the default. */
  source?: string;
}

/**
 * Converts an OpenAPI document already in memory. Each operation becomes
 * one summary with one transition per declared response status. A `$ref`
 * to a named schema is resolved, and a recursive one stops at a `ref`.
 */
export function openApiToSummaries(
  spec: OpenApiSpec,
  options: OpenApiToSummariesOptions = {},
): BehavioralSummary[] {
  return specToSummaries(spec, options);
}

/**
 * Reads an OpenAPI document from a YAML or JSON file and converts it. A
 * `.json` file is parsed as JSON, and any other file goes through the
 * YAML parser, which also accepts JSON. Throws when the file is missing
 * or does not contain an object.
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
