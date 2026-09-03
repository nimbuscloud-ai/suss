/**
 * Which language a directory is written in, and which language a pack
 * reads.
 *
 * suss has one adapter per language behind a single interface, so the
 * only thing standing between a Python project and `suss extract` is
 * knowing that the directory is a Python project. A person can say so
 * with --lang, and most of the time nobody should have to: a directory
 * usually declares its language in the files it keeps at the top, and
 * failing that in the source files it is made of. Recognition is
 * deliberately shallow, since anything deeper would be guessing about
 * a tree the walk has not read.
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

/** Shared with the init scan, so both walks stop at the same places. */
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
  /** Paths, relative to the root, that mark a project of this language. */
  projectFiles: readonly string[];
  /** What this language's source files are named. */
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
    // config/application.rb is here for a Rails app that vendors its
    // gems, which leaves no lock file where the walk can see it.
    projectFiles: ["Gemfile", "Gemfile.lock", "config/application.rb"],
    sourceSuffixes: [".rb"],
  },
};

/** Which language a source file is written in, by its name, or null for one no adapter reads. */
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
 * A directory that declares a project of its own wins, a tsconfig above
 * it comes next, and TypeScript wins a tie.
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

/** The walk is depth-bounded, because source files are nearly always
 * near the top of a project. */
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
