/**
 * Which files on disk are test code, for one run of an adapter.
 *
 * `isTestFile` counts a `test`, `tests`, `spec` or `e2e` folder only at
 * the top of a project, so it needs a file's path from there. This
 * measures an absolute path from the top of each project the file is
 * in: the run's root, and every directory between the root and the file
 * with a package.json, pyproject.toml, setup.py, setup.cfg, Gemfile or
 * gemspec. A file is test code when its path from any of them is, so
 * `packages/api/test/app.js` is test code in a run over the repository,
 * and so is a sample app with its own package.json under `test/`. A file
 * outside the root counts every such directory above it, up to the top
 * of its repository.
 */

import fs from "node:fs";
import path from "node:path";

import { isTestFile } from "./testFiles.js";

const MANIFESTS = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Gemfile",
]);

/** What a directory says about where projects start. */
interface DirectoryMarks {
  manifest: boolean;
  repositoryTop: boolean;
}

const NO_MARKS: DirectoryMarks = { manifest: false, repositoryTop: false };

function marksOf(dir: string): DirectoryMarks {
  try {
    const names = fs.readdirSync(dir);
    return {
      manifest: names.some(
        (name) => MANIFESTS.has(name) || name.endsWith(".gemspec"),
      ),
      // A linked worktree writes `.git` as a file, so any entry counts.
      repositoryTop: names.includes(".git"),
    };
  } catch {
    return NO_MARKS;
  }
}

function isSameOrUnder(dir: string, file: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether each file is test code in a run over `root`. A relative path
 * is read from the root. Each directory is read once, so a caller makes
 * one of these per run and asks it about every file.
 */
export function testFilesUnder(root: string): (file: string) => boolean {
  const top = path.resolve(root);
  const marks = new Map<string, DirectoryMarks>();
  const answers = new Map<string, boolean>();
  const marksAt = (dir: string): DirectoryMarks => {
    const known = marks.get(dir);
    if (known !== undefined) {
      return known;
    }
    const found = marksOf(dir);
    marks.set(dir, found);
    return found;
  };
  const testCodeFrom = (dir: string, file: string): boolean =>
    isTestFile(path.relative(dir, file));

  const read = (file: string): boolean => {
    if (testCodeFrom(top, file)) {
      return true;
    }
    const inRun = isSameOrUnder(top, file);
    for (let dir = path.dirname(file); dir !== top; dir = path.dirname(dir)) {
      const at = marksAt(dir);
      if (at.manifest && testCodeFrom(dir, file)) {
        return true;
      }

      if (path.dirname(dir) === dir || (!inRun && at.repositoryTop)) {
        return false;
      }
    }
    return false;
  };

  return (file) => {
    const absolute = path.resolve(top, file);
    const known = answers.get(absolute);
    if (known !== undefined) {
      return known;
    }
    const found = read(absolute);
    answers.set(absolute, found);
    return found;
  };
}

const runs = new WeakMap<object, (file: string) => boolean>();

/**
 * Says where a run is measured from. `run` is what the adapter keeps for
 * the run, such as its project or its database of facts, and whatever
 * reaches it later asks `isTestFileIn` with the same object.
 */
export function readTestFilesFrom(run: object, root: string): void {
  runs.set(run, testFilesUnder(root));
}

/**
 * Whether `file` is test code in `run`. A run nobody gave a root reads
 * the path as `isTestFile` does, so an absolute path has no top folder.
 */
export function isTestFileIn(run: object, file: string): boolean {
  return (runs.get(run) ?? isTestFile)(file);
}
