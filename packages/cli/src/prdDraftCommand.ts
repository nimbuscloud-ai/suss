/**
 * `suss infer prd` drafts a PRD for each curated boundary intent, with
 * one scenario per outcome.
 *
 * suss can fill in each scenario's link, because the link is the boundary
 * document's name plus the outcome's id. Only a person can write `when`
 * and `expect`, so those are left blank with a hint beside each.
 *
 * The command reads the boundary intent documents, so it only runs once
 * the boundary documents are curated. An uncurated one has a blank
 * purpose and audience and does not load. Drafting from it would link to
 * an outcome id like `200-ok` that the curator may yet rename, and the
 * file suss wrote would then contain a broken link.
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
  /** Like `out`, but refuses a folder that already contains PRDs. */
  into?: string;
}

export interface DraftedPrd {
  /** File name within the destination directory. */
  file: string;
  /** The `name` of the boundary intent the PRD covers. */
  intent: string;
  scenarios: number;
  yaml: string;
}

export interface PrdDraftResult {
  drafted: DraftedPrd[];
  /** Boundary intents that an existing scenario already links to. They get no draft. */
  covered: string[];
}

const PRD_DOC = /\.prd\.(yaml|yml|json)$/;

/** The hint written beside each blank. */
const BLANKS: Record<string, string> = {
  title: "what this document covers, in your words",
  purpose: "why it matters",
  audience: "who cares about it",
  when: "the situation, in your words",
  expect: "what should happen, in your words",
};

/** Keys that get a blank line before them, to split the file into sections. */
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

  // Validate with the blanks filled, so that once written, the file fails
  // to load for the blanks and nothing else.
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

/** `from` is the folder the intent was read from. Each draft's header mentions it. */
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
 * Loads the intent folder, and when it fails to load, says why a PRD
 * needs it to. The usual cause is an uncurated boundary draft, from
 * running `suss infer intent` and then this command straight away.
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

/** How many covered intents the report lists by name before it switches to a count. */
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
