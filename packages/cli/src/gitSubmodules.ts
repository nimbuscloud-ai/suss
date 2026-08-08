// gitSubmodules.ts: the directories of a project that are checked out
// from somewhere else.
//
// A service whose shared framework lives in a submodule imports code
// that is on disk but under its own repository. Both halves of suss care
// about that. Extraction cares because the decorator a pack matches on
// is defined in the submodule, so an import that does not resolve into
// it leaves every route in the service unrecognized. Discovery cares
// because a nested repository looks like somebody else's project and
// walking into it looks like a mistake.
//
// .gitmodules settles it. The enclosing repository lists each submodule
// by path, so a nested .git that the list names is part of this project
// and one it does not name is a separate project sitting inside this
// tree, which suss reads as source but never treats as its own roots.
//
// A submodule nobody checked out is a directory with nothing in it. The
// imports into it will not resolve and the summaries that depended on
// them will quietly not exist, so it is worth a sentence rather than a
// shorter run.

import fs from "node:fs";
import path from "node:path";

export interface Submodule {
  /** Absolute path to the submodule's directory. */
  directory: string;
  /** The path as .gitmodules writes it, relative to the repository root. */
  declaredPath: string;
  /**
   * Whether the directory holds anything. A submodule nobody ran
   * `git submodule update --init` for exists and is empty.
   */
  checkedOut: boolean;
}

/**
 * Every submodule of the repository this directory belongs to.
 *
 * The search walks up, because .gitmodules sits at the repository root
 * and the directory suss was pointed at is often a service inside it.
 * A submodule outside the directory being read still counts: that is
 * where a shared framework usually sits.
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
 * The files of this project, with anything living in a repository of
 * its own dropped.
 *
 * A vendored snapshot checked out inside the tree is somebody else's
 * code: extracting its routes reports another project's boundaries as
 * this one's, and there is nobody here who can act on them. A submodule
 * is the opposite, and .gitmodules is what tells the two apart, so a
 * declared one stays.
 *
 * The adapters' own walks skip a directory named .git and nothing else,
 * so the repository a .git marks is invisible to them. Filtering here
 * keeps each language's own skip list where it belongs.
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

/** The submodules of this project that suss can actually read. */
export function checkedOutSubmodules(from: string): string[] {
  return readSubmodules(from)
    .filter((submodule) => submodule.checkedOut)
    .map((submodule) => submodule.directory);
}

/**
 * What to say about a submodule with nothing in it, or nothing when
 * every one of them is checked out.
 */
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

/** The `path` of every `[submodule]` section, in the order they appear. */
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

/**
 * The repository root above this directory, when it declares
 * submodules. The walk stops at the first directory holding a .git,
 * since that is the repository this project belongs to and anything
 * above it is somebody else's checkout.
 */
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
