/**
 * `suss intent outcomes` lists the outcome ids a PRD scenario can link
 * to, one per line.
 *
 * A scenario's `link` is `<intent-name>.<outcome-id>`, and both halves
 * come from inside a boundary intent document. Without this listing the
 * only way to find them is to open every YAML file in the folder. A link
 * written by hand or by a model is otherwise a guess, and a wrong guess
 * shows up later as `danglingScenarioLink`.
 *
 * Ids from an uncurated draft are listed separately. Curation starts by
 * renaming the outcome ids, so a link to one of those breaks as soon as
 * somebody curates the draft.
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
  /** The boundary the document describes, in the form reports print it. */
  boundary: string;
  /** The outcome's `id`, the part after the dot in `link`. */
  outcomeId: string;
  /** How the outcome ends and the condition it depends on, in one line. */
  description: string;
  /** Absolute path of the document that declares it. */
  file: string;
  /** The line in that file the id is written on. */
  line: number;
}

export interface IntentOutcomeListing {
  /** Outcomes of the curated documents, in file order. */
  outcomes: IntentOutcomeRow[];
  /** Outcomes of uncurated drafts. Their ids change when someone curates the draft. */
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
 * Every outcome declared in the folder, with curated documents and drafts
 * kept in separate lists. PRDs are skipped, because they only link to
 * outcomes.
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
 * How the outcome ends, then its condition. The intent format has no
 * description field, and these two parts are enough to tell one outcome
 * apart from the others on the same boundary.
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

/** Printed above the drafts, so nobody links to an id that will change. */
export const DRAFT_HEADING =
  "These ids are not settled. Curation renames the outcomes of an inferred draft, so a link to one of these can break:";

/** The rows as aligned text, grouped under the file each came from. */
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

/** The path relative to the working directory, or absolute when the file is outside it. */
function where(file: string): string {
  const here = path.relative(process.cwd(), file);
  if (here === "" || here.startsWith("..")) {
    return file;
  }
  return here;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export interface IntentOutcomesCommandOptions {
  /** The folder of intent documents to read. */
  from: string;
  /** Write the rows as JSON, for a script or an agent. */
  json?: boolean;
}

/**
 * Exits non-zero when the folder has no curated outcome ids, because a
 * PRD author who ran this to find a link has nothing safe to link to.
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
 * The JSON output has only the curated rows. An agent reads it to write a
 * link, and a draft's id would break once the draft is curated.
 */
function writeListing(listing: IntentOutcomeListing, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(listing.outcomes, null, 2)}\n`);
    const left = listing.drafts.length;
    if (left > 0) {
      process.stderr.write(
        `Left out ${left} outcome${left === 1 ? "" : "s"} an inferred draft declares, since curation renames them.\n`,
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
