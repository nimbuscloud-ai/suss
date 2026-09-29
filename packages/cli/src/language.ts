/**
 * Works out which language a directory is written in.
 *
 * suss has one adapter per language behind a single interface, so running
 * `suss extract` on a Python project only requires knowing that the
 * directory is a Python project. The user can say so with --lang, but
 * usually does not need to. A project's top level usually contains a
 * manifest such as `pyproject.toml`, and failing that, its source files
 * have a language's suffix. The detection only looks near the top of the
 * tree, because the walk has not read anything deeper at this point.
 */

import fs from "node:fs";
import path from "node:path";

import { SOURCE_SUFFIXES } from "@suss/adapter-typescript";

export type Language = "typescript" | "python" | "ruby";

export const LANGUAGES: readonly Language[] = ["typescript", "python", "ruby"];

export function parseLanguage(value: string): Language | null {
  const found = LANGUAGES.find((language) => language === value);
  return found ?? null;
}

export const LANGUAGE_LABEL: Record<Language, string> = {
  typescript: "TypeScript",
  python: "Python",
  ruby: "Ruby",
};

/** `suss init` skips these too, so both walks skip the same directories. */
export const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".git",
  ".turbo",
  ".next",
  ".suss",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  "tmp",
]);

interface LanguageMarkers {
  /** Relative to the project root. */
  projectFiles: readonly string[];
  sourceSuffixes: readonly string[];
}

const MARKERS: Record<Language, LanguageMarkers> = {
  typescript: {
    projectFiles: ["package.json", "tsconfig.json", "jsconfig.json"],
    sourceSuffixes: SOURCE_SUFFIXES,
  },
  python: {
    projectFiles: [
      "pyproject.toml",
      "requirements.txt",
      "requirements.in",
      "requirements-dev.txt",
      "requirements-test.txt",
      "setup.py",
      "setup.cfg",
      "Pipfile",
      "uv.lock",
      "environment.yml",
      "environment.yaml",
    ],
    sourceSuffixes: [".py"],
  },
  ruby: {
    // A Rails app that vendors its gems has no lock file at the top level,
    // so config/application.rb marks it instead.
    projectFiles: ["Gemfile", "Gemfile.lock", "config/application.rb"],
    sourceSuffixes: [".rb"],
  },
};

/** The language of a source file, judged by its suffix, or null when no adapter reads that suffix. */
export function languageOfFile(file: string): Language | null {
  const found = LANGUAGES.find((language) =>
    MARKERS[language].sourceSuffixes.some((suffix) => file.endsWith(suffix)),
  );
  return found ?? null;
}

export function projectFilesOf(root: string, language: Language): string[] {
  return MARKERS[language].projectFiles.filter((name) =>
    fs.existsSync(path.join(root, name)),
  );
}

export function detectLanguages(root: string): Language[] {
  return LANGUAGES.filter(
    (language) =>
      projectFilesOf(root, language).length > 0 ||
      hasSourceFile(root, MARKERS[language].sourceSuffixes),
  );
}

export interface ProjectLanguageContext {
  /** Whether a tsconfig above this directory covers it. */
  coveredByTsconfig?: boolean;
}

/**
 * A manifest in the directory itself decides the language first. Next
 * comes a tsconfig in a parent directory that covers it, and last the
 * source files. When more than one language matches at the same step,
 * TypeScript comes first.
 */
export function languageOfProject(
  root: string,
  context: ProjectLanguageContext = {},
): { language: Language } | { cannotTell: string } {
  const found = detectLanguages(root);
  const declared = found.find(
    (language) => projectFilesOf(root, language).length > 0,
  );
  if (declared !== undefined) {
    return { language: declared };
  }

  if (context.coveredByTsconfig === true) {
    return { language: "typescript" };
  }

  const first = found[0];
  if (first === undefined) {
    return {
      cannotTell: `suss could not tell what language ${root} is written in: nothing there names a project, and it holds no TypeScript, Python, or Ruby source. Pass --lang to say which it is.`,
    };
  }
  return { language: first };
}

/** How far and how wide `firstSourceMatching` looks before it gives up. */
const MATCH_DEPTH = 10;
const MATCH_FILES = 5000;
/** A file this large is a bundle or generated code, not something the project wrote. */
const MATCH_FILE_BYTES = 512 * 1024;

/**
 * The first source file in `language` under `root` whose text matches
 * `pattern`, relative to `root`, or null when none does. A directory that
 * declares a project of its own in that language is left out, because
 * init sets that project up separately. Tests are left out too: a test
 * that calls a server says nothing about what the application calls.
 */
export function firstSourceMatching(
  root: string,
  language: Language,
  pattern: RegExp,
): string | null {
  const suffixes = MARKERS[language].sourceSuffixes;
  let budget = MATCH_FILES;

  const walk = (dir: string, depth: number): string | null => {
    if (depth > MATCH_DEPTH || budget <= 0) {
      return null;
    }
    if (depth > 0 && projectFilesOf(dir, language).length > 0) {
      return null;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!TEST_DIRECTORIES.has(entry.name)) {
          directories.push(full);
        }
        continue;
      }

      if (
        !suffixes.some((suffix) => entry.name.endsWith(suffix)) ||
        isDeclarationOrBundle(entry.name) ||
        TEST_FILE.test(entry.name)
      ) {
        continue;
      }

      budget -= 1;
      if (matchesText(full, pattern)) {
        return path.relative(root, full);
      }
    }

    for (const directory of directories) {
      const found = walk(directory, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };

  return walk(root, 0);
}

const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "e2e",
  "e2e-tests",
  "cypress",
]);

/** `orders.test.ts`, `orders.spec.js`, `orders_test.py`, `orders_spec.rb`. */
const TEST_FILE = /[._](test|spec)\.[a-z]+$|^test_[^.]+\.py$/;

/** A type declaration or a minified copy of a library, which says nothing about what the project calls. */
const isDeclarationOrBundle = (name: string): boolean =>
  name.endsWith(".d.ts") || /\.min\.[cm]?js$/.test(name);

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

/** Stops three levels down, because a project nearly always has source files nearer the top than that. */
function hasSourceFile(
  root: string,
  suffixes: readonly string[],
  depth = 0,
): boolean {
  if (depth > 3) {
    return false;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }

  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      directories.push(path.join(root, entry.name));
      continue;
    }

    if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      return true;
    }
  }

  return directories.some((directory) =>
    hasSourceFile(directory, suffixes, depth + 1),
  );
}
