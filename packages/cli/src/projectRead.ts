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
import { extract, packSpecFrom } from "./extract.js";
import { inspectProject } from "./init.js";
import {
  PROJECT_FILE,
  projectFileFor,
  readProjectFile,
} from "./projectFile.js";

import type { ContractSource } from "./contract.js";
import type { Language } from "./language.js";
import type { ContractEntry, ExtractEntry } from "./projectFile.js";

export type ReadEntry = ExtractEntry | ContractEntry;

/** The entries to read for a project, and whether they came from `suss.json`. */
export interface DeclaredReads {
  readonly reads: readonly ReadEntry[];
  /** True when `suss.json` listed the entries, false when detection picked them. */
  readonly declared: boolean;
}

export interface ProjectReadReport {
  readonly summaryDir: string;
  /** The command line of each entry that ran. */
  readonly ran: string[];
  /** One line per entry that threw, with its error message. */
  readonly failed: string[];
  readonly declared: boolean;
}

/**
 * The entries `suss.json` lists, or the ones `init` would pick when there
 * is no file. `reads` is empty for a project that no pack matches.
 */
export async function declaredReads(root: string): Promise<DeclaredReads> {
  const file = readProjectFile(root);
  if (file !== null) {
    return { reads: file.read, declared: true };
  }
  const detected = projectFileFor(await inspectProject(root));
  return { reads: detected?.read ?? [], declared: false };
}

/** The extract entry for one language, or undefined when there is none. */
export function extractEntryFor(
  reads: readonly ReadEntry[],
  language: string,
): ExtractEntry | undefined {
  return reads.find(
    (entry): entry is ExtractEntry =>
      entry.kind === "extract" && entry.language === language,
  );
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
  const project = entry.project === undefined ? "" : ` -p ${entry.project}`;
  return `suss extract --lang ${entry.language}${project} ${packFlags(entry.packs)}`;
}

export function packFlags(packs: readonly string[]): string {
  return packs.map((pack) => `-f ${pack}`).join(" ");
}

/**
 * The line a command prints before it reads a project, so the user knows
 * whether the packs came from `suss.json` or from detection.
 */
export function whereReadsCameFrom(root: string, declared: boolean): string {
  if (declared) {
    return `Reading what ${PROJECT_FILE} says.`;
  }
  return `No ${PROJECT_FILE} in ${root}, so this reads what \`suss init\` would pick. Run \`suss init\` to write that down.`;
}

/**
 * Runs every entry and writes each one's summaries to its own file in
 * `summaryDir`. An entry that throws loses only its own file, so a
 * project with one unreadable spec still gets summaries for the rest.
 */
export async function readProjectInto(
  root: string,
  summaryDir: string,
  reads: DeclaredReads,
): Promise<ProjectReadReport> {
  fs.mkdirSync(summaryDir, { recursive: true });
  const ran: string[] = [];
  const failed: string[] = [];

  for (const [index, entry] of reads.reads.entries()) {
    const out = path.join(summaryDir, readOutputName(index, entry));
    try {
      await runEntry(entry, root, out);
      ran.push(commandFor(entry));
    } catch (error) {
      failed.push(`${commandFor(entry)}: ${messageOf(error)}`);
    }
  }

  return { summaryDir, ran, failed, declared: reads.declared };
}

/** The file one entry's summaries go to, numbered by its place in the list. */
function readOutputName(index: number, entry: ReadEntry): string {
  return `${index}-${entry.kind}.json`;
}

const READ_OUTPUT_NAME = /^\d+-(extract|contract)\.json$/;

/**
 * Removes the files an earlier `readProjectInto` wrote into `dir`, so an
 * entry that fails this time leaves no summaries from last time behind.
 */
export function clearEarlierReads(dir: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    if (READ_OUTPUT_NAME.test(name)) {
      fs.rmSync(path.join(dir, name), { force: true });
    }
  }
}

async function runEntry(
  entry: ReadEntry,
  root: string,
  out: string,
): Promise<void> {
  if (entry.kind === "contract") {
    await contract({
      from: entry.from as ContractSource,
      spec: path.resolve(root, entry.file),
      output: out,
    });
    return;
  }
  await extract({
    dir: root,
    frameworks: packSpecsOf(entry, root),
    output: out,
    lang: entry.language as Language,
    ...(entry.project !== undefined
      ? { tsconfig: path.resolve(root, entry.project) }
      : {}),
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
