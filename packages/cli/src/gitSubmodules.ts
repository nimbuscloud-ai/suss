/**
 * The directories of a project that are checked out from somewhere else.
 *
 * A service whose shared framework lives in a submodule imports code
 * that is on disk but belongs to another repository. Extraction cares
 * because the decorator a pack matches on is defined in the submodule,
 * so an import that does not resolve into it leaves every route in the
 * service unrecognized. Discovery cares because a nested repository
 * looks like somebody else's project, and walking into it looks like a
 * mistake.
 *
 * .gitmodules settles which is which. The package README explains why a
 * submodule and a vendored nested repository get opposite treatment.
 */

import fs from "node:fs";
import path from "node:path";

export interface Submodule {
  /** Absolute path to the submodule's directory. */
  directory: string;
  /** The path as .gitmodules writes it, relative to the repository root. */
  declaredPath: string;
  /**
   * False when the directory is empty, which is what you get when
   * nobody has run `git submodule update --init`.
   */
  checkedOut: boolean;
}

/**
 * The search walks up, because .gitmodules lives at the repository root
 * and suss is usually pointed at one service inside it. Submodules
 * outside that service still count, since a shared framework is
 * normally one of them.
 */
export function readSubmodules(from: string): Submodule[] {
  const repositoryRoot = findGitmodules(path.resolve(from));
  if (repositoryRoot === null) {
    return [];
  }

  const contents = fs.readFileSync(
    path.join(repositoryRoot, ".gitmodules"),
    "utf8",
  );
  return declaredPaths(contents).map((declaredPath) => {
    const directory = path.resolve(repositoryRoot, declaredPath);
    return { directory, declaredPath, checkedOut: holdsAnything(directory) };
  });
}

/**
 * The files of this project, minus anything that belongs to a
 * repository of its own. The filtering happens here rather than in each
 * adapter's walk, because those walks skip any directory called .git
 * but do not notice that a .git directory means there is a separate
 * repository there.
 */
export function filesOutsideNestedRepositories(
  files: readonly string[],
  root: string,
  submodules: readonly Submodule[],
): string[] {
  const declared = new Set(submodules.map((submodule) => submodule.directory));
  const resolvedRoot = path.resolve(root);
  const decided = new Map<string, boolean>();

  const insideItsOwnRepository = (directory: string): boolean => {
    const cached = decided.get(directory);
    if (cached !== undefined) {
      return cached;
    }

    const answer = ((): boolean => {
      if (directory === resolvedRoot || !directory.startsWith(resolvedRoot)) {
        return false;
      }

      if (
        !declared.has(directory) &&
        fs.existsSync(path.join(directory, ".git"))
      ) {
        return true;
      }
      return insideItsOwnRepository(path.dirname(directory));
    })();

    decided.set(directory, answer);
    return answer;
  };

  return files.filter(
    (file) => !insideItsOwnRepository(path.dirname(path.resolve(file))),
  );
}

export function checkedOutSubmodules(from: string): string[] {
  return readSubmodules(from)
    .filter((submodule) => submodule.checkedOut)
    .map((submodule) => submodule.directory);
}

export function formatMissingSubmodules(submodules: Submodule[]): string {
  const missing = submodules.filter((submodule) => !submodule.checkedOut);
  if (missing.length === 0) {
    return "";
  }

  const paths = missing.map((submodule) => submodule.declaredPath).join(", ");
  return [
    `  ${missing.length === 1 ? "A submodule of this project is" : `${missing.length} submodules of this project are`} not checked out: ${paths}.`,
    "  Any import reaching into one of them resolves to nothing, so the code that depends on it reads as though it declared no boundaries.",
    "  Run `git submodule update --init --recursive` and try again.",
    "",
  ].join("\n");
}

function declaredPaths(contents: string): string[] {
  const found: string[] = [];
  let insideSubmodule = false;
  for (const line of contents.split(/\r?\n/)) {
    const text = line.trim();
    if (text.startsWith("[")) {
      insideSubmodule = /^\[submodule\b/.test(text);
      continue;
    }
    if (!insideSubmodule) {
      continue;
    }
    const declared = text.match(/^path\s*=\s*(.+)$/);
    if (declared?.[1] !== undefined) {
      found.push(declared[1].trim());
    }
  }
  return found;
}

/** The walk stops at the first .git: anything above is another checkout. */
function findGitmodules(from: string): string | null {
  let current = from;
  for (;;) {
    if (fs.existsSync(path.join(current, ".gitmodules"))) {
      return current;
    }
    if (fs.existsSync(path.join(current, ".git"))) {
      return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function holdsAnything(directory: string): boolean {
  try {
    return fs.readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}
