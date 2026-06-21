// @suss/contract-intent — read team-authored intent specs and turn them
// into BehavioralSummary[] for the same checker that handles OpenAPI /
// GraphQL / Prisma / ... declarations.
//
// The intent spec format is documented in
// docs/internal/proposals/intent-specs.md. v0 covers REST boundaries
// with single-status transitions and object-shaped bodies; richer
// types and additional boundary semantics land in v1.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { IntentSpecSchema } from "./schema.js";
import { intentSpecToSummary } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { IntentSpec } from "./schema.js";

export { IntentSpecSchema } from "./schema.js";

export type {
  BodyShape,
  IntentSpec,
  RestBoundary,
  RestTransition,
} from "./schema.js";

export interface IntentToSummariesOptions {
  /** Override the source string recorded on `summary.location.file`. */
  source?: string;
}

/**
 * Validate an in-memory intent spec (already parsed from YAML / JSON)
 * and turn it into a single `BehavioralSummary`. Throws when the spec
 * fails validation — malformed specs are a load-time error, never a
 * comparison finding.
 */
export function intentSpecToSummaries(
  raw: unknown,
  options: IntentToSummariesOptions = {},
): BehavioralSummary[] {
  const spec: IntentSpec = IntentSpecSchema.parse(raw);
  return [intentSpecToSummary(spec, options)];
}

/**
 * Read a single intent-spec file (YAML or JSON, chosen by extension)
 * and return its summary. JSON is parsed strictly; everything else
 * goes through the YAML parser, which also accepts JSON syntax.
 */
export function intentSpecFileToSummaries(
  filepath: string,
  options: IntentToSummariesOptions = {},
): BehavioralSummary[] {
  const resolved = path.resolve(filepath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Intent spec not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  const ext = path.extname(resolved).toLowerCase();
  let parsed: unknown;
  try {
    parsed = ext === ".json" ? JSON.parse(raw) : YAML.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Intent spec ${resolved} failed to parse: ${reason}`);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Intent spec ${resolved} is not an object`);
  }
  return intentSpecToSummaries(parsed, {
    source: options.source ?? `intent:${path.basename(resolved)}`,
  });
}

/**
 * Walk `dir` for `*.intent.yaml`, `*.intent.yml`, and `*.intent.json`
 * files and return the flattened summary set. Subdirectories are
 * walked recursively — keeps the same shape as the storybook
 * directory walker so authors can organise intent specs however they
 * want under a single root.
 */
export function intentSpecDirectoryToSummaries(
  dir: string,
  options: IntentToSummariesOptions = {},
): BehavioralSummary[] {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Intent directory not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Intent path is not a directory: ${resolved}`);
  }
  const out: BehavioralSummary[] = [];
  for (const file of walkIntentFiles(resolved)) {
    out.push(...intentSpecFileToSummaries(file, options));
  }
  return out;
}

function walkIntentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (/\.intent\.(yaml|yml|json)$/.test(entry.name)) {
        out.push(full);
      }
    } else if (entry.isDirectory()) {
      out.push(...walkIntentFiles(full));
    }
  }
  return out;
}
