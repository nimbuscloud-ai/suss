/**
 * projectFile.ts: what `suss init` worked out about a project, written
 * down so a later command can read it.
 *
 * `init` finds the packs a project needs and the artifacts it declares,
 * prints them, and forgets. Somebody who then forgets one of the
 * commands gets an empty comparison, because a boundary whose other
 * side lives in an unread artifact pairs with nothing and the run has
 * no way to know the artifact was there.
 *
 * The file is committed. It says what this project contains, which is
 * the same for everybody working on it.
 */

import fs from "node:fs";
import path from "node:path";

import type { InitReport } from "./init.js";

/** The file, at the project root, beside `.sussignore.json`. */
export const PROJECT_FILE = "suss.json";

/** Source that `suss extract` reads, one entry per language. */
export interface ExtractEntry {
  kind: "extract";
  language: string;
  /** The tsconfig to read from, when the language has one. */
  project?: string;
  /** The `-f` names. */
  packs: string[];
}

/** An artifact `suss contract` reads, one entry per file. */
export interface ContractEntry {
  kind: "contract";
  /** The `--from` name. */
  from: string;
  /** Where the artifact is, relative to the project root. */
  file: string;
}

export interface ProjectFile {
  version: 1;
  read: Array<ExtractEntry | ContractEntry>;
}

/** What init found, as the file to write. Null when it found nothing. */
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

/** Null when the project has no file, or one nothing can read. */
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
 * The artifacts the file says this project declares that no summary in
 * the run came from.
 *
 * A contract summary records the artifact it was read from as its file,
 * so an artifact nobody read is one whose path no summary has.
 */
export function unreadArtifacts(
  file: ProjectFile,
  filesRead: ReadonlySet<string>,
): ContractEntry[] {
  return file.read
    .filter((entry): entry is ContractEntry => entry.kind === "contract")
    .filter((entry) => !filesRead.has(entry.file));
}
