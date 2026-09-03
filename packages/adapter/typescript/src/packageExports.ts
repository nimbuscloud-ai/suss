// packageExports.ts: resolve the reachable source files behind a
// package's public API.
//
// Reads a package.json, walks its `exports` / `main` / `module` /
// `types` fields, and maps each published entry to the original
// TypeScript source file. The adapter feeds those source paths to
// the `packageExports` discovery variant so a pack can scan one file
// per sub-path without the pack author enumerating names by hand.
//
// v0 scope:
//   - Honors `exports` with string values and conditional objects
//     (prefers `types`, then `default`, then `import`).
//   - Falls back to `types`, then `main`, then `module` when no
//     `exports` field is set.
//   - Replaces `dist/` → `src/` and `.d.ts` → `.ts` (or `.tsx`) to
//     recover the pre-build source path, the uniform convention
//     every `@suss/*` package follows. Packages that build
//     elsewhere are expected to pass `srcRoot` explicitly.
//   - Skips pattern exports (`./utils/*`), null-mapped exports
//     (privacy), and the `development` / `require`-only
//     conditionals. Each case is surfaced as a warning on the
//     result so callers can decide how strict to be.

import fs from "node:fs";
import path from "node:path";

export interface ResolvedPackageExport {
  /** Name as written in package.json (e.g. `"@suss/behavioral-ir"`). */
  packageName: string;
  /**
   * Sub-path key from the `exports` field, e.g. `"."` for root,
   * `"./schemas"` for `@scope/pkg/schemas`. Stripped of the leading
   * `./` in the returned shape (kept as `"."` for root for clarity).
   */
  subPath: string;
  /**
   * Segments prepended to every export name for bindings produced
   * from this entry. `"."` → `[]`, `"./schemas"` → `["schemas"]`.
   */
  exportPathPrefix: string[];
  /** Absolute path to the resolved source file. */
  sourceFile: string;
  /**
   * Absolute path to the file the manifest points at before the
   * dist to src mapping, usually a built declaration file. A file
   * that imports the package resolves to this one, so it is the key
   * for asking which of this entry's exports a declaration is.
   */
  publishedFile: string;
}

export interface ResolvePackageExportsResult {
  packageName: string;
  entries: ResolvedPackageExport[];
  warnings: string[];
}

interface PackageJson {
  name?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?:
    | string
    | Record<string, string | Record<string, string | null | undefined>>
    | null;
}

/**
 * Resolve a package's publicly reachable source files.
 *
 * Supply `srcRoot` when the package's source lives somewhere other
 * than `src/`: otherwise the resolver applies the repo-wide
 * convention (dist → src, .d.ts → .ts).
 */
export function resolvePackageExports(
  packageJsonPath: string,
  opts: { srcRoot?: string } = {},
): ResolvePackageExportsResult {
  const absPkgJson = path.resolve(packageJsonPath);
  const pkgDir = path.dirname(absPkgJson);
  const raw = fs.readFileSync(absPkgJson, "utf8");
  const pkg = JSON.parse(raw) as PackageJson;

  const packageName = pkg.name ?? path.basename(pkgDir);
  const warnings: string[] = [];
  const entries: ResolvedPackageExport[] = [];

  const pushEntry = (subPath: string, distPath: string | undefined): void => {
    if (distPath === undefined) {
      return;
    }
    const src = resolveSourceFor(pkgDir, distPath, opts.srcRoot);
    if (src === null) {
      warnings.push(
        `cannot resolve source for ${packageName} ${subPath} (${distPath})`,
      );
      return;
    }
    entries.push({
      packageName,
      subPath,
      exportPathPrefix: subPathToPrefix(subPath),
      sourceFile: src,
      publishedFile: path.resolve(pkgDir, distPath),
    });
  };

  const exportsField = pkg.exports;
  if (
    exportsField !== undefined &&
    exportsField !== null &&
    typeof exportsField === "object"
  ) {
    for (const [key, value] of Object.entries(exportsField)) {
      if (key.includes("*")) {
        warnings.push(`pattern export ${key} not yet supported`);
        continue;
      }
      const distPath = pickConditional(value, warnings, key);
      pushEntry(normalizeSubPath(key), distPath);
    }
  } else if (typeof exportsField === "string") {
    pushEntry(".", exportsField);
  } else {
    // Fall back to top-level fields. Prefer `types` so we start from
    // a `.d.ts` that round-trips cleanly to `.ts`.
    pushEntry(".", pkg.types ?? pkg.main ?? pkg.module);
  }

  return { packageName, entries, warnings };
}

/**
 * A run asks for the same package.json many times over, once per
 * (sourceFile × pattern) pair in discovery and once per call the
 * closure places. The cache outlives a run, so the key includes what
 * the file looked like when read: a rewritten package.json in a
 * watching process gets a new key rather than the old entry.
 */
const packageExportsCache = new Map<string, ResolvePackageExportsResult>();

/** A path cannot contain the ASCII unit separator, so the halves stay apart. */
const PATH_STAMP_SEPARATOR = "\u001f";

function packageJsonStamp(packageJsonPath: string): string {
  try {
    const stat = fs.statSync(packageJsonPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "unreadable";
  }
}

export function resolvePackageExportsCached(
  packageJsonPath: string,
): ResolvePackageExportsResult {
  const stamp = packageJsonStamp(packageJsonPath);
  const key = `${packageJsonPath}${PATH_STAMP_SEPARATOR}${stamp}`;
  const cached = packageExportsCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const fresh = resolvePackageExports(packageJsonPath);
  packageExportsCache.set(key, fresh);
  return fresh;
}

/** Drop every resolved package.json. Tests reach for this; a run does not. */
export function clearPackageExportsCache(): void {
  packageExportsCache.clear();
}

/**
 * The nearest directory at or above `start` whose package.json has a
 * name. A built `dist/package.json` that only sets `type` is skipped,
 * so a declaration file under `dist/` resolves to the package that
 * built it.
 */
export function namedPackageDirAbove(start: string): string | null {
  let at = path.resolve(start);
  for (let up = 0; up < 12; up += 1) {
    if (packageNameAt(at) !== null) {
      return at;
    }
    const parent = path.dirname(at);
    if (parent === at) {
      break;
    }
    at = parent;
  }
  return null;
}

export function packageNameAt(dir: string): string | null {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { name?: unknown };
    if (typeof manifest.name === "string" && manifest.name.length > 0) {
      return manifest.name;
    }
  } catch {
    // Nothing here, or nothing readable.
  }
  return null;
}

function pickConditional(
  value: string | Record<string, string | null | undefined> | undefined,
  warnings: string[],
  key: string,
): string | undefined {
  if (value === undefined || value === null) {
    if (value === null) {
      warnings.push(`export ${key} is null (privacy marker)`);
    }
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  const priority = ["types", "default", "import", "module", "require"];
  for (const cond of priority) {
    const entry = value[cond];
    if (typeof entry === "string") {
      return entry;
    }
  }
  warnings.push(`export ${key} has no resolvable condition`);
  return undefined;
}

function normalizeSubPath(key: string): string {
  if (key === ".") {
    return ".";
  }
  if (key.startsWith("./")) {
    return key.slice(2);
  }
  return key;
}

function subPathToPrefix(subPath: string): string[] {
  if (subPath === ".") {
    return [];
  }
  return subPath.split("/").filter((s) => s.length > 0);
}

function resolveSourceFor(
  pkgDir: string,
  distPath: string,
  srcRoot: string | undefined,
): string | null {
  // Normalise distPath: "./dist/index.d.ts" → "dist/index.d.ts"
  const rel = distPath.replace(/^\.\//, "");
  // dist/foo/bar.d.ts → src/foo/bar
  const withoutDist = rel.replace(/^dist\//, `${srcRoot ?? "src"}/`);
  const stem = withoutDist
    .replace(/\.d\.ts$/, "")
    .replace(/\.js$/, "")
    .replace(/\.cjs$/, "")
    .replace(/\.mjs$/, "")
    .replace(/\.ts$/, "");
  const candidates = [`${stem}.ts`, `${stem}.tsx`];
  for (const candidate of candidates) {
    const abs = path.resolve(pkgDir, candidate);
    if (fs.existsSync(abs)) {
      return abs;
    }
  }
  return null;
}
