/**
 * `suss infer prd`: turn curated boundary intent into starting PRD
 * documents, one per boundary, with a scenario per outcome.
 *
 * The link is the part a machine can supply, since it is the boundary
 * document's name and the outcome's id. The words are not, so `when`
 * and `expect` are left blank with a hint beside each.
 *
 * Reading intent rather than summaries is what puts this after
 * curation: an uncurated boundary document has blank purpose and
 * audience and does not load. Linking to `200-ok` before somebody
 * renames that outcome would write a dangling link into a file suss
 * produced itself.
 */

import fs from "node:fs";
import path from "node:path";

import { loadIntentDirectory, loadIntentDoc } from "@suss/contract-intent";

import {
  destinationOf,
  docsIn,
  FILLED_IN,
  render,
  slug,
} from "./intentDraftCommand.js";
import { UsageError } from "./usageError.js";

import type { BoundaryIntentSummary, IntentSummary } from "@suss/intent-ir";

export interface PrdDraftOptions {
  /** The folder of curated boundary intent to read. */
  from: string;
  /** Where the documents go. Default: the folder they were read from. */
  out?: string;
  /** Same destination, but it refuses to write over PRDs already there. */
  into?: string;
}

export interface DraftedPrd {
  /** File name within the destination directory. */
  file: string;
  /** The boundary intent it covers, by that document's `name`. */
  intent: string;
  scenarios: number;
  yaml: string;
}

export interface PrdDraftResult {
  drafted: DraftedPrd[];
  /** Boundary intents a scenario already points at, left alone. */
  covered: string[];
}

const PRD_DOC = /\.prd\.(yaml|yml|json)$/;

/** The blanks, and the hint written beside each one. */
const BLANKS: Record<string, string> = {
  title: "what this document covers, in your words",
  purpose: "why it matters",
  audience: "who cares about it",
  when: "the situation, in your words",
  expect: "what should happen, in your words",
};

/** Keys a blank line comes before, so the file reads in parts. */
const PARAGRAPHS = new Set(["title", "scenarios"]);

function header(intent: BoundaryIntentSummary, from: string): string[] {
  return [
    `# Why ${intent.name} behaves the way it does, for somebody to write.`,
    `# One scenario per outcome it declares, read from ${from}.`,
    "#",
    "# Each link points at an outcome the boundary document declares, and",
    "# the words beside it are the part nothing but a person can supply:",
    "# the situation, and what should happen in it.",
    "#",
    "# Until the blanks are filled the reader rejects this file and says so,",
    "# which is what keeps an uncurated draft from passing for finished.",
  ];
}

function draftDocument(
  intent: BoundaryIntentSummary,
  from: string,
): DraftedPrd {
  const doc = {
    kind: "prd" as const,
    title: "",
    purpose: "",
    audience: "",
    source: "inferred" as const,
    scenarios: intent.outcomes.map((outcome) => ({
      when: "",
      expect: "",
      link: `${intent.name}.${outcome.id}`,
    })),
  };

  // Filling the blanks first means the only thing the reader can
  // complain about in the file this writes is the blanks.
  loadIntentDoc({
    ...doc,
    title: FILLED_IN,
    purpose: FILLED_IN,
    audience: FILLED_IN,
    scenarios: doc.scenarios.map((one) => ({
      ...one,
      when: FILLED_IN,
      expect: FILLED_IN,
    })),
  });

  return {
    file: `${slug(intent.name)}.prd.yaml`,
    intent: intent.name,
    scenarios: doc.scenarios.length,
    yaml: `${header(intent, from).join("\n")}\n\n${render(doc, BLANKS, PARAGRAPHS)}`,
  };
}

/** `from` is the folder the intent was read from, for each header. */
export function prdDraftResult(
  intents: IntentSummary[],
  from: string,
): PrdDraftResult {
  const covered = new Set(
    intents.flatMap((intent) =>
      intent.kind === "prd"
        ? intent.scenarios.flatMap((scenario) =>
            scenario.link.map((ref) => ref.slice(0, ref.indexOf("."))),
          )
        : [],
    ),
  );
  const drafted: DraftedPrd[] = [];
  const alreadySaid: string[] = [];
  for (const intent of intents) {
    if (intent.kind !== "boundary") {
      continue;
    }
    if (covered.has(intent.name)) {
      alreadySaid.push(intent.name);
      continue;
    }
    drafted.push(draftDocument(intent, from));
  }

  return { drafted, covered: alreadySaid };
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/**
 * A directory of intent that does not load, said the way a person can
 * act on it. An uncurated draft is the case worth naming, since running
 * these two commands back to back is what produces one.
 */
function readIntentDirectory(from: string): IntentSummary[] {
  const resolved = path.resolve(from);
  if (!fs.existsSync(resolved)) {
    throw new UsageError(`No folder at ${resolved}.`);
  }

  try {
    return loadIntentDirectory(resolved);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    throw new UsageError(
      `${said}\n\nA PRD links to outcome ids, so everything in the folder has to load before this can write one.`,
    );
  }
}

export function prdDraft(options: PrdDraftOptions): number {
  const intents = readIntentDirectory(options.from);
  const result = prdDraftResult(intents, options.from);
  const destination = destinationOf(
    options.out === undefined && options.into === undefined
      ? { out: options.from }
      : {
          ...(options.out !== undefined ? { out: options.out } : {}),
          ...(options.into !== undefined ? { into: options.into } : {}),
        },
  );
  const dir = path.resolve(destination.dir);

  if (result.drafted.length === 0) {
    process.stderr.write(
      `No boundary intent in ${options.from} needs a PRD.${coveredReport(result.covered)}\n`,
    );
    return 1;
  }

  const existing = docsIn(dir, PRD_DOC);
  if (existing.length > 0 && destination.overExisting === "refuse") {
    throw new UsageError(
      `${dir} already holds ${existing.length} PRD(s). --into writes where the curated docs are not, so pick a folder that has none.`,
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const doc of result.drafted) {
    fs.writeFileSync(path.join(dir, doc.file), doc.yaml);
  }

  const count = result.drafted.length;
  process.stdout.write(
    `Drafted ${count} PRD${count === 1 ? "" : "s"} in ${dir}, ` +
      "each with a scenario per outcome and the words left blank. Write the " +
      'situation and what should happen, then set source to "inferred, curated". ' +
      "Until then `suss check --intent` says which files are still waiting." +
      `${coveredReport(result.covered)}\n`,
  );
  return 0;
}

/** How many already-covered intents get written out before a count takes over. */
const COVERED_SHOWN = 10;

function coveredReport(covered: string[]): string {
  if (covered.length === 0) {
    return "";
  }

  const lines = covered.slice(0, COVERED_SHOWN).map((one) => `  - ${one}`);
  const left = covered.length - lines.length;
  if (left > 0) {
    lines.push(`  and ${left} more`);
  }

  return `\n\n${covered.length} already have a scenario pointing at them, so this left them alone:\n${lines.join("\n")}`;
}
