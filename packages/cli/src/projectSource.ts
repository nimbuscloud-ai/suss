/**
 * Which files are a project's own source, as `suss init` judges it when
 * it looks for a call to a library the language ships, such as fetch.
 * A call in a build script, a config file or a test says nothing about
 * what the application does, so it does not count.
 *
 * For TypeScript and JavaScript, a file counts when the tsconfig an
 * extract would use, the project's own or the nearest one above it,
 * includes it. Without a tsconfig, as in a Rails app's
 * `app/javascript`, and in Python and Ruby, any file in the project
 * counts. In every language, tooling, tests, build output, dependencies,
 * `*.config.*` files, type declarations and bundles are left out. A
 * folder that declares a project of its own is left to that project.
 */

import fs from "node:fs";
import path from "node:path";

import {
  findNearestTsconfig,
  readTsconfigFileList,
} from "@suss/adapter-typescript";

import {
  languageOfFile,
  projectFilesOf,
  SKIP_DIRECTORIES,
} from "./language.js";

import type { Language } from "./language.js";

/** Folders of tests and the fixtures they read, which describe no service of the project's own. */
export const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "__fixtures__",
  "fixtures",
  "e2e",
  "e2e-tests",
  "cypress",
]);

/** On top of `SKIP_DIRECTORIES`, which has the dependency and build output folders. */
const NOT_SOURCE_DIRECTORIES = new Set([
  ...TEST_DIRECTORIES,
  "public",
  "builds",
  "generated",
  "__generated__",
  "scripts",
  "script",
  "tools",
  "config",
  "spec",
]);

/** `orders.test.ts`, `orders.spec.js`, `orders_test.py`, `orders_spec.rb`, `test_orders.py`. */
const TEST_FILE = /[._](test|spec)\.[a-z]+$|^test_[^.]+\.py$/;

/** `vite.config.ts`, `jest.config.cjs`. */
const CONFIG_FILE = /\.config\.[^.]+$/;

/** A type declaration, or a minified, bundled or generated build of some code. */
const DECLARATION_OR_BUNDLE =
  /\.d\.[cm]?ts$|[.-](min|bundle|chunk)\.[cm]?js$|\.generated\.[cm]?[jt]sx?$/;

/** Whether a path, relative to its project, is one of the project's own source files. */
export function isProjectSourcePath(relative: string): boolean {
  const segments = relative.split(/[\\/]/);
  const name = segments.pop() ?? "";
  return (
    segments.every(isSourceDirectoryName) &&
    !TEST_FILE.test(name) &&
    !CONFIG_FILE.test(name) &&
    !DECLARATION_OR_BUNDLE.test(name)
  );
}

const isSourceDirectoryName = (name: string): boolean =>
  !NOT_SOURCE_DIRECTORIES.has(name) &&
  !SKIP_DIRECTORIES.has(name) &&
  !name.startsWith(".");

/**
 * How many folders down a walk of one project goes. Init's walk for
 * contract files goes as deep, so a spec next to the code is found.
 */
export const PROJECT_WALK_DEPTH = 10;
/** How many files the search for a call looks at before it gives up. */
const MATCH_FILES = 5000;
/** A file this large is a bundle or generated code, not something the project wrote. */
const MATCH_FILE_BYTES = 512 * 1024;

/**
 * The first of the project's own source files in `language` whose text
 * matches `pattern`, relative to `root`, or null when none does.
 */
export function firstSourceMatching(
  root: string,
  language: Language,
  pattern: RegExp,
): string | null {
  let budget = MATCH_FILES;
  for (const file of projectSourceFiles(root, language)) {
    if (budget <= 0) {
      return null;
    }

    budget -= 1;
    if (matchesText(file, pattern)) {
      return path.relative(root, file);
    }
  }
  return null;
}

/** Whether the project has any source file of its own in `language`. */
export function hasProjectSource(root: string, language: Language): boolean {
  return !projectSourceFiles(root, language).next().done;
}

/** The project's own source files in `language`, as absolute paths. */
export function* projectSourceFiles(
  root: string,
  language: Language,
): Generator<string> {
  const candidates =
    language === "typescript"
      ? typescriptCandidates(root)
      : filesInProject(root, root, language, 0);
  for (const file of candidates) {
    if (
      isSameOrUnder(file, root) &&
      languageOfFile(file) === language &&
      isProjectSourcePath(path.relative(root, file))
    ) {
      yield file;
    }
  }
}

/** Whether `file` is `directory` itself or anywhere below it. */
export function isSameOrUnder(file: string, directory: string): boolean {
  const relative = path.relative(directory, file);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Whether an extract of `root` in `language` would have a file to read.
 * A folder with no tsconfig of its own is read through the nearest one
 * above it, and that one may include nothing in the folder.
 */
export function extractReadsAnything(
  root: string,
  language: Language,
): boolean {
  const candidates =
    language === "typescript"
      ? typescriptCandidates(root)
      : filesInProject(root, root, language, 0);
  for (const file of candidates) {
    if (isSameOrUnder(file, root) && languageOfFile(file) === language) {
      return true;
    }
  }
  return false;
}

/** The files an extract of `root` walks, before it keeps the ones under `root`. */
function typescriptCandidates(root: string): Iterable<string> {
  const tsconfig = findNearestTsconfig(root);
  if (tsconfig !== null) {
    return readTsconfigFileList(tsconfig);
  }
  return filesInProject(root, root, "typescript", 0);
}

/** Every file under `dir`, stopping at a folder that declares a project of its own in `language`. */
function* filesInProject(
  root: string,
  dir: string,
  language: Language,
  depth: number,
): Generator<string> {
  if (depth > PROJECT_WALK_DEPTH) {
    return;
  }
  if (dir !== root && projectFilesOf(dir, language).length > 0) {
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const directories: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) {
      yield full;
      continue;
    }

    if (isSourceDirectoryName(entry.name)) {
      directories.push(full);
    }
  }

  for (const directory of directories) {
    yield* filesInProject(root, directory, language, depth + 1);
  }
}

function matchesText(file: string, pattern: RegExp): boolean {
  try {
    if (fs.statSync(file).size > MATCH_FILE_BYTES) {
      return false;
    }
    return pattern.test(fs.readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}
