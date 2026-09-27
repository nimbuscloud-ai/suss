/**
 * The `suss intent check` command: reads a change list, two folders or
 * files of summaries and, optionally, the messages the developer sent,
 * then prints the verdicts or writes them as JSON.
 *
 * It exits 1 when an entry is not done or a change is not asked for, so
 * a CI job or a hook can act on the exit code. An unchecked entry and an
 * entry nobody asked for do not fail it; they are for a person to read.
 */

import fs from "node:fs";
import path from "node:path";

import { ChangeListRejected, loadChangeListFile } from "@suss/contract-intent";

import { checkIntent } from "./intentCheck.js";
import { readingPairs } from "./readingPairs.js";
import { sentenceList } from "./sentenceList.js";
import { UsageError } from "./usageError.js";

import type { ChangeListSummary } from "@suss/intent-ir";
import type {
  ChangedLine,
  CheckedChange,
  IntentCheckResult,
} from "./intentCheck.js";

export interface IntentCheckCommandOptions {
  /** The change list, YAML or JSON. */
  changes: string;
  /** Summaries from before the change: a folder, or one file. */
  before: string;
  /** Summaries from after it, the same kind of path as `before`. */
  after: string;
  /** The developer's messages, one JSON object with a `prompt` per line, or plain text. */
  prompts?: string;
  json?: boolean;
}

export function intentCheckCommand(options: IntentCheckCommandOptions): number {
  const list = changeListOrRejection(options.changes);
  if (list instanceof ChangeListRejected) {
    return refuse(list, options.json === true);
  }
  const prompts =
    options.prompts === undefined ? null : readPrompts(options.prompts);
  const result = checkIntent(
    list,
    readingPairs(options.before, options.after),
    prompts,
  );
  const text = renderIntentCheck(result);
  process.stdout.write(
    options.json === true
      ? `${JSON.stringify({ version: 1, ...result, text }, null, 2)}\n`
      : `${text}\n`,
  );
  return fails(result) ? 1 : 0;
}

function fails(result: IntentCheckResult): boolean {
  return (
    result.notAsked.length > 0 ||
    result.entries.some((entry) => entry.verdict === "notDone")
  );
}

function changeListOrRejection(
  file: string,
): ChangeListSummary | ChangeListRejected {
  try {
    return loadChangeListFile(file);
  } catch (error) {
    if (error instanceof ChangeListRejected) {
      return error;
    }
    throw error;
  }
}

/**
 * Refuses a list somebody has to fix. With `--json` the refusal comes
 * under `rejected`, so a caller such as the plugin's Stop hook can tell
 * it apart from a run that failed for another reason.
 */
function refuse(rejected: ChangeListRejected, json: boolean): number {
  if (json) {
    const refusal = {
      version: 1,
      error: rejected.message,
      rejected: { file: rejected.file, problems: rejected.problems },
    };
    process.stdout.write(`${JSON.stringify(refusal, null, 2)}\n`);
  }
  process.stderr.write(`${rejected.message}\n`);
  return 1;
}

/** The change list, or a usage error that says what in it does not fit. */
export function readChangeList(file: string): ChangeListSummary {
  try {
    return loadChangeListFile(file);
  } catch (error) {
    throw new UsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The plugin's session record keeps one JSON object per line, with the
 * message under `prompt`. Any other file is taken as one message.
 */
export function readPrompts(file: string): string[] {
  if (!fs.existsSync(file)) {
    throw new UsageError(`No file of messages at ${path.resolve(file)}.`);
  }
  const text = fs.readFileSync(file, "utf-8");
  if (!file.endsWith(".jsonl")) {
    return [text];
  }
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(promptOf);
}

function promptOf(line: string): string {
  try {
    const parsed = JSON.parse(line) as { prompt?: unknown };
    return typeof parsed.prompt === "string" ? parsed.prompt : "";
  } catch {
    return line;
  }
}

// ---------------------------------------------------------------------------
// The printed report
// ---------------------------------------------------------------------------

const VERDICT_LABELS: Record<CheckedChange["verdict"], string> = {
  done: "done",
  notDone: "not done",
  unchecked: "unchecked",
};

/** The widest label, `unrequested`, and the space after it. */
const LABEL_WIDTH = 12;

const INDENT = " ".repeat(LABEL_WIDTH);

/**
 * The verdicts in the order a reader acts on them: what is done, what
 * is not, what suss could not check, then the changes nobody asked for.
 */
export function renderIntentCheck(result: IntentCheckResult): string {
  const requested = result.entries.filter((entry) => entry.requested !== false);
  const sections = [
    ...(["done", "notDone", "unchecked"] as const).map((verdict) =>
      entrySection(
        VERDICT_LABELS[verdict],
        requested.filter((entry) => entry.verdict === verdict),
      ),
    ),
    entrySection(
      "unrequested",
      result.entries.filter((entry) => entry.requested === false),
    ),
    labelled(
      "not asked",
      result.notAsked
        .flatMap((change) => blockLines(worthShowing(change.lines)))
        .map((line) => line.slice(INDENT.length)),
    ),
    ...result.explained
      .filter((one) => one.lines.length > 0)
      .map((one) => [
        ...labelled("explained", [one.said, `  why: ${one.why}`]),
        ...blockLines(worthShowing(one.lines)),
      ]),
    wrapperSection(result),
  ].filter((section) => section.length > 0);
  return [headline(result), "", ...sections.flat()].join("\n");
}

/**
 * The lines that say what changed. An outcome whose condition moved only
 * because of a new branch beside it is left out when the new branch is
 * listed, since it repeats that branch's condition.
 */
function worthShowing(lines: ChangedLine[]): ChangedLine[] {
  const changed = lines.filter((line) => !line.conditionMoved);
  return changed.length === 0 ? lines : changed;
}

function headline(result: IntentCheckResult): string {
  const counts = (["done", "notDone", "unchecked"] as const)
    .map((verdict) => ({
      verdict,
      count: result.entries.filter((entry) => entry.verdict === verdict).length,
    }))
    .filter((one) => one.count > 0)
    .map((one) => `${one.count} ${VERDICT_LABELS[one.verdict]}`);
  const unasked = result.notAsked.length;
  if (unasked > 0) {
    counts.push(
      `${unasked} boundar${unasked === 1 ? "y" : "ies"} changed where nobody asked`,
    );
  }
  if (counts.length === 0) {
    return "The change list has no entries and nothing changed.";
  }
  return `${sentenceList(counts)}.`;
}

function entrySection(label: string, entries: CheckedChange[]): string[] {
  return labelled(
    label,
    entries.flatMap((entry) => [
      entry.units.length === 0
        ? entry.said
        : `${entry.said}  ${entry.units.join(", ")}`,
      ...detailOf(entry, label).map((line) => `  ${line}`),
    ]),
  );
}

function detailOf(entry: CheckedChange, label: string): string[] {
  const lines = entry.reason === null ? [] : [entry.reason];
  if (label !== "unrequested") {
    return lines;
  }
  const verdict = `${VERDICT_LABELS[entry.verdict]}.`;
  const why =
    entry.asked === null
      ? "The entry quotes no message from the developer."
      : `No message the developer sent contains "${entry.asked}".`;
  return [`${verdict[0]?.toUpperCase()}${verdict.slice(1)} ${why}`, ...lines];
}

/** Lines grouped under the boundary and unit they changed at. */
function blockLines(lines: ChangedLine[]): string[] {
  const byBlock = new Map<string, ChangedLine[]>();
  for (const line of lines) {
    const heading = `${line.does} ${line.boundary}  ${line.file}::${line.unit}`;
    byBlock.set(heading, [...(byBlock.get(heading) ?? []), line]);
  }
  return [...byBlock.entries()].flatMap(([heading, under]) => [
    `${INDENT}${heading}`,
    ...under.flatMap((line) => line.text.map((text) => `${INDENT}  ${text}`)),
  ]);
}

function wrapperSection(result: IntentCheckResult): string[] {
  return labelled(
    "wrapper",
    result.fromWrappers.map(
      (line) =>
        `${line.change === "added" ? "+" : "-"} ${line.outcome}  from ${line.from.name} (${line.from.file}), at ${line.at.join(", ")}`,
    ),
  );
}

/** The label on the first line, the rest indented under it. */
function labelled(label: string, lines: string[]): string[] {
  return lines.map((line, index) =>
    index === 0 ? `${label.padEnd(LABEL_WIDTH)}${line}` : `${INDENT}${line}`,
  );
}
