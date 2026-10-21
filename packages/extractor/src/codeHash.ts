/**
 * The code hash a cache key uses for an adapter or a pack: a hash of its
 * built file and of every file that file loads from suss's own packages.
 *
 * An adapter runs the value evaluator and the resolution rules, and a pack
 * runs the compiler for its declarations, so the hash follows the import
 * statements in the built files outward and a rebuild of any package it
 * reaches changes it. A chunk the bundler split out is a relative import
 * and is followed too. Imports of other libraries are not followed.
 *
 * A package is resolved from the file that imports it, with the export
 * conditions of that import, so the hash covers the build the process
 * loaded and not its CommonJS twin.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const SUSS_SCOPE = "@suss/";

// Group 1 is the module an import or export statement asks for, and group
// 2 the module a require call asks for. A bundler writes `__require` for a
// require inside an ES module, so that one has no word boundary.
const IMPORT_FORMS =
  /\b(?:from|import)\s*\(?\s*["']([^"'\s]+)["']|require\s*\(\s*["']([^"'\s]+)["']/g;

type ImportKind = "import" | "require";

const CONDITIONS: Record<ImportKind, ReadonlySet<string>> = {
  import: new Set(["import", "node", "default"]),
  require: new Set(["require", "node", "default"]),
};

export interface CodeHasher {
  /** The files the code hash reads for `entryFile`, that file first. */
  codeFiles(entryFile: string): string[];
  /** Empty when `entryFile` cannot be read, the same as a run from source. */
  codeHash(entryFile: string): string;
}

interface CodeFile {
  digest: string;
  imports: string[];
}

/** A hasher reads each file once and keeps what it found. */
export function createCodeHasher(): CodeHasher {
  const read = new Map<string, CodeFile | null>();

  function readOnce(file: string): CodeFile | null {
    const known = read.get(file);
    if (known !== undefined) {
      return known;
    }
    const found = readCodeFile(file);
    read.set(file, found);
    return found;
  }

  function codeFiles(entryFile: string): string[] {
    const entry = realFile(entryFile);
    if (entry === null || readOnce(entry) === null) {
      return [];
    }

    const found = [entry];
    const seen = new Set(found);
    for (let at = 0; at < found.length; at++) {
      for (const next of readOnce(found[at] as string)?.imports ?? []) {
        if (seen.has(next)) {
          continue;
        }
        seen.add(next);
        // An import that names no readable file would fail at load, so a
        // match the pattern found inside a string is skipped here.
        if (readOnce(next) !== null) {
          found.push(next);
        }
      }
    }
    return found;
  }

  function codeHash(entryFile: string): string {
    const files = codeFiles(entryFile);
    if (files.length === 0) {
      return "";
    }

    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(read.get(file)?.digest ?? "");
    }
    return hash.digest("hex").slice(0, 16);
  }

  return { codeFiles, codeHash };
}

/**
 * The hasher an adapter and the packs of one process share. A process
 * loads each module once, so what it read stays true for the process.
 */
export const processCodeHasher: CodeHasher = createCodeHasher();

function readCodeFile(file: string): CodeFile | null {
  let text: Buffer;
  try {
    text = fs.readFileSync(file);
  } catch {
    return null;
  }
  return {
    digest: createHash("sha256").update(text).digest("hex"),
    imports: importsOf(file, text.toString("utf8")),
  };
}

function importsOf(file: string, text: string): string[] {
  const asked = new Set<string>();
  const found: string[] = [];
  for (const match of text.matchAll(IMPORT_FORMS)) {
    const kind: ImportKind = match[1] === undefined ? "require" : "import";
    const specifier = match[1] ?? match[2] ?? "";
    if (asked.has(`${kind} ${specifier}`)) {
      continue;
    }
    asked.add(`${kind} ${specifier}`);
    const target = resolveImport(specifier, file, kind);
    if (target !== null) {
      found.push(target);
    }
  }
  return found;
}

function resolveImport(
  specifier: string,
  fromFile: string,
  kind: ImportKind,
): string | null {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return realFile(path.resolve(path.dirname(fromFile), specifier));
  }

  if (specifier.startsWith(SUSS_SCOPE)) {
    return resolvePackageImport(specifier, fromFile, kind);
  }

  return null;
}

/**
 * Looks in the same node_modules directories Node would, nearest first,
 * and reads the package's `exports` the way an import of `kind` does.
 */
function resolvePackageImport(
  specifier: string,
  fromFile: string,
  kind: ImportKind,
): string | null {
  const [scope = "", name = "", ...rest] = specifier.split("/");
  const packageName = `${scope}/${name}`;
  const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
  const lookIn = createRequire(fromFile).resolve.paths(packageName) ?? [];
  for (const dir of lookIn) {
    const packageDir = path.join(dir, packageName);
    const manifest = readManifest(packageDir);
    if (manifest === null) {
      continue;
    }

    const target = exportTarget(manifest, subpath, CONDITIONS[kind]);
    return target === null ? null : realFile(path.join(packageDir, target));
  }
  return null;
}

interface PackageManifest {
  exports?: unknown;
  main?: string;
}

function readManifest(packageDir: string): PackageManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(packageDir, "package.json"), "utf8"),
    ) as PackageManifest;
  } catch {
    return null;
  }
}

function exportTarget(
  manifest: PackageManifest,
  subpath: string,
  conditions: ReadonlySet<string>,
): string | null {
  if (manifest.exports === undefined) {
    return subpath === "." ? (manifest.main ?? "index.js") : subpath;
  }
  return conditionalTarget(subpathEntry(manifest.exports, subpath), conditions);
}

/** A pattern subpath such as `./*` is not read, and resolves to nothing. */
function subpathEntry(exportsField: unknown, subpath: string): unknown {
  const isSubpathMap =
    typeof exportsField === "object" &&
    exportsField !== null &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith("."));
  if (isSubpathMap) {
    return (exportsField as Record<string, unknown>)[subpath];
  }
  return subpath === "." ? exportsField : undefined;
}

function conditionalTarget(
  value: unknown,
  conditions: ReadonlySet<string>,
): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const each of value) {
      const found = conditionalTarget(each, conditions);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (value === null || typeof value !== "object") {
    return null;
  }

  // Node takes the first condition it matches in the order the package
  // wrote them, so the order of `conditions` does not matter.
  for (const [condition, target] of Object.entries(value)) {
    if (!conditions.has(condition)) {
      continue;
    }
    const found = conditionalTarget(target, conditions);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function realFile(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}
