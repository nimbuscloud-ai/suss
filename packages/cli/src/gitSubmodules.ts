/**
 * Finds the git submodules of a project and the nested repositories that
 * are not submodules.
 *
 * Extraction reads into a submodule, because a service's shared framework
 * often lives in one and a pack matches on the decorators defined there.
 * Discovery drops the files of any other nested repository, because that
 * code belongs to a different project. `.gitmodules` tells the two apart.
 * The package's DESIGN.md explains the reasoning.
 */

import fs from "node:fs";
import path from "node:path";

export interface Submodule {
  /** Absolute. */
  directory: string;
  /** The path as .gitmodules writes it, relative to the repository root. */
  declaredPath: string;
  /** False when the directory is empty, as it is until someone runs `git submodule update --init`. */
  checkedOut: boolean;
}

/**
 * Searches upward from `from`, because .gitmodules is at the repository
 * root and suss is usually run on one service inside it. Submodules
 * outside that service are included, because the shared framework the
 * service imports is usually one of them.
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
 * The files of this project, without the ones inside a nested repository
 * that is not a submodule. Each adapter's walk skips directories named
 * .git, but does not treat a directory containing one as a separate
 * repository, so the filtering has to happen here.
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

/** Stops at the first .git, because any directory above it belongs to another checkout. */
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
