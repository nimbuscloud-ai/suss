// language.ts: which language a directory holds, and which language a
// pack reads.
//
// suss has an adapter per language behind one interface, so the only
// thing standing between a Python project and `suss extract` is knowing
// that the directory is a Python project. A person can say so with
// --lang, and most of the time nobody should have to: a directory
// states its language in the files it keeps at the top, and failing
// that in the files it is made of.
//
// Recognition is deliberately shallow. A marker file at the root, or a
// source file a few levels down, is enough to name a language; anything
// more would be guessing about a tree the walk has not read.

import fs from "node:fs";
import path from "node:path";

/** A language suss has an adapter for. */
export type Language = "typescript" | "python" | "ruby";

export const LANGUAGES: readonly Language[] = ["typescript", "python", "ruby"];

/** What a person types after --lang, and what it means. */
export function parseLanguage(value: string): Language | null {
  const found = LANGUAGES.find((language) => language === value);
  return found ?? null;
}

/** How each language spells itself in a sentence. */
export const LANGUAGE_LABEL: Record<Language, string> = {
  typescript: "TypeScript",
  python: "Python",
  ruby: "Ruby",
};

/**
 * Directories nobody's own source lives in. Shared with the project
 * scan in init.ts so both stop at the same places: a walk that reads
 * node_modules or a virtualenv reports somebody else's project as this
 * one.
 */
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
  /**
   * Paths, relative to the project root, that say a project is written
   * in this language whatever its source files are called.
   */
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
    // A Rails app is worth naming on its own: graphql-ruby's root sits
    // under app/, and a Rails app that vendors its gems may keep no
    // lock file where the walk can see it.
    projectFiles: ["Gemfile", "Gemfile.lock", "config/application.rb"],
    sourceSuffixes: [".rb"],
  },
};

/** The marker files of a language that this directory actually has. */
export function projectFilesOf(root: string, language: Language): string[] {
  return MARKERS[language].projectFiles.filter((name) =>
    fs.existsSync(path.join(root, name)),
  );
}

/**
 * Every language this directory holds source for, in the order suss
 * looks. A directory can hold more than one: a service with a Python
 * backend and a TypeScript front end is two answers, not a wrong one.
 */
export function detectLanguages(root: string): Language[] {
  return LANGUAGES.filter(
    (language) =>
      projectFilesOf(root, language).length > 0 ||
      hasSourceFile(root, MARKERS[language].sourceSuffixes),
  );
}

export interface ProjectLanguageContext {
  /**
   * Whether a tsconfig above this directory covers it. Source
   * resolution walks up for one and reads the directory as TypeScript
   * when it finds it, so language resolution has to see the same
   * tsconfig or the two answer differently about the same directory.
   */
  coveredByTsconfig?: boolean;
}

/**
 * The one language `suss extract` should read this directory as, or a
 * sentence saying why suss cannot tell. TypeScript wins a tie, which is
 * what every run before this one did: a TypeScript project with a
 * couple of Python scripts beside it keeps reading as TypeScript, and a
 * person who meant the other one says so with --lang.
 *
 * A tsconfig anywhere above wins the same way, and for the same reason:
 * a subdirectory of a TypeScript monorepo with one stray script in it
 * is a TypeScript project. What beats it is the directory stating a
 * project of its own, a pyproject or a Gemfile, since somebody wrote
 * that down on purpose.
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

/**
 * Whether the tree holds a file of this language. Bounded, because the
 * answer is nearly always at the top and a full walk of a large
 * repository to answer "is there any Python here" costs more than it
 * tells.
 */
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
