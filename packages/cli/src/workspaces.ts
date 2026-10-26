/**
 * Finds the packages in a monorepo.
 *
 * Run at a repo root, `inspectProject` finds nothing, because it stops at
 * every nested package.json. That suits a single service, but in a
 * workspace of twelve packages it misses all of them, and run on one
 * service it misses the other eleven. So init looks for the workspace
 * declaration first.
 *
 * Four tools are in wide use and each keeps the list in a different file.
 * All of them write it as globs over directories, and in practice the
 * globs are `packages/*`, `apps/**` or a literal path, so this module
 * expands them itself without a glob library.
 */

import fs from "node:fs";
import path from "node:path";

import { isSameOrUnder } from "./projectSource.js";

export interface Workspace {
  /** Relative to the repo root. */
  directory: string;
  /** The name in the package's package.json, when it has one. */
  name: string | null;
}

export interface WorkspaceLayout {
  root: string;
  /** The file that declared the workspace, so the report can say where the list came from. */
  declaredBy: string | null;
  packages: Workspace[];
}

/**
 * The workspace a directory belongs to, whether the directory is the
 * root or one of the packages. `packages` is empty for a single project,
 * and the caller then reads the directory as one project.
 */
export function readWorkspace(dir: string): WorkspaceLayout {
  const root = path.resolve(dir);
  const declaration = findDeclaration(root);
  if (declaration === null) {
    return { root, declaredBy: null, packages: [] };
  }

  const packages = declaration.patterns
    .flatMap((pattern) => expand(root, pattern))
    .filter((directory) =>
      fs.existsSync(path.join(root, directory, "package.json")),
    )
    .map((directory) => ({ directory, name: nameOf(root, directory) }))
    .sort((a, b) => a.directory.localeCompare(b.directory));

  return { root, declaredBy: declaration.file, packages: dedupe(packages) };
}

function dedupe(packages: Workspace[]): Workspace[] {
  const seen = new Set<string>();
  return packages.filter((p) => {
    if (seen.has(p.directory)) {
      return false;
    }
    seen.add(p.directory);
    return true;
  });
}

interface Declaration {
  file: string;
  patterns: string[];
}

/** The first of the four tools' files that declares a workspace here, or null. */
function findDeclaration(root: string): Declaration | null {
  const readers: Array<() => Declaration | null> = [
    () => fromPackageJson(root),
    () => fromPnpm(root),
    () => fromLerna(root),
    () => fromTurbo(root),
  ];
  for (const read of readers) {
    const found = read();
    if (found !== null && found.patterns.length > 0) {
      return found;
    }
  }
  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function fromPackageJson(root: string): Declaration | null {
  const parsed = readJson(path.join(root, "package.json"));
  if (parsed === null) {
    return null;
  }
  // npm and yarn take an array. Yarn berry also takes an object with the
  // array under `packages`.
  const workspaces = parsed.workspaces;
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : ((workspaces as { packages?: unknown } | undefined)?.packages ?? null);
  return Array.isArray(patterns)
    ? { file: "package.json", patterns: patterns.filter(isString) }
    : null;
}

function fromPnpm(root: string): Declaration | null {
  const file = path.join(root, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) {
    return null;
  }
  // Only the `packages:` list is needed, and it is a flat list of quoted
  // strings, so scanning lines avoids adding a YAML dependency.
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
      if (item?.[1] !== undefined) {
        patterns.push(item[1]);
        continue;
      }
      if (line.trim() !== "" && !line.startsWith(" ")) {
        break;
      }
    }
  }
  return { file: "pnpm-workspace.yaml", patterns };
}

function fromLerna(root: string): Declaration | null {
  const parsed = readJson(path.join(root, "lerna.json"));
  const patterns = parsed?.packages;
  return Array.isArray(patterns)
    ? { file: "lerna.json", patterns: patterns.filter(isString) }
    : null;
}

/**
 * turbo.json does not list packages, because turbo uses the package
 * manager's list. A turbo.json still means the directory is a workspace,
 * so this falls back to the two conventional directories.
 */
function fromTurbo(root: string): Declaration | null {
  if (!fs.existsSync(path.join(root, "turbo.json"))) {
    return null;
  }
  return { file: "turbo.json", patterns: ["packages/*", "apps/*"] };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Expands one glob to directories.
 *
 * Three forms appear in practice: a literal path, one star per level as
 * in `packages/*` or `packages/*\/*`, and `**` for any depth. A star
 * matches exactly one level, so `packages/*\/*` matches directories two
 * levels below `packages`.
 */
function expand(root: string, pattern: string): string[] {
  const cleaned = pattern.replace(/\/+$/, "");
  if (!cleaned.includes("*")) {
    return [cleaned];
  }

  const segments = cleaned.split("/");
  const firstStar = segments.findIndex((s) => s.includes("*"));
  const prefix = segments.slice(0, firstStar).join("/");
  const wildcards = segments.slice(firstStar);
  const deep = wildcards.some((s) => s === "**");
  // `**` can mean any depth. Three levels covers every layout seen so far
  // and keeps the walk bounded.
  const depth = deep ? 3 : wildcards.length;

  return directoriesAtDepth(path.join(root, prefix), depth, deep).map(
    (child) => (prefix === "" ? child : path.join(prefix, child)),
  );
}

/**
 * Directory paths under `base`. Without `anyDepth`, only those exactly
 * `depth` levels down, because each star matches one level. With it,
 * those at every level down to `depth`, as `**` matches.
 */
function directoriesAtDepth(
  base: string,
  depth: number,
  anyDepth: boolean,
): string[] {
  if (depth === 0) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name.startsWith(".") ||
      entry.name === "node_modules"
    ) {
      continue;
    }
    if (anyDepth || depth === 1) {
      found.push(entry.name);
    }
    for (const nested of directoriesAtDepth(
      path.join(base, entry.name),
      depth - 1,
      anyDepth,
    )) {
      found.push(path.join(entry.name, nested));
    }
  }
  return found;
}

function nameOf(root: string, directory: string): string | null {
  const parsed = readJson(path.join(root, directory, "package.json"));
  return typeof parsed?.name === "string" ? parsed.name : null;
}

/** A dependency a package declares, or one a package of this repository it depends on declares. */
export interface DeclaredDependency {
  name: string;
  /** The manifest field that lists it. */
  field: string;
  /** The package of this repository whose manifest lists it, or null for the package's own. */
  through: string | null;
  /** Its folder when it is a package of this repository itself. */
  local: string | null;
}

/**
 * Every dependency the package at `dir` declares, and every dependency
 * of each package of this repository it depends on, at any depth. A
 * service in a monorepo usually depends on its sibling packages, and
 * those declare the SDKs. A sibling's dev dependencies are left out,
 * since none of them run in the package that depends on it.
 */
export function dependenciesThroughLocalPackages(
  dir: string,
): DeclaredDependency[] {
  const found: DeclaredDependency[] = [];
  const seen = new Set<string>();
  const queue: Array<{ dir: string; through: string | null }> = [
    { dir: path.resolve(dir), through: null },
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const manifest = path.join(next.dir, "package.json");
    if (seen.has(manifest)) {
      continue;
    }

    seen.add(manifest);
    const fields =
      next.through === null ? OWN_DEPENDENCY_FIELDS : RUNTIME_DEPENDENCY_FIELDS;
    for (const [name, field] of declaredIn(manifest, fields)) {
      const local = localPackageDir(next.dir, name);
      found.push({ name, field, through: next.through, local });
      if (local !== null) {
        queue.push({ dir: local, through: name });
      }
    }
  }
  return found;
}

const OWN_DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
];

const RUNTIME_DEPENDENCY_FIELDS = ["dependencies", "peerDependencies"];

function declaredIn(
  manifest: string,
  fields: readonly string[],
): Array<[string, string]> {
  const parsed = readJson(manifest);
  if (parsed === null) {
    return [];
  }

  return fields.flatMap((field) => {
    const deps = parsed[field];
    return deps !== null && typeof deps === "object"
      ? Object.keys(deps).map((name): [string, string] => [name, field])
      : [];
  });
}

/**
 * The folder of a dependency that is a package in this repository, such
 * as a sibling in a workspace, or null for one from a registry.
 *
 * Node looks for a package in the `node_modules` of the importing folder
 * and then of each folder above it, and a workspace manager links each
 * workspace package into one of those. npm and yarn link them at the
 * root, pnpm beside the importer, so the lookup climbs to the top of the
 * repository. Before an install there are no links, and the workspace
 * declaration at the top says where each package is instead.
 */
export function localPackageDir(from: string, name: string): string | null {
  const top = repositoryTopAbove(from);
  for (const dir of foldersUpTo(from, top)) {
    const resolved = realPath(path.join(dir, "node_modules", name));
    if (
      resolved !== null &&
      !resolved.split(path.sep).includes("node_modules") &&
      (top === null || isSameOrUnder(resolved, realPath(top) ?? top))
    ) {
      return resolved;
    }
  }

  if (top === null) {
    return null;
  }
  const declared = readWorkspace(top).packages.find((pkg) => pkg.name === name);
  return declared === undefined ? null : path.join(top, declared.directory);
}

/** The nearest folder at or above `from` with a `.git` entry, which a linked worktree writes as a file. */
function repositoryTopAbove(from: string): string | null {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }

    if (path.dirname(dir) === dir) {
      return null;
    }
  }
}

/** `from` and each folder above it, up to and including `top`, or to the filesystem root without one. */
function foldersUpTo(from: string, top: string | null): string[] {
  const folders: string[] = [];
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    folders.push(dir);
    if (dir === top || path.dirname(dir) === dir) {
      return folders;
    }
  }
}

function realPath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}
