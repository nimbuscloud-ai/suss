/**
 * Which files are a project's own source, as `suss init` judges it when
 * it looks for a call to a library the language ships, such as fetch.
 * A call in a build script, a config file or a test says nothing about
 * what the application does, so it does not count.
 *
 * For TypeScript and JavaScript, a file counts when the project's
 * tsconfig includes it, or when it is under `src/` and there is no
 * tsconfig. Python and Ruby have no such file, so any file in the project
 * counts. In every language, files under a scripts, tools, config or test
 * directory are left out, and so are `*.config.*` files, tests, type
 * declarations and minified bundles. A folder that declares a project of
 * its own is left to that project.
 */

import fs from "node:fs";
import path from "node:path";

import { readTsconfigFileList, TSCONFIG_NAMES } from "@suss/adapter-typescript";

import {
  languageOfFile,
  projectFilesOf,
  SKIP_DIRECTORIES,
} from "./language.js";

import type { Language } from "./language.js";

/** Directories whose files support the project rather than make it up. */
const NOT_SOURCE_DIRECTORIES = new Set([
  "scripts",
  "script",
  "tools",
  "config",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "spec",
  "e2e",
  "e2e-tests",
  "cypress",
]);

/** `orders.test.ts`, `orders.spec.js`, `orders_test.py`, `orders_spec.rb`, `test_orders.py`. */
const TEST_FILE = /[._](test|spec)\.[a-z]+$|^test_[^.]+\.py$/;

/** `vite.config.ts`, `jest.config.cjs`. */
const CONFIG_FILE = /\.config\.[^.]+$/;

/** A type declaration or a minified copy of a library. */
const DECLARATION_OR_BUNDLE = /\.d\.[cm]?ts$|\.min\.[cm]?js$/;

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

/** How far and how wide the search looks before it gives up. */
const MATCH_DEPTH = 10;
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
    const relative = path.relative(root, file);
    if (
      !relative.startsWith("..") &&
      languageOfFile(file) === language &&
      isProjectSourcePath(relative)
    ) {
      yield file;
    }
  }
}

function typescriptCandidates(root: string): Iterable<string> {
  const tsconfig = TSCONFIG_NAMES.map((name) => path.join(root, name)).find(
    (candidate) => fs.existsSync(candidate),
  );
  if (tsconfig !== undefined) {
    return readTsconfigFileList(tsconfig);
  }
  return filesInProject(root, path.join(root, "src"), "typescript", 1);
}

/** Every file under `dir`, stopping at a folder that declares a project of its own in `language`. */
function* filesInProject(
  root: string,
  dir: string,
  language: Language,
  depth: number,
): Generator<string> {
  if (depth > MATCH_DEPTH) {
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
