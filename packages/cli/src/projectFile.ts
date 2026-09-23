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

import type { InitReport } from "./init.js";

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

export interface ProjectFile {
  version: 1;
  read: Array<ExtractEntry | ContractEntry>;
}

/** The file to write for what init found, or null when it found nothing. */
export function projectFileFor(report: InitReport): ProjectFile | null {
  const contracts: ContractEntry[] = report.suggestions
    .filter((one) => one.kind === "contract" && one.file !== undefined)
    .map((one) => ({
      kind: "contract",
      from: one.name,
      file: one.file as string,
    }));

  const byLanguage = new Map<string, string[]>();
  for (const one of report.suggestions) {
    if (one.kind === "contract" || one.language === undefined) {
      continue;
    }
    byLanguage.set(one.language, [
      ...(byLanguage.get(one.language) ?? []),
      one.name,
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

/**
 * The artifacts listed in `suss.json` that no summary in the run came
 * from.
 *
 * A contract summary's file is the artifact it was read from, so an
 * artifact that was never read is one that no summary has as its file.
 */
export function unreadArtifacts(
  file: ProjectFile,
  filesRead: ReadonlySet<string>,
): ContractEntry[] {
  return file.read
    .filter((entry): entry is ContractEntry => entry.kind === "contract")
    .filter((entry) => !filesRead.has(entry.file));
}
