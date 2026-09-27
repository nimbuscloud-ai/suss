/**
 * Brings a project an earlier run loaded up to date with the disk.
 *
 * A long-lived process keeps one adapter between runs, and with it one
 * ts-morph project. Before the next run, every loaded file is stat'ed, a
 * file whose stamp moved is read and compared with the text the project
 * parsed, and a file whose text differs is parsed again. The compiler
 * builds its next program from the old one and keeps every other parse.
 *
 * What was worked out from a changed file is dropped with it. A file
 * joining or leaving the include set, or a tsconfig edit, can move where
 * an unchanged file's imports resolve, so then the caller starts over
 * with a new project. The package README says what is kept and why.
 */

import fs from "node:fs";

import { stampMayMissAWrite } from "@suss/extractor";

import { forgetProgramMemos } from "../programMemo.js";
import { forgetImportsOf } from "./lazyProjectInit.js";

import type { Project, SourceFile } from "ts-morph";

/** What the project was last checked against, kept by the adapter. */
export interface LoadedState {
  /** The stamp each file had when its text was last found to match the parse. */
  readonly verified: Map<string, string>;
  /** The include set the files in the project were loaded from. */
  fileList: ReadonlySet<string> | null;
  configStamp: string | null;
}

export interface RefreshOutcome {
  /** Files parsed again because their text changed. */
  changed: string[];
  /** Why the caller has to start from a new project, or null when it does not. */
  startOver: string | null;
}

export function emptyLoadedState(): LoadedState {
  return { verified: new Map(), fileList: null, configStamp: null };
}

/**
 * Records the include set a run read. Null when the project can go on
 * as it is, or why it has to start over because the set changed since
 * the files in it were loaded.
 */
export function noteRunFileList(
  state: LoadedState,
  tsConfigFilePath: string,
  fileList: readonly string[],
): string | null {
  const now = new Set(fileList);
  if (state.fileList !== null && !sameMembers(state.fileList, now)) {
    return "a file joined or left the tsconfig's include set";
  }
  if (state.fileList === null) {
    state.fileList = now;
    state.configStamp = stampOf(tsConfigFilePath);
  }
  return null;
}

/**
 * Re-reads what changed on disk. `alsoChanged` are paths the caller
 * knows were written, such as the ones a file watcher reported; they are
 * compared with the parse whatever their stamps say. A file added to the
 * include set is found by the next run, which reads the set anyway.
 */
export function refreshLoadedProject(
  project: Project,
  state: LoadedState,
  tsConfigFilePath: string,
  alsoChanged: readonly string[] = [],
): RefreshOutcome {
  const configStamp = stampOf(tsConfigFilePath);
  if (state.configStamp !== null && configStamp !== state.configStamp) {
    return { changed: [], startOver: "the tsconfig changed" };
  }

  for (const known of alsoChanged) {
    state.verified.delete(known);
  }

  const changed: SourceFile[] = [];
  const checkedAt = Date.now();
  for (const sourceFile of project.getSourceFiles()) {
    if (sourceFile.isInNodeModules()) {
      continue;
    }
    const filePath = sourceFile.getFilePath();
    const stat = statOf(filePath);
    if (stat === null) {
      return { changed: [], startOver: `${filePath} was deleted` };
    }
    const stamp = stampFrom(stat);
    if (state.verified.get(filePath) === stamp) {
      continue;
    }
    if (readText(filePath) !== sourceFile.getFullText()) {
      changed.push(sourceFile);
    }
    // Stat'ed before the read, so a later write moves the stamp, unless it
    // lands in the clock tick of the last change. Then the text is compared
    // again next time.
    if (stampMayMissAWrite(stat, checkedAt)) {
      state.verified.delete(filePath);
    } else {
      state.verified.set(filePath, stamp);
    }
  }

  for (const sourceFile of changed) {
    sourceFile.refreshFromFileSystemSync();
  }
  const changedPaths = changed.map((sourceFile) => sourceFile.getFilePath());
  if (changedPaths.length > 0) {
    forgetImportsOf(project, changedPaths);
    forgetProgramMemos(project);
  }
  state.configStamp = configStamp;
  return { changed: changedPaths, startOver: null };
}

function statOf(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function stampFrom(stat: fs.Stats): string {
  return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
}

function stampOf(filePath: string): string | null {
  const stat = statOf(filePath);
  return stat === null ? null : stampFrom(stat);
}

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function sameMembers(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const member of left) {
    if (!right.has(member)) {
      return false;
    }
  }
  return true;
}
