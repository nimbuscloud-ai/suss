/**
 * Reads team-written intent specs into IntentSummary values. This package
 * finds and parses the files, and @suss/intent-ir defines the schema and
 * converts each document into a summary.
 *
 * A file's top-level `kind` picks its form. `kind: boundary` lists the
 * outcomes a REST or function-call boundary should produce, and
 * `kind: prd` lists scenarios that link to those outcomes by qualified id.
 * Intent has its own checker, so this reader returns IntentSummary values
 * and never a BehavioralSummary.
 */

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
 * Validates an intent document that is already parsed, of either `kind`,
 * and converts it to an IntentSummary. A document that does not fit the
 * schema throws, because a malformed spec is an error at load time and
 * never a finding.
 */
export function loadIntentDoc(raw: unknown): IntentSummary {
  return intentDocToSummary(validated(raw, "The intent doc"));
}

/** `blanks` is empty unless blank fields are why the document was rejected. */
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

function andLast(names: string[]): string {
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function validated(raw: unknown, where: string) {
  const result = IntentDocSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  const issues = result.error.issues;
  // The full path is passed, because a PRD's blanks are inside its
  // scenarios and `blanksLeftEmpty` works out which part is the blank.
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
 * Reads one intent file and converts it. A `.json` file is parsed as
 * JSON, and any other file goes through the YAML parser, which also
 * accepts JSON. The document's `kind` picks its form, whether the file is
 * named `*.intent.*` or `*.prd.*`.
 */
export function loadIntentFile(filepath: string): IntentSummary {
  const resolved = path.resolve(filepath);
  return intentDocToSummary(validated(parseIntentFile(resolved), resolved));
}

/** The parsed file, before schema validation. */
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
   * The fields left blank, empty for a file that loads as written. Each
   * blank gets a placeholder, so `purpose` and the other blank fields
   * contain the placeholder and nothing anybody wrote.
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
 * Reads every `*.intent.*` and `*.prd.*` file (YAML or JSON) at any depth
 * under `dir`, so a team can arrange its specs however it likes.
 *
 * An inferred draft comes back with a placeholder in each blank, so a
 * caller that only wants outcome ids still gets them. A caller that needs
 * finished documents checks `blanks` and refuses any that have some.
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
 * Reads every document under `dir`. Throws for the whole folder when any
 * file is an uncurated draft or cannot be read.
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
 * A draft is read a second time with a placeholder in each blank. If it
 * still fails, the file is broken, and the first read's message is returned.
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
 * The converted document has no positions, so each outcome id's line
 * comes from the file text. JSON goes through the YAML parser too, since
 * YAML accepts JSON syntax.
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

/** Rejected files listed by name before the rest are only counted. */
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
 * Inferring intent leaves every draft with the same blanks, so stopping at
 * the first file would take one run per file. Unfinished drafts are listed
 * apart from broken files, with one sentence for all of them.
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
