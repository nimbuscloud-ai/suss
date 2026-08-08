// workspaces.ts: find the packages in a monorepo.
//
// Pointed at a repo root, `inspectProject` finds nothing: it stops at
// every nested package.json, which is the right call for a single
// service and the wrong one for a workspace of twelve. Pointed at
// one service, it misses the other eleven.
//
// So look for the workspace declaration first. Four tools are in wide
// use and each keeps the list somewhere different, but they all keep it
// as globs over directories, which is enough to resolve without pulling
// in a glob library: the patterns in practice are `packages/*`,
// `apps/**`, or a literal path.

import fs from "node:fs";
import path from "node:path";

export interface Workspace {
  /** The package's directory, relative to the repo root. */
  directory: string;
  /** Its name from package.json, when it has one. */
  name: string | null;
}

export interface WorkspaceLayout {
  root: string;
  /** Which file declared the workspace, for reporting. */
  declaredBy: string | null;
  packages: Workspace[];
}

/**
 * The workspace a directory belongs to, whether it is the root or one of
 * the packages. Returns no packages when this is a single project, and
 * the caller takes that to mean "treat it as one".
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

/** Whichever of the four tools declared this workspace, if any did. */
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
  // npm and yarn accept an array, or an object with one under
  // `packages`, which is the yarn-berry shape.
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
  // Only the `packages:` list is needed, and it is a flat sequence of
  // quoted strings, so a line scan beats taking a YAML dependency here.
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
 * turbo.json does not list packages; it defers to whatever package
 * manager is in use. Its presence still says this is a workspace, so
 * fall back to the two conventional directories.
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
 * Resolve one glob to directories.
 *
 * Three forms appear in practice: a literal path, one star per level as
 * in `packages/*` or `packages/*\/*`, and `**` for any depth. A star
 * stands for exactly one level, so `packages/*\/*` means two, which is
 * how this repo reaches packages/framework/hono.
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
  // `**` could be any depth; three levels covers every layout seen and
  // keeps the walk bounded.
  const depth = deep ? 3 : wildcards.length;

  return directoriesAtDepth(path.join(root, prefix), depth, deep).map(
    (child) => (prefix === "" ? child : path.join(prefix, child)),
  );
}

/**
 * Directory names under `base`. With `exact`, only those sitting at
 * precisely `depth` levels down, because one star means one level.
 * Otherwise every level down to `depth`, which is what `**` means.
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
