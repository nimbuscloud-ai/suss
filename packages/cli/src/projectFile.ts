/**
 * Reads and writes `suss.json`, where `suss init` records what it found
 * about a project so that later commands can read it.
 *
 * Without the file, init prints the packs a project needs and the
 * artifacts it declares, and nothing remembers them. A user who then
 * skips one of the commands gets an empty comparison: a boundary whose
 * other side is in an unread artifact pairs with nothing, and the run
 * cannot tell that the artifact exists.
 *
 * The file is meant to be committed, because what the project contains
 * is the same for everyone working on it.
 */

import fs from "node:fs";
import path from "node:path";

import type { InitReport, PackSuggestion } from "./init.js";

/** Written at the project root, next to `.sussignore.json`. */
export const PROJECT_FILE = "suss.json";

/** Source that `suss extract` reads, one entry per language. */
export interface ExtractEntry {
  kind: "extract";
  language: string;
  /** The tsconfig, for TypeScript. */
  project?: string;
  /** Pack names as `-f` takes them. */
  packs: string[];
}

/** An artifact `suss contract` reads, one entry per file. */
export interface ContractEntry {
  kind: "contract";
  /** The source kind as `--from` takes it. */
  from: string;
  /** Relative to the project root. */
  file: string;
}

/**
 * One module of the application: what the team calls it, the folder its
 * code is in, and the files other modules are meant to call it through.
 * Paths are relative to the directory `suss.json` is in.
 */
export interface ModuleEntry {
  name: string;
  root: string;
  /** Left out, the language's entry file is: `index.ts`, `__init__.py`, or a Ruby file named for the module. */
  public?: string | string[];
}

export interface ProjectFile {
  version: 1;
  read: Array<ExtractEntry | ContractEntry>;
  /** Read by `suss extract`, which keys each module's public exports by its name. */
  modules?: ModuleEntry[];
}

/**
 * The file to write for what init found, or null when it found nothing.
 * `directory` is where the project is, relative to the root the file is
 * written at, and goes in front of each contract's and config's path.
 * The packs in `leftOut` are not listed.
 */
export function projectFileFor(
  report: InitReport,
  directory = ".",
  leftOut: ReadonlySet<string> = new Set(),
): ProjectFile | null {
  const contracts: ContractEntry[] = report.suggestions
    .filter((one) => one.kind === "contract" && one.file !== undefined)
    .map((one) => ({
      kind: "contract",
      from: one.name,
      file: path.join(directory, one.file as string),
    }));

  const byLanguage = new Map<string, string[]>();
  for (const one of report.suggestions) {
    if (
      one.kind === "contract" ||
      one.language === undefined ||
      leftOut.has(one.name)
    ) {
      continue;
    }
    byLanguage.set(one.language, [
      ...(byLanguage.get(one.language) ?? []),
      packSpecFor(report.root, directory, one),
    ]);
  }

  const extracts: ExtractEntry[] = [...byLanguage].map(([language, packs]) => ({
    kind: "extract",
    language,
    ...(language === "typescript" && report.tsconfig !== null
      ? { project: path.relative(report.root, report.tsconfig) }
      : {}),
    packs,
  }));

  const read = [...extracts, ...contracts];
  return read.length === 0 ? null : { version: 1, read };
}

/**
 * A pack as `-f` takes it. A pack's config file is named once it is on
 * disk, because `-f rails=suss.rails.json` stops the extract when the file
 * is missing.
 */
function packSpecFor(
  projectRoot: string,
  directory: string,
  suggestion: PackSuggestion,
): string {
  const file = suggestion.configuration?.file;
  if (file === undefined || !fs.existsSync(path.join(projectRoot, file))) {
    return suggestion.name;
  }
  return `${suggestion.name}=${path.join(directory, file)}`;
}

/** Null when the project has no `suss.json`, or one that does not parse. */
export function readProjectFile(root: string): ProjectFile | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(root, PROJECT_FILE), "utf8"),
    ) as ProjectFile;
    return Array.isArray(parsed?.read) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProjectFile(root: string, file: ProjectFile): void {
  fs.writeFileSync(
    path.join(root, PROJECT_FILE),
    `${JSON.stringify(file, null, 2)}\n`,
  );
}

/** The file one entry's summaries go to, numbered by its place in `read`. */
export function readOutputName(
  index: number,
  entry: ExtractEntry | ContractEntry,
): string {
  return `${index}-${entry.kind}.json`;
}

const READ_OUTPUT_NAME = /^(\d+)-(extract|contract)\.json$/;

/**
 * The place in `read` of the entry whose summaries were written to this
 * file, or null for a file `readOutputName` did not name.
 */
export function readEntryIndex(fileName: string): number | null {
  const match = READ_OUTPUT_NAME.exec(fileName);
  return match === null ? null : Number(match[1]);
}

/** What a run read, as a check over a folder of summaries can tell. */
export interface ReadInRun {
  /** Each summary's file, which for a contract is the reader's label for the artifact. */
  labels: ReadonlySet<string>;
  /** The places in `read` of the entries `suss extract --out-dir` wrote into the folder. */
  entries: ReadonlySet<number>;
}

/**
 * The artifacts listed in `suss.json` that no summary in the run came
 * from. An artifact counts as read when `extract --out-dir` wrote its
 * entry into the folder, or when a summary's label says it came from
 * that file.
 */
export function unreadArtifacts(
  file: ProjectFile,
  read: ReadInRun,
): ContractEntry[] {
  return file.read.flatMap((entry, index) =>
    entry.kind !== "contract" ||
    read.entries.has(index) ||
    [...read.labels].some((label) => labelIsOf(label, entry))
      ? []
      : [entry],
  );
}

/**
 * Whether a summary with this label was read from the artifact. A reader
 * labels its summaries with its name and the file's path, as in
 * `cloudformation:infra/template.yaml`. The reader may count the path
 * from the repository root or give only the file name, while `suss.json`
 * counts it from the project, so either path may end with the other.
 */
function labelIsOf(label: string, entry: ContractEntry): boolean {
  const prefix = `${entry.from}:`;
  const written = label.startsWith(prefix) ? label.slice(prefix.length) : label;
  return (
    written === entry.file ||
    written.endsWith(`/${entry.file}`) ||
    entry.file.endsWith(`/${written}`)
  );
}
