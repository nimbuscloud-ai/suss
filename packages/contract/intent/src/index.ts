// @suss/contract-intent — read team-authored intent specs and turn them
// into BehavioralSummary[] for the same checker that handles OpenAPI /
// GraphQL / Prisma / ... declarations.
//
// Two file shapes ship in v0.1, discriminated by the top-level `kind`:
//
//   kind: boundary  — engineer-authored system intent for a REST
//                     boundary (status codes, body shapes, outcome ids).
//   kind: prd       — PM-authored outcome intent (purpose, audience,
//                     scenarios that reference system-intent outcomes
//                     by qualified id).
//
// The full design lives in docs/internal/proposals/intent-specs.md.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { IntentDocSchema } from "./schema.js";
import { intentDocToSummary } from "./summaryBuilder.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { IntentDoc } from "./schema.js";

export { IntentDocSchema, IntentSpecSchema } from "./schema.js";

export type {
  BodyShape,
  BoundaryIntent,
  BoundaryTransition,
  IntentDoc,
  IntentSpec,
  Prd,
  PrdScenario,
  RestBoundary,
  RestTransition,
} from "./schema.js";

export interface IntentToSummariesOptions {
  /** Override the source string recorded on `summary.location.file`. */
  source?: string;
}

/**
 * Validate an in-memory intent doc (already parsed from YAML / JSON)
 * and turn it into a single `BehavioralSummary`. Throws when the doc
 * fails validation — malformed docs are a load-time error, never a
 * comparison finding.
 *
 * Accepts both `kind: boundary` and `kind: prd` docs; the summary
 * builder dispatches on the discriminator.
 */
export function intentSpecToSummaries(
  raw: unknown,
  options: IntentToSummariesOptions = {},
): BehavioralSummary[] {
  const doc: IntentDoc = IntentDocSchema.parse(raw);
  return [intentDocToSummary(doc, options)];
}

/**
 * Read a single intent-doc file (YAML or JSON, chosen by extension)
 * and return its summary. JSON is parsed strictly; everything else
 * goes through the YAML parser, which also accepts JSON syntax.
 *
 * Accepts both `*.intent.{yaml,yml,json}` and `*.prd.{yaml,yml,json}`
 * — the discriminator inside the document picks the shape.
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
 * Walk `dir` for `*.intent.{yaml,yml,json}` and `*.prd.{yaml,yml,json}`
 * files and return the flattened summary set. Subdirectories are
 * walked recursively; intent and PRD docs can live anywhere under the
 * root, organised however the team prefers.
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
      if (/\.(intent|prd)\.(yaml|yml|json)$/.test(entry.name)) {
        out.push(full);
      }
    } else if (entry.isDirectory()) {
      out.push(...walkIntentFiles(full));
    }
  }
  return out;
}
