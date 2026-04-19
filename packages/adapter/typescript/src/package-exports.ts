// package-exports.ts — resolve the reachable source files behind a
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
//     recover the pre-build source path — the uniform convention
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
   * Sub-path key from the `exports` field — e.g. `"."` for root,
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
 * than `src/` — otherwise the resolver applies the repo-wide
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
