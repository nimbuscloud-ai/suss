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
    sourceSuffixes: [".ts", ".tsx"],
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
