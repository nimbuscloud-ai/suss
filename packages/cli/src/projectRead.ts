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

import { contract } from "./contract.js";
import { extract, packSpecFrom, splitSpec } from "./extract.js";
import { inspectProject } from "./init.js";
import { findInitTargets } from "./initTargets.js";
import {
  PROJECT_FILE,
  projectFileFor,
  readEntryIndex,
  readOutputName,
  readProjectFile,
} from "./projectFile.js";
import { setupReads } from "./projectSetup.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { ContractSource } from "./contract.js";
import type { KeptAdapters } from "./keptAdapters.js";
import type { Language } from "./language.js";
import type { ContractEntry, ExtractEntry } from "./projectFile.js";

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
  const detected = projectFileFor(await inspectProject(root));
  return { reads: detected?.read ?? [], declared: false };
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

/**
 * Runs every entry and writes each one's summaries to its own file in
 * `summaryDir`. An entry that throws loses only its own file, so a
 * project with one unreadable spec still gets summaries for the rest.
 * A process that reads the project after every edit passes `kept`, so
 * each entry reuses the adapter the last read of it left. `quiet` stops
 * each entry printing the temporary file it wrote.
 */
export async function readProjectInto(
  root: string,
  summaryDir: string,
  reads: DeclaredReads,
  kept?: KeptAdapters,
  quiet = false,
): Promise<ProjectReadReport> {
  fs.mkdirSync(summaryDir, { recursive: true });
  const ran: string[] = [];
  const counts: number[] = [];
  const failed: string[] = [];
  const empty: string[] = [];
  kept?.startRead();

  for (const [index, entry] of reads.reads.entries()) {
    const out = path.join(summaryDir, readOutputName(index, entry));
    try {
      const wrote = await runEntry(entry, root, out, kept, quiet);
      ran.push(commandFor(entry));
      counts.push(wrote.length);
      if (entry.kind === "extract" && wrote.length === 0) {
        empty.push(commandFor(entry));
      }
    } catch (error) {
      failed.push(`${commandFor(entry)}: ${messageOf(error)}`);
    }
  }

  return { summaryDir, ran, counts, failed, empty, declared: reads.declared };
}

/**
 * Removes the files an earlier `readProjectInto` wrote into `dir`, so an
 * entry that fails this time leaves no summaries from last time behind.
 */
export function clearEarlierReads(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (readEntryIndex(name) !== null) {
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
