// @suss/contract-intent: read team-authored intent specs into
// IntentSummary[]. A thin reader over @suss/intent-ir: file / directory
// discovery and YAML / JSON parsing live here; the schema and the
// normalisation to IntentSummary live in intent-ir.
//
// Two file shapes, discriminated by the top-level `kind`:
//
//   kind: boundary: engineer-authored system intent (REST or
//                     function-call): the outcomes a boundary should
//                     produce.
//   kind: prd: PM-authored outcome intent: scenarios that link to
//                     system-intent outcomes by qualified id.
//
// Unlike the other contract readers, intent does NOT produce
// BehavioralSummary: intent is a separate citizen with its own type
// (IntentSummary) and its own checker. The full design lives in
// design/proposals/intent-specs.md.

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import { IntentDocSchema, intentDocToSummary } from "@suss/intent-ir";

import type { IntentSummary } from "@suss/intent-ir";

export type {
  BoundaryIntentSummary,
  IntentOutcome,
  IntentSummary,
  PrdScenarioSummary,
  PrdSummary,
} from "@suss/intent-ir";

/**
 * Validate an in-memory intent doc (already parsed from YAML / JSON) and
 * normalise it to an IntentSummary. Throws on validation failure,
 * malformed specs are a load-time error, never a comparison finding.
 *
 * Accepts both `kind: boundary` and `kind: prd`; the transform
 * dispatches on the discriminator.
 */
export function loadIntentDoc(raw: unknown): IntentSummary {
  return intentDocToSummary(IntentDocSchema.parse(raw));
}

/**
 * Read a single intent-doc file (YAML or JSON, chosen by extension) and
 * normalise it. JSON is parsed strictly; everything else goes through
 * the YAML parser, which also accepts JSON syntax.
 *
 * Accepts both `*.intent.{yaml,yml,json}` and `*.prd.{yaml,yml,json}`,
 * the document's `kind` picks the shape.
 */
export function loadIntentFile(filepath: string): IntentSummary {
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
  return loadIntentDoc(parsed);
}

/**
 * Walk `dir` recursively for `*.intent.{yaml,yml,json}` and
 * `*.prd.{yaml,yml,json}` files and normalise each. Specs can live
 * anywhere under the root, organised however the team prefers.
 */
export function loadIntentDirectory(dir: string): IntentSummary[] {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Intent directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Intent path is not a directory: ${resolved}`);
  }
  return walkIntentFiles(resolved).map((file) => loadIntentFile(file));
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
