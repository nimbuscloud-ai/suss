/**
 * `suss intent outcomes`: list the outcome ids a PRD scenario can link
 * to, one line each.
 *
 * A scenario's `link` is `<intent-name>.<outcome-id>`, and both halves
 * are written inside a boundary intent document. Without a listing the
 * only way to find them is to open every YAML file in the folder, so a
 * link written by hand or by a model is a guess, and a wrong guess
 * comes back later as `danglingScenarioLink`.
 *
 * An id in an uncurated draft is listed apart from the rest. Renaming
 * the outcome ids is the first thing curation does, so a link to one of
 * those breaks as soon as somebody picks up the draft.
 */

import fs from "node:fs";
import path from "node:path";

import { displayLabel } from "@suss/behavioral-ir";
import { readIntentDirectory } from "@suss/contract-intent";

import { UsageError } from "./usageError.js";

import type { LoadedIntentDoc } from "@suss/contract-intent";
import type {
  BoundaryIntentSummary,
  IntentOutcome,
  IntentOutcomeKind,
} from "@suss/intent-ir";

export interface IntentOutcomeRow {
  /** What a PRD scenario writes in its `link`. */
  link: string;
  /** The boundary document's own `name`. */
  intent: string;
  /** The boundary it is about, spelled the way reports spell it. */
  boundary: string;
  /** The outcome's `id`, the part after the dot in `link`. */
  outcomeId: string;
  /** How the outcome ends and what it turns on, in one line. */
  description: string;
  /** Absolute path of the document that declares it. */
  file: string;
  /** The line in that file the id is written on. */
  line: number;
}

export interface IntentOutcomeListing {
  /** Outcomes of the curated documents, in file order. */
  outcomes: IntentOutcomeRow[];
  /** Outcomes of inferred drafts, whose ids curation still renames. */
  drafts: IntentOutcomeRow[];
  /** One message per file in the folder that could not be read. */
  unreadable: string[];
}

export interface IntentOutcomesOptions {
  /** The folder of intent documents to read. */
  from: string;
  /** Keep only the boundaries whose label contains this text. */
  boundary?: string;
}

/** The provenance of a document nobody has curated yet. */
const UNCURATED = "inferred";

/**
 * Every outcome the folder declares, curated ones apart from drafts.
 *
 * A PRD in the folder is skipped: it links to outcomes rather than
 * declaring any.
 */
export function intentOutcomes(
  options: IntentOutcomesOptions,
): IntentOutcomeListing {
  const resolved = path.resolve(options.from);
  if (!fs.existsSync(resolved)) {
    throw new UsageError(`No folder at ${resolved}.`);
  }

  const read = readIntentDirectory(resolved);
  const listing: IntentOutcomeListing = {
    outcomes: [],
    drafts: [],
    unreadable: read.broken,
  };
  for (const doc of read.docs) {
    if (doc.summary.kind !== "boundary") {
      continue;
    }

    const rows = rowsOf(doc, doc.summary).filter((row) =>
      matches(row, options.boundary),
    );
    const into =
      doc.summary.source === UNCURATED ? listing.drafts : listing.outcomes;
    into.push(...rows);
  }
  return listing;
}

function matches(row: IntentOutcomeRow, boundary: string | undefined): boolean {
  if (boundary === undefined) {
    return true;
  }
  return row.boundary.toLowerCase().includes(boundary.toLowerCase());
}

function rowsOf(
  doc: LoadedIntentDoc,
  summary: BoundaryIntentSummary,
): IntentOutcomeRow[] {
  const boundary = displayLabel(summary.boundary);
  return summary.outcomes.map((outcome) => ({
    link: `${summary.name}.${outcome.id}`,
    intent: summary.name,
    boundary,
    outcomeId: outcome.id,
    description: describe(outcome),
    file: doc.file,
    line: doc.outcomeLines[outcome.id] ?? 0,
  }));
}

/**
 * How the outcome ends, then what it turns on. The format has no
 * description field, and those are the two halves somebody needs to
 * pick one outcome out of five.
 */
function describe(outcome: IntentOutcome): string {
  return `${ENDINGS[outcome.kind](outcome)} when ${outcome.when}`;
}

const ENDINGS: Record<IntentOutcomeKind, (outcome: IntentOutcome) => string> = {
  response: (outcome) => `responds ${outcome.status}`,
  return: () => "returns a value",
  throw: (outcome) =>
    outcome.errorType === null
      ? "throws an error"
      : `throws ${outcome.errorType}`,
  effect: (outcome) => effectsOf(outcome),
};

function effectsOf(outcome: IntentOutcome): string {
  if (outcome.effects.length === 0) {
    return "has an effect";
  }
  return outcome.effects
    .map((effect) => `${effect.does} ${effect.names}`)
    .join(" and ");
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/** The line above the drafts, so nobody links to an id that will move. */
export const DRAFT_HEADING =
  "These ids are not settled. Curation renames the outcomes of an inferred draft, so a link to one of these can break:";

/** The rows as a person reads them, grouped by the file they came from. */
export function renderOutcomes(rows: IntentOutcomeRow[]): string {
  const linkWidth = widest(rows.map((row) => row.link));
  const boundaryWidth = widest(rows.map((row) => row.boundary));
  const lines: string[] = [];
  let lastFile = "";
  for (const row of rows) {
    if (row.file !== lastFile) {
      lines.push(...(lastFile === "" ? [] : [""]), where(row.file));
      lastFile = row.file;
    }

    lines.push(
      `  ${row.link.padEnd(linkWidth)}  ${row.boundary.padEnd(boundaryWidth)}  ${row.description}`,
    );
  }
  return lines.join("\n");
}

function widest(values: string[]): number {
  return values.reduce((widest, value) => Math.max(widest, value.length), 0);
}

/** The path as somebody would type it to open the file. */
function where(file: string): string {
  return path.relative(process.cwd(), file) || file;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface IntentOutcomesCommandOptions {
  /** The folder of intent documents to read. */
  from: string;
  /** Write the rows as JSON, for something other than a person. */
  json?: boolean;
}

/**
 * A folder with no settled id exits non-zero, because a PRD author who
 * ran this to find a link has nothing to write.
 */
export function intentOutcomesCommand(
  options: IntentOutcomesCommandOptions,
): number {
  const listing = intentOutcomes({ from: options.from });
  for (const message of listing.unreadable) {
    process.stderr.write(`Skipped a file that could not be read: ${message}\n`);
  }

  writeListing(listing, options.json === true);
  if (listing.outcomes.length > 0) {
    return 0;
  }

  process.stderr.write(
    `${whyNothingSettled(listing, path.resolve(options.from))}\n`,
  );
  return 1;
}

/**
 * JSON has the curated rows and nothing else, since an agent reads it
 * to write a link and an id curation renames is not one to write.
 */
function writeListing(listing: IntentOutcomeListing, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(listing.outcomes, null, 2)}\n`);
    if (listing.drafts.length > 0) {
      process.stderr.write(
        `${listing.drafts.length} more are in inferred drafts and are left out. Curation renames them.\n`,
      );
    }
    return;
  }

  const parts = [
    ...(listing.outcomes.length > 0 ? [renderOutcomes(listing.outcomes)] : []),
    ...(listing.drafts.length > 0
      ? [`${DRAFT_HEADING}\n\n${renderOutcomes(listing.drafts)}`]
      : []),
  ];
  if (parts.length > 0) {
    process.stdout.write(`${parts.join("\n\n")}\n`);
  }
}

function whyNothingSettled(listing: IntentOutcomeListing, dir: string): string {
  if (listing.drafts.length > 0) {
    return `No curated boundary intent in ${dir}, so no outcome id there is settled yet. Fill in each document's purpose and audience, rename its outcome ids, and set source to "inferred, curated".`;
  }
  return `No boundary intent in ${dir}. Write one, or draft one per boundary with \`suss infer intent\`.`;
}
