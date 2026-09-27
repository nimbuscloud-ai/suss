/**
 * Writes down what `suss init` found, so later commands read the same
 * packs and artifacts without flags.
 *
 * The guided run calls this once the user accepts, and `init --write`
 * calls it without asking. Both write one `suss.json` at the root that
 * lists every project init set up. Whether an existing file may be
 * replaced is up to the caller: the guided run leaves one alone, and
 * `--write` replaces one only with `--overwrite`.
 */

import {
  PROJECT_FILE,
  projectFileFor,
  writeProjectFile,
} from "./projectFile.js";

import type { InitReport } from "./init.js";

/** A project init set up, and where it is relative to the root. */
export interface SetupTarget {
  directory: string;
  report: InitReport;
}

/** One thing the setup did, for the caller to print its own way. */
export interface SetupLine {
  /** `done` for a file written, `note` for something the user still has to do. */
  tone: "done" | "note";
  text: string;
}

/** Writes the setup and says what it wrote. Empty when there was nothing to write. */
export function writeProjectSetup(
  root: string,
  targets: readonly SetupTarget[],
): SetupLine[] {
  const read = targets.flatMap(
    (target) => projectFileFor(target.report, target.directory)?.read ?? [],
  );
  if (read.length === 0) {
    return [];
  }

  writeProjectFile(root, { version: 1, read });
  return [
    {
      tone: "done",
      text: `Wrote ${PROJECT_FILE}. Commit it: it says what the project contains, which is the same for everybody.`,
    },
  ];
}
