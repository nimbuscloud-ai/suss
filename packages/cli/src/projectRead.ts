/**
 * projectRead.ts: read a project without being told which packs to use.
 *
 * `suss.json` says which packs and artifacts a project has. When the
 * file is missing, the detection `init` runs picks them from the
 * dependency manifests and the files on disk, and the command says
 * so, so the person can write the file down with `init`. The CLI and
 * the MCP server both read a project this way, so a bare
 * `suss inspect` and an agent's question describe the same code.
 */

import fs from "node:fs";
import path from "node:path";

import { contract } from "./contract.js";
import { extract } from "./extract.js";
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

/** What a project says to read, and whether a `suss.json` said it. */
export interface DeclaredReads {
  readonly reads: readonly ReadEntry[];
  /** True when `suss.json` was read; false when detection picked them. */
  readonly declared: boolean;
}

/** What reading a project into a directory produced. */
export interface ProjectReadReport {
  readonly summaryDir: string;
  /** One command line per entry that ran. */
  readonly ran: string[];
  /** One line per entry that threw, with what it said. */
  readonly failed: string[];
  readonly declared: boolean;
}

/**
 * What `suss.json` says to read, or what `init` would pick when there
 * is no file. Both come back empty for a project nothing matches.
 */
export async function declaredReads(root: string): Promise<DeclaredReads> {
  const file = readProjectFile(root);
  if (file !== null) {
    return { reads: file.read, declared: true };
  }
  const detected = projectFileFor(await inspectProject(root));
  return { reads: detected?.read ?? [], declared: false };
}

/** The extract entry for one language, if the project has one. */
export function extractEntryFor(
  reads: readonly ReadEntry[],
  language: string,
): ExtractEntry | undefined {
  return reads.find(
    (entry): entry is ExtractEntry =>
      entry.kind === "extract" && entry.language === language,
  );
}

/** The languages the project has extract entries for. */
export function extractLanguagesOf(reads: readonly ReadEntry[]): string[] {
  return reads
    .filter((entry): entry is ExtractEntry => entry.kind === "extract")
    .map((entry) => entry.language);
}

/** The entry as the command a person would type. */
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
 * The line a command prints before it reads a project it was not told
 * about, so the person knows where the packs came from.
 */
export function whereReadsCameFrom(root: string, declared: boolean): string {
  if (declared) {
    return `Reading what ${PROJECT_FILE} says.`;
  }
  return `No ${PROJECT_FILE} in ${root}, so this reads what \`suss init\` would pick. Run \`suss init\` to write that down.`;
}

/**
 * Run every entry into the directory, one file each. An entry that
 * throws takes down its own file and nothing else, so a project with
 * one unreadable spec still describes the code suss could read.
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
    const out = path.join(summaryDir, `${index}-${entry.kind}.json`);
    try {
      await runEntry(entry, root, out);
      ran.push(commandFor(entry));
    } catch (error) {
      failed.push(`${commandFor(entry)}: ${messageOf(error)}`);
    }
  }

  return { summaryDir, ran, failed, declared: reads.declared };
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
    frameworks: entry.packs,
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
