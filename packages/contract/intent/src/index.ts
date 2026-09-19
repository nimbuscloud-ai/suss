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

import {
  blanksLeftEmpty,
  fillBlanks,
  IntentDocSchema,
  intentDocToSummary,
} from "@suss/intent-ir";

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
  return intentDocToSummary(validated(raw, "The intent doc"));
}

/** What is written for one doc, plus the blanks when that is the reason. */
class IntentDocRejected extends Error {
  constructor(
    readonly blanks: string[],
    message: string,
  ) {
    super(message);
  }
}

function waitingOnBlanks(where: string, blanks: string[]): string {
  const empty =
    blanks.length === 1
      ? `${blanks[0]} is still blank. Write it`
      : `${andLast(blanks)} are still blank. Write them`;
  return `${where} is an inferred draft and ${empty} and set source to "inferred, curated", or take the file out of the intent folder until you do.`;
}

/** `a, b and c`, so a list of five reads as one. */
function andLast(names: string[]): string {
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function validated(raw: unknown, where: string) {
  const result = IntentDocSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues;
  // The whole path, since a PRD leaves its blanks inside scenarios and
  // `blanksLeftEmpty` is what reads which part of one is a blank.
  const blanks = blanksLeftEmpty(
    raw,
    issues.map((issue) => issue.path.join(".")),
  );
  if (blanks.length > 0) {
    throw new IntentDocRejected(blanks, waitingOnBlanks(where, blanks));
  }

  const listed = issues
    .slice(0, 10)
    .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
  throw new IntentDocRejected(
    [],
    `${where} does not fit the intent schema:\n${listed}`,
  );
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
  return intentDocToSummary(validated(parseIntentFile(resolved), resolved));
}

/** The file's own data, before the schema has had a look at it. */
function parseIntentFile(filepath: string): unknown {
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
  return parsed;
}

/** One intent document, and where in the folder it was read from. */
export interface LoadedIntentDoc {
  /** The absolute path of the file. */
  file: string;
  summary: IntentSummary;
  /** The line each outcome's id is written on, by id. Empty for a PRD. */
  outcomeLines: Record<string, number>;
  /**
   * The fields the file leaves blank, empty for one that loads as
   * written. Each blank is filled with a placeholder, so `purpose` and
   * the rest of them contain that placeholder rather than what
   * anybody wrote.
   */
  blanks: string[];
}

export interface IntentDirectoryRead {
  /** Every document in the folder, in file order. */
  docs: LoadedIntentDoc[];
  /** One message per file that could not be read at all. */
  broken: string[];
}

/**
 * Walk `dir` recursively for `*.intent.{yaml,yml,json}` and
 * `*.prd.{yaml,yml,json}` files and normalise each. Specs can live
 * anywhere under the root, organised however the team prefers.
 *
 * An inferred draft comes back with a placeholder in each blank, so a
 * reader that only wants the outcome ids can still have them. A caller
 * that needs finished documents reads `blanks` and refuses the ones
 * that have any.
 */
export function readIntentDirectory(dir: string): IntentDirectoryRead {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Intent directory not found: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Intent path is not a directory: ${resolved}`);
  }

  const read: IntentDirectoryRead = { docs: [], broken: [] };
  for (const file of walkIntentFiles(resolved)) {
    const one = readOneDoc(file);
    if (one.doc !== null) {
      read.docs.push(one.doc);
      continue;
    }

    read.broken.push(one.broken);
  }
  return read;
}

/**
 * Walk `dir` and normalise every document in it, refusing the whole
 * folder when a file is an uncurated draft or does not read at all.
 */
export function loadIntentDirectory(dir: string): IntentSummary[] {
  const resolved = path.resolve(dir);
  const read = readIntentDirectory(resolved);
  const waiting = read.docs
    .filter((doc) => doc.blanks.length > 0)
    .map((doc) => path.relative(resolved, doc.file));
  if (waiting.length > 0 || read.broken.length > 0) {
    throw new Error(everyRejection(resolved, waiting, read.broken));
  }
  return read.docs.map((doc) => doc.summary);
}

/** One document, or the message saying why it could not be read. */
type DocRead =
  | { doc: LoadedIntentDoc; broken: null }
  | { doc: null; broken: string };

/**
 * A draft is read a second time with a placeholder in each blank. One
 * that still does not validate is broken rather than unfinished, so it
 * comes back with the message the first read produced.
 */
function readOneDoc(file: string): DocRead {
  try {
    return {
      doc: {
        file,
        summary: loadIntentFile(file),
        outcomeLines: outcomeLines(file),
        blanks: [],
      },
      broken: null,
    };
  } catch (err) {
    const rejected = err instanceof IntentDocRejected ? err : null;
    const broken = err instanceof Error ? err.message : String(err);
    if (rejected === null || rejected.blanks.length === 0) {
      return { doc: null, broken };
    }

    const draft = readDraft(file, rejected.blanks);
    return draft === null
      ? { doc: null, broken }
      : { doc: draft, broken: null };
  }
}

function readDraft(file: string, blanks: string[]): LoadedIntentDoc | null {
  try {
    return {
      file,
      summary: loadIntentDoc(fillBlanks(parseIntentFile(file), blanks)),
      outcomeLines: outcomeLines(file),
      blanks,
    };
  } catch {
    return null;
  }
}

/**
 * The line each outcome's id is written on, by id.
 *
 * A listing of outcome ids is something a person opens the file at, so
 * the line has to come from the text rather than from the normalised
 * document, which has no positions in it. JSON goes through the same
 * parser, since YAML takes JSON syntax.
 */
function outcomeLines(file: string): Record<string, number> {
  const counter = new YAML.LineCounter();
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf-8"), {
    lineCounter: counter,
  });
  const transitions = doc.get("transitions");
  if (!YAML.isSeq(transitions)) {
    return {};
  }

  const lines: Record<string, number> = {};
  for (const item of transitions.items) {
    if (!YAML.isMap(item)) {
      continue;
    }

    const id = item.get("id", true);
    if (!YAML.isScalar(id) || typeof id.value !== "string") {
      continue;
    }

    const start = id.range?.[0];
    if (start !== undefined) {
      lines[id.value] = counter.linePos(start).line;
    }
  }
  return lines;
}

/** How many rejected files get written out before a count takes over. */
const REJECTIONS_SHOWN = 10;

function listed(files: string[]): string {
  const lines = files.slice(0, REJECTIONS_SHOWN).map((one) => `  - ${one}`);
  const left = files.length - lines.length;
  if (left > 0) {
    lines.push(`  and ${left} more`);
  }
  return lines.join("\n");
}

/**
 * One error for the whole directory, with the drafts waiting on their
 * blanks kept apart from the files that are actually broken. Inferring
 * intent leaves every doc waiting on the same two blanks at once, so
 * reporting the first file and stopping would take one run per file to
 * get through, and repeating the same sentence for each is no better.
 */
function everyRejection(
  dir: string,
  waiting: string[],
  broken: string[],
): string {
  const parts: string[] = [];
  if (waiting.length > 0) {
    parts.push(
      `${waiting.length} intent doc(s) in ${dir} are inferred drafts with blanks still in them:\n${listed(waiting)}\nWrite them and set source to "inferred, curated", or take those files out of the intent folder until you do.`,
    );
  }
  if (broken.length > 0) {
    parts.push(
      `${broken.length} intent doc(s) in ${dir} could not be read:\n${listed(broken)}`,
    );
  }
  return parts.join("\n\n");
}

/** Sorted, so a listing of a folder comes out the same on every machine. */
function walkIntentFiles(dir: string): string[] {
  const out: string[] = [];
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
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
