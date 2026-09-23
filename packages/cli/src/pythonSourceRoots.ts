/**
 * The directories a Python project's absolute imports resolve against,
 * as well as the directory the run starts in.
 *
 * A project that keeps its package under `src/` imports it as
 * `orders.routes`, because installing the project puts `src/` on
 * `sys.path`. suss cannot run the install, so it reads where
 * `pyproject.toml` tells the build backend to look, and uses `src/`
 * when that declares nothing and `src/` contains a package.
 *
 * An extra root cannot pick the wrong module, because the module
 * resolver abstains when two roots both have a file for one import.
 */

import fs from "node:fs";
import path from "node:path";

import { readTomlFile, tableAt } from "./dependencyManifests.js";

import type { TomlTable } from "./dependencyManifests.js";

export interface PythonSourceRoots {
  /** Absolute directories under the project root, not including the root itself. */
  roots: string[];
  /** A manifest that might have declared a source directory and could not be read. */
  unread: Array<{ where: string; reason: string }>;
}

export function pythonSourceRoots(root: string): PythonSourceRoots {
  const resolvedRoot = path.resolve(root);
  const { declared, unread } = declaredInPyproject(resolvedRoot);

  const roots = directoriesUnder(resolvedRoot, declared);
  if (roots.length > 0) {
    return { roots, unread };
  }

  const src = path.join(resolvedRoot, "src");
  return { roots: containsPackage(src) ? [src] : [], unread };
}

function declaredInPyproject(root: string): {
  declared: string[];
  unread: PythonSourceRoots["unread"];
} {
  const pyproject = path.join(root, "pyproject.toml");
  if (!fs.existsSync(pyproject)) {
    return { declared: [], unread: [] };
  }

  const read = readTomlFile(pyproject);
  if (read.kind === "unreadable") {
    return {
      declared: [],
      unread: [{ where: "pyproject.toml", reason: read.reason }],
    };
  }
  return { declared: declaredSourceDirectories(read.value), unread: [] };
}

/** Empty when every manifest was read. */
export function formatUnreadSourceRoots(
  sourceRoots: PythonSourceRoots,
  projectRoot: string,
  roots: readonly string[],
): string {
  const searched = roots
    .map((dir) => path.relative(projectRoot, dir) || ".")
    .join(", ");
  // The parser follows its first line with an excerpt of the file,
  // which is more than a warning in the middle of an extract needs.
  return sourceRoots.unread
    .map(
      ({ where, reason }) =>
        `[suss] Could not read ${where} to find where the Python sources are, because ${reason.split("\n")[0]}\n[suss] Absolute imports resolve against ${searched}.\n`,
    )
    .join("");
}

/** Kept only when it exists and is below the root, since files outside the root are never read. */
function directoriesUnder(root: string, relative: string[]): string[] {
  const found = new Set<string>();
  for (const entry of relative) {
    const dir = path.resolve(root, entry);
    const fromRoot = path.relative(root, dir);
    if (
      fromRoot === "" ||
      fromRoot.startsWith("..") ||
      path.isAbsolute(fromRoot)
    ) {
      continue;
    }

    if (isDirectory(dir)) {
      found.add(dir);
    }
  }
  return [...found];
}

/** A directory that is itself a package is imported by its own name, so it is no root. */
function containsPackage(dir: string): boolean {
  if (!isDirectory(dir) || fs.existsSync(path.join(dir, "__init__.py"))) {
    return false;
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .some(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(dir, entry.name, "__init__.py")),
    );
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Relative to the project root. */
function declaredSourceDirectories(pyproject: unknown): string[] {
  return [
    ...setuptoolsPackageDir(pyproject),
    ...setuptoolsFindWhere(pyproject),
    ...hatchPackages(pyproject),
    ...poetryPackages(pyproject),
  ];
}

function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * `{ "" = "src" }` puts every package under `src/`. A named package
 * mapped to a directory of the same name puts its parent on the path;
 * a package mapped to a directory with another name cannot be written
 * as a root, so it is skipped.
 */
function setuptoolsPackageDir(pyproject: unknown): string[] {
  const packageDir = tableAt(pyproject, "tool", "setuptools", "package-dir");
  if (packageDir === null) {
    return [];
  }
  const found: string[] = [];
  for (const [name, dir] of Object.entries(packageDir)) {
    if (typeof dir !== "string") {
      continue;
    }

    if (name === "") {
      found.push(dir);
      continue;
    }

    if (!name.includes(".") && path.posix.basename(dir) === name) {
      found.push(path.posix.dirname(dir));
    }
  }
  return found;
}

function setuptoolsFindWhere(pyproject: unknown): string[] {
  const find = tableAt(pyproject, "tool", "setuptools", "packages", "find");
  return stringsIn(find?.where);
}

/** Hatch lists package directories, and the directory above each is what goes on the path. */
function hatchPackages(pyproject: unknown): string[] {
  const tables: Array<TomlTable | null> = [
    tableAt(pyproject, "tool", "hatch", "build", "targets", "wheel"),
    tableAt(pyproject, "tool", "hatch", "build"),
  ];
  return tables.flatMap((table) =>
    stringsIn(table?.packages).map((dir) => path.posix.dirname(dir)),
  );
}

function poetryPackages(pyproject: unknown): string[] {
  const packages = tableAt(pyproject, "tool", "poetry")?.packages;
  if (!Array.isArray(packages)) {
    return [];
  }
  return packages.flatMap((entry) => {
    const from = tableAt(entry)?.from;
    return typeof from === "string" ? [from] : [];
  });
}
