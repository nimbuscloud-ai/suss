/**
 * Reads a project when the caller has not said which packs to use.
 *
 * `suss.json` lists a project's packs and artifacts. When the file is
 * missing, the same detection `suss init` runs picks them from the
 * dependency manifests and the files on disk. The command prints a line
 * saying so, and the user can run `init` to write the file. The CLI and
 * the MCP server both read a project through this module, so a bare
 * `suss inspect` and an agent's question describe the same code.
 */

import fs from "node:fs";
import path from "node:path";

import { SUMMARY_SCHEMA_VERSION } from "@suss/behavioral-ir";

import { contract } from "./contract.js";
import {
  extract,
  incompletenessPathFor,
  packSpecFrom,
  splitSpec,
} from "./extract.js";
import { findInitTargets } from "./initTargets.js";
import {
  PROJECT_FILE,
  projectFileFor,
  readEntryIndex,
  readNoteIndex,
  readOutputName,
  readProjectFile,
} from "./projectFile.js";
import { setupReads } from "./projectSetup.js";
import { errorLineOf, readInChild } from "./readInChild.js";
import { durationText } from "./readLimits.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ContractSource } from "./contract.js";
import type { KeptAdapters } from "./keptAdapters.js";
import type { Language } from "./language.js";
import type {
  ContractEntry,
  ExtractEntry,
  ReadFailure,
} from "./projectFile.js";
import type { ChildReadEnd } from "./readInChild.js";
import type { ReadLimits } from "./readLimits.js";

export type ReadEntry = ExtractEntry | ContractEntry;

/** The entries to read for a project, and whether they came from `suss.json`. */
export interface DeclaredReads {
  readonly reads: readonly ReadEntry[];
  /** True when `suss.json` listed the entries, false when detection picked them. */
  readonly declared: boolean;
  /** How many entries `suss.json` gave without the folder they read, which this read found for them. */
  readonly foldersFound?: number;
}

export interface ProjectReadReport {
  readonly summaryDir: string;
  /** The command line of each entry that ran. */
  readonly ran: string[];
  /** How many summaries each entry in `ran` wrote, in the same order. */
  readonly counts: number[];
  /** One line per entry that threw, with its error message. */
  readonly failed: string[];
  /**
   * The command line of each extract that ran and didn't write a summary.
   * Whether that fails the run is up to the command that asked for the
   * read, so the extract itself is told to allow it.
   */
  readonly empty: string[];
  readonly declared: boolean;
}

/**
 * The entries `suss.json` lists, or the ones `init` would pick when there
 * is no file. `reads` is empty for a project that no pack matches.
 */
export async function declaredReads(root: string): Promise<DeclaredReads> {
  const file = readProjectFile(root);
  if (file !== null) {
    return { ...(await withTheirFolders(root, file.read)), declared: true };
  }
  return { reads: await detectedReads(root), declared: false };
}

/**
 * The reads `suss init` finds: in a workspace, one for each package.
 * Reading the root as one project instead puts every package into a
 * single TypeScript program, without their own tsconfig settings, which
 * on a large monorepo runs for half an hour. A pack that needs a config
 * file nobody wrote stays in, unlike in the `suss.json` init writes, so
 * the check reports it as a `packNeedsConfig` finding.
 */
async function detectedReads(root: string): Promise<readonly ReadEntry[]> {
  const targets = await findInitTargets(root);
  return targets.flatMap(
    (target) => projectFileFor(target.report, target.directory)?.read ?? [],
  );
}

/**
 * suss 0.34.0 wrote a monorepo's `suss.json` with no `dir` on any entry
 * and each tsconfig path relative to its own package. Every read then ran
 * at the root, and a TypeScript read pointed at a tsconfig that is not
 * there, or at the root's own. Each such entry gets the folder of the
 * project `suss init` finds with the same language and packs, taken in
 * the order init lists them. An entry that matches no project is read as
 * it is written.
 */
async function withTheirFolders(
  root: string,
  reads: readonly ReadEntry[],
): Promise<{ reads: readonly ReadEntry[]; foldersFound: number }> {
  const unplaced = new Set(
    reads.filter((entry) => lacksItsFolder(root, entry, reads)),
  );
  if (unplaced.size === 0) {
    return { reads, foldersFound: 0 };
  }

  const candidates = setupReads(await findInitTargets(root)).filter(
    (entry): entry is ExtractEntry => entry.kind === "extract",
  );
  const taken = new Set<ExtractEntry>();
  const placed = reads.map((entry) => {
    if (entry.kind !== "extract" || !unplaced.has(entry)) {
      return entry;
    }

    const match = candidates.find(
      (candidate) =>
        !taken.has(candidate) &&
        candidate.language === entry.language &&
        samePacks(candidate.packs, entry.packs),
    );
    if (match === undefined) {
      return entry;
    }

    taken.add(match);
    return match.dir === undefined ? entry : inFolder(entry, match.dir);
  });
  return {
    reads: placed,
    foldersFound: placed.filter((entry, index) => entry !== reads[index])
      .length,
  };
}

/**
 * An entry is missing its folder when it has no `dir` and its tsconfig is
 * not at the root, or when several entries in one language have no `dir`,
 * since only one of them can be the root's own.
 */
function lacksItsFolder(
  root: string,
  entry: ReadEntry,
  reads: readonly ReadEntry[],
): boolean {
  if (entry.kind !== "extract" || entry.dir !== undefined) {
    return false;
  }

  if (entry.project === undefined) {
    return reads.some(
      (other) => other !== entry && isFolderlessIn(other, entry.language),
    );
  }

  if (!fs.existsSync(path.resolve(root, entry.project))) {
    return true;
  }

  // A tsconfig path written from the root already says which folder it is in.
  return (
    path.dirname(entry.project) === "." &&
    reads.some(
      (other) => other !== entry && isFolderlessIn(other, entry.language),
    )
  );
}

function isFolderlessIn(entry: ReadEntry, language: string): boolean {
  return (
    entry.kind === "extract" &&
    entry.language === language &&
    entry.dir === undefined
  );
}

/** The entry as init writes it now, with the folder and a tsconfig path from the root. */
function inFolder(entry: ExtractEntry, dir: string): ExtractEntry {
  return {
    ...entry,
    dir,
    ...(entry.project === undefined
      ? {}
      : { project: path.join(dir, entry.project) }),
  };
}

/** Compares pack names only, since init writes a pack's config path only once the file exists. */
function samePacks(a: readonly string[], b: readonly string[]): boolean {
  const names = (specs: readonly string[]): string =>
    specs
      .map((spec) => splitSpec(spec).name)
      .sort()
      .join(",");
  return names(a) === names(b);
}

/** The extract entry for one language, or undefined when there is none. */
export function extractEntryFor(
  reads: readonly ReadEntry[],
  language: string,
): ExtractEntry | undefined {
  const inLanguage = reads.filter(
    (entry): entry is ExtractEntry =>
      entry.kind === "extract" && entry.language === language,
  );
  // A command run at the root reads the root's own entry before one for
  // a project in a folder below it.
  return inLanguage.find((entry) => entry.dir === undefined) ?? inLanguage[0];
}

/**
 * The entry's packs as `extract` takes them. `suss.json` gives a config
 * path relative to the project root, where the file is.
 */
export function packSpecsOf(entry: ExtractEntry, root: string): string[] {
  return entry.packs.map((spec) => packSpecFrom(root, spec));
}

export function extractLanguagesOf(reads: readonly ReadEntry[]): string[] {
  return reads
    .filter((entry): entry is ExtractEntry => entry.kind === "extract")
    .map((entry) => entry.language);
}

/** The command a user would type to read this entry. */
export function commandFor(entry: ReadEntry): string {
  if (entry.kind === "contract") {
    return `suss contract --from ${entry.from} ${entry.file}`;
  }
  const dir = entry.dir === undefined ? "" : ` --dir ${entry.dir}`;
  const project = entry.project === undefined ? "" : ` -p ${entry.project}`;
  return `suss extract --lang ${entry.language}${dir}${project} ${packFlags(entry.packs)}`;
}

export function packFlags(packs: readonly string[]): string {
  return packs.map((pack) => `-f ${pack}`).join(" ");
}

/**
 * The line a command prints before it reads a project, so the user knows
 * whether the packs came from `suss.json` or from detection.
 */
export function whereReadsCameFrom(
  root: string,
  declared: boolean,
  foldersFound = 0,
): string {
  if (declared && foldersFound > 0) {
    const reads = foldersFound === 1 ? "1 read" : `${foldersFound} reads`;
    return `Reading what ${PROJECT_FILE} says. It gives ${reads} without a folder, the way suss 0.34.0 wrote a monorepo, so each reads the folder \`suss init\` finds with the same packs. Run \`suss init --write --overwrite\` to write the folders into ${PROJECT_FILE}.`;
  }

  if (declared) {
    return `Reading what ${PROJECT_FILE} says.`;
  }
  return `No ${PROJECT_FILE} in ${root}, so this reads what \`suss init\` would pick. Run \`suss init\` to write that down.`;
}

export interface ReadProjectOptions {
  /**
   * A process that reads the project after every edit passes this, so
   * each entry reuses the adapter the last read of it left. Those reads
   * run one after another in this process.
   */
  kept?: KeptAdapters;
  /** Stops each entry printing the temporary file it wrote. */
  quiet?: boolean;
  /**
   * Runs each extract in its own process, this many at once, each
   * stopped at the time and heap limit given.
   */
  limits?: ReadLimits;
  /** Hears about each read as it starts and as it ends. */
  onProgress?: (event: ReadProgress) => void;
}

/** One read starting or ending, for a command that prints progress. */
export type ReadProgress =
  | { kind: "started"; command: string }
  | {
      kind: "ended";
      command: string;
      /** How many reads have ended, this one included, and how many there are. */
      done: number;
      total: number;
      ms: number;
      /** The summary count, or why the read failed. */
      result: { summaries: number } | { failure: Failure };
      /** What the read printed, when it ran in its own process. */
      output?: string;
    };

type Failure = Omit<ReadFailure, "command">;

/** How one read went. */
type EntryResult =
  | { summaries: number; output?: string }
  | { failure: Failure; output?: string };

/**
 * Runs every entry and writes each one's summaries to its own file in
 * `summaryDir`. An entry that fails loses only its own file, so a project
 * with one unreadable spec still gets summaries for the rest, and a note
 * beside the missing file says which read failed and why, which `check`
 * reports as a `readFailed` run finding.
 */
export async function readProjectInto(
  root: string,
  summaryDir: string,
  reads: DeclaredReads,
  options: ReadProjectOptions = {},
): Promise<ProjectReadReport> {
  fs.mkdirSync(summaryDir, { recursive: true });
  options.kept?.startRead();
  const results: EntryResult[] = new Array(reads.reads.length);
  const jobs = options.limits === undefined ? 1 : options.limits.jobs;
  let next = 0;
  let done = 0;

  const worker = async (): Promise<void> => {
    for (let index = next++; index < reads.reads.length; index = next++) {
      const entry = reads.reads[index] as ReadEntry;
      const command = commandFor(entry);
      const out = path.join(summaryDir, readOutputName(index, entry));
      options.onProgress?.({ kind: "started", command });
      const started = performance.now();
      const result = await readEntry(entry, root, out, options);
      if ("failure" in result) {
        fs.rmSync(out, { force: true });
        writeFailureNote(out, { command, ...result.failure });
      }
      results[index] = result;
      done++;
      options.onProgress?.({
        kind: "ended",
        command,
        done,
        total: reads.reads.length,
        ms: performance.now() - started,
        result:
          "failure" in result
            ? { failure: result.failure }
            : { summaries: result.summaries },
        ...(result.output === undefined ? {} : { output: result.output }),
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs, reads.reads.length) }, worker),
  );

  return reportOf(summaryDir, reads, results);
}

function reportOf(
  summaryDir: string,
  reads: DeclaredReads,
  results: readonly EntryResult[],
): ProjectReadReport {
  const report: ProjectReadReport = {
    summaryDir,
    ran: [],
    counts: [],
    failed: [],
    empty: [],
    declared: reads.declared,
  };
  for (const [index, entry] of reads.reads.entries()) {
    const result = results[index] as EntryResult;
    const command = commandFor(entry);
    if ("failure" in result) {
      report.failed.push(`${command}: ${failureText(result.failure)}`);
      continue;
    }

    report.ran.push(command);
    report.counts.push(result.summaries);
    if (entry.kind === "extract" && result.summaries === 0) {
      report.empty.push(command);
    }
  }
  return report;
}

/**
 * An extract runs in its own process when there are limits to keep it
 * to. A contract always runs here: it reads one spec file, and the
 * readers find the project root the same way they do for a user's
 * `suss contract`.
 */
async function readEntry(
  entry: ReadEntry,
  root: string,
  out: string,
  options: ReadProjectOptions,
): Promise<EntryResult> {
  if (entry.kind === "extract" && options.limits !== undefined) {
    return readInItsOwnProcess(entry, root, out, options.limits);
  }

  try {
    const wrote = await runEntry(
      entry,
      root,
      out,
      options.kept,
      options.quiet ?? false,
    );
    return { summaries: wrote.length };
  } catch (error) {
    return { failure: { reason: `stopped on an error: ${messageOf(error)}` } };
  }
}

/** A failure as one line: what happened, then what to do. */
function failureText(failure: Failure): string {
  return failure.remedy === undefined
    ? failure.reason
    : `${failure.reason}. ${failure.remedy}`;
}

async function readInItsOwnProcess(
  entry: ExtractEntry,
  root: string,
  out: string,
  limits: ReadLimits,
): Promise<EntryResult> {
  const { end, output } = await readInChild(entry, root, out, limits);
  if (end.kind !== "finished") {
    return { failure: childFailure(end, output, limits), output };
  }
  return { summaries: summaryCountIn(out), output };
}

function childFailure(
  end: ChildFailure,
  output: string,
  limits: ReadLimits,
): Failure {
  return (
    CHILD_FAILURE[end.kind] as (
      end: ChildFailure,
      output: string,
      limits: ReadLimits,
    ) => Failure
  )(end, output, limits);
}

type ChildFailure = Exclude<ChildReadEnd, { kind: "finished" }>;

const CHILD_FAILURE: {
  [K in ChildFailure["kind"]]: (
    end: Extract<ChildFailure, { kind: K }>,
    output: string,
    limits: ReadLimits,
  ) => Failure;
} = {
  timedOut: (_end, _output, limits) => ({
    reason: `was stopped after ${durationText(limits.timeoutMs)}, the time limit for one read`,
    remedy:
      "Pass --read-timeout with more minutes to give it longer, or 0 for no limit.",
  }),
  outOfMemory: (_end, _output, limits) => ({
    reason: `ran out of its ${limits.memoryMb} MB heap`,
    remedy:
      "Pass --read-memory with more megabytes, or --jobs 1 so it has the machine to itself.",
  }),
  failed: (end, output) => {
    const how =
      end.signal === null
        ? `exited with code ${end.exitCode ?? "unknown"}`
        : `was stopped by ${end.signal}`;
    const last = errorLineOf(output);
    return { reason: last === null ? how : `${how}: ${last}` };
  },
};

/** The summaries an extract wrote, or 0 when it wrote no file. */
function summaryCountIn(file: string): number {
  if (!fs.existsSync(file)) {
    return 0;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(parsed) ? parsed.length : 0;
}

/**
 * The note beside a read's file that says the read failed, so a check
 * over the folder later reports it even though no summaries say so.
 */
function writeFailureNote(out: string, failure: ReadFailure): void {
  fs.writeFileSync(
    incompletenessPathFor(out),
    `${JSON.stringify({ schemaVersion: SUMMARY_SCHEMA_VERSION, readFailed: failure }, null, 2)}\n`,
  );
}

/**
 * Reads the project at `root` into `dir`, saying on stderr which reads
 * run, how each one ends, and how long it took. Null when no pack
 * matched, and the caller says so. With `limits`, each extract runs in
 * its own process at those limits. A read that is not quiet also prints
 * what its extract printed, once it ends.
 */
export async function readProjectSaying(
  root: string,
  dir: string,
  quiet: boolean,
  limits?: ReadLimits,
): Promise<ProjectReadReport | null> {
  const reads = await declaredReads(root);
  if (reads.reads.length === 0) {
    return null;
  }
  process.stderr.write(
    [
      whereReadsCameFrom(root, reads.declared, reads.foldersFound),
      howReadsRun(reads.reads.length, limits),
      ...(quiet ? [] : reads.reads.map((entry) => `  ${commandFor(entry)}`)),
      "",
    ].join("\n"),
  );

  return await readProjectInto(root, dir, reads, {
    quiet,
    ...(limits === undefined ? {} : { limits }),
    onProgress: (event) => {
      process.stderr.write(progressLine(event, quiet));
    },
  });
}

function howReadsRun(count: number, limits: ReadLimits | undefined): string {
  const reads = count === 1 ? "1 read" : `${count} reads`;
  if (limits === undefined) {
    return `${reads}, one at a time:`;
  }
  const atOnce =
    Math.min(limits.jobs, count) === 1
      ? "one at a time"
      : `${Math.min(limits.jobs, count)} at a time`;
  const timeLimit =
    limits.timeoutMs > 0
      ? `, each stopped after ${durationText(limits.timeoutMs)}`
      : "";
  return `${reads}, ${atOnce}${timeLimit}:`;
}

const PROGRESS_LINE: {
  [K in ReadProgress["kind"]]: (
    event: Extract<ReadProgress, { kind: K }>,
    quiet: boolean,
  ) => string;
} = {
  started: (event) => `  started  ${event.command}\n`,
  ended: (event, quiet) => {
    const place = `[${event.done}/${event.total}]`;
    const took = durationText(event.ms);
    const outcome =
      "failure" in event.result
        ? `failed after ${took}\n      ${failureText(event.result.failure)}`
        : `${summaryCount(event.result.summaries)} in ${took}`;
    const printed =
      quiet || event.output === undefined || event.output.trim() === ""
        ? ""
        : `${indented(event.output)}\n`;
    return `  ${place} ${event.command}: ${outcome}\n${printed}`;
  },
};

function progressLine(event: ReadProgress, quiet: boolean): string {
  return (
    PROGRESS_LINE[event.kind] as (event: ReadProgress, quiet: boolean) => string
  )(event, quiet);
}

function summaryCount(count: number): string {
  return `${count} summar${count === 1 ? "y" : "ies"}`;
}

function indented(text: string): string {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `      ${line}`)
    .join("\n");
}

/**
 * Removes the files an earlier `readProjectInto` wrote into `dir`, and
 * the notes beside them, so an entry that fails this time leaves no
 * summaries from last time behind, and one that reads this time leaves
 * no note saying it failed.
 */
export function clearEarlierReads(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (readEntryIndex(name) !== null || readNoteIndex(name) !== null) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

async function runEntry(
  entry: ReadEntry,
  root: string,
  out: string,
  kept: KeptAdapters | undefined,
  quiet: boolean,
): Promise<BehavioralSummary[]> {
  if (entry.kind === "contract") {
    return await contract({
      from: entry.from as ContractSource,
      spec: path.resolve(root, entry.file),
      output: out,
      quiet,
      projectRoot: root,
    });
  }
  return await extract({
    dir: path.resolve(root, entry.dir ?? "."),
    frameworks: packSpecsOf(entry, root),
    output: out,
    quiet,
    lang: entry.language as Language,
    allowEmpty: true,
    ...(kept !== undefined ? { kept } : {}),
    ...(entry.project !== undefined
      ? { tsconfig: path.resolve(root, entry.project) }
      : {}),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
