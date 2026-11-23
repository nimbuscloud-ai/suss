/**
 * The files in a folder of summaries that are not summaries.
 *
 * `extract` writes a note beside its output when it could not read
 * everything, `<name>.incomplete.json`, and a project can keep its
 * `.sussignore` in the same folder. Every command that reads a folder
 * leaves both out of the summaries it reads, and the commands that
 * report on what is missing read the note.
 */

import fs from "node:fs";
import path from "node:path";

import { readExtractNote } from "./extractNote.js";
import { DEFAULT_SUPPRESSIONS_FILENAMES } from "./suppressionsLoader.js";

import type { PackConfigNeed } from "@suss/extractor";

export function isExtractNote(file: string): boolean {
  return file.endsWith(".incomplete.json");
}

/** The summaries files among a folder's entries. */
export function summaryFilesAmong(entries: readonly string[]): string[] {
  return entries.filter(
    (f) =>
      f.endsWith(".json") &&
      !isExtractNote(f) &&
      !DEFAULT_SUPPRESSIONS_FILENAMES.includes(f),
  );
}

/** The packs that the extracts writing into this folder left out for want of an option. */
export function packsNeedingConfigIn(dir: string): PackConfigNeed[] {
  return fs
    .readdirSync(dir)
    .filter(isExtractNote)
    .flatMap(
      (note) => readExtractNote(path.join(dir, note)).packsNeedingConfig ?? [],
    );
}
