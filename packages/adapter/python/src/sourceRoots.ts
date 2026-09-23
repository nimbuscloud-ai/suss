/**
 * The directories a Python project's absolute imports resolve against:
 * the project directory, and the source directories it declares.
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

import { parse as parseToml } from "smol-toml";

export interface UnreadManifest {
  /** The file, relative to the project root. */
  where: string;
  /** Why it could not be read, in one line. */
  reason: string;
}

export interface PythonSourceRoots {
  /** Absolute: the project directory first, then each source directory declared or found under it. */
  roots: string[];
  /** A manifest that might have declared a source directory and could not be read. */
  unread: UnreadManifest[];
}

export type TomlTable = Record<string, unknown>;

export type TomlFileRead =
  | { kind: "parsed"; value: unknown }
  | { kind: "unreadable"; reason: string };

export function readTomlFile(file: string): TomlFileRead {
  try {
    return { kind: "parsed", value: parseToml(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { kind: "unreadable", reason: tomlErrorReason(err) };
  }
}

/** The parser follows its first line with an excerpt of the file, which is more than a one-line reason needs. */
function tomlErrorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const first = message.split("\n")[0] ?? message;
  const line = (err as { line?: unknown }).line;
  const at = typeof line === "number" ? ` (line ${line})` : "";
  return `it is not valid TOML: ${first}${at}`;
}

export function tableAt(value: unknown, ...keys: string[]): TomlTable | null {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") {
      return null;
    }
    current = (current as TomlTable)[key];
  }
  return current !== null && typeof current === "object"
    ? (current as TomlTable)
    : null;
}

export function pythonSourceRoots(projectRoot: string): PythonSourceRoots {
  const root = path.resolve(projectRoot);
  const { declared, unread } = declaredInPyproject(root);

  const found = directoriesUnder(root, declared);
  if (found.length > 0) {
    return { roots: [root, ...found], unread };
  }

  const src = path.join(root, "src");
  return { roots: containsPackage(src) ? [root, src] : [root], unread };
}

function declaredInPyproject(root: string): {
  declared: string[];
  unread: UnreadManifest[];
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
