/**
 * Maps a dotted import onto the file in the repo it refers to.
 *
 * The search walks a small set of configured roots. Finding out what `sys.path`
 * actually is would mean running Python, so when more than one root offers a
 * candidate, the resolver abstains rather than picking one.
 */

import fs from "node:fs";
import path from "node:path";

export interface RelativeModuleSpec {
  /** The dotted path after the leading dots. It is empty for a bare `from . import x`. */
  module: string;
  /** Dot count: 0 means absolute, 1 is `.`, 2 is `..`, and so on. */
  relativeLevel: number;
}

export type ModuleResolution =
  | { status: "resolved"; file: string }
  | {
      status: "unresolved";
      /**
       * "external": no configured root has a file for it. "ambiguous": more
       * than one does. "outsideRoots": a relative import had enough dots to walk
       * up past every configured root.
       */
      reason: "external" | "ambiguous" | "outsideRoots";
    };

export interface ModuleResolverOptions {
  /** The directories an absolute dotted import is resolved against. We cannot see `sys.path` order, since that only exists at runtime. */
  roots: string[];
}

/** Inclusive: a relative import landing exactly on a configured root is still inside it. */
function isWithinRoot(dir: string, root: string): boolean {
  const relative = path.relative(root, dir);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function isInsideAnyRoot(dir: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithinRoot(dir, root));
}

/** Most specific first: the plain module file before the same-named package's `__init__.py`. */
function candidatesUnderRoot(root: string, dotted: string): string[] {
  if (dotted === "") {
    const initFile = path.join(root, "__init__.py");
    return existsWithExactCase(initFile, 1) ? [initFile] : [];
  }
  const segments = dotted.split(".");
  const base = path.join(root, ...segments);
  const found: string[] = [];
  const moduleFile = `${base}.py`;
  if (existsWithExactCase(moduleFile, segments.length)) {
    found.push(moduleFile);
  }
  const packageFile = path.join(base, "__init__.py");
  if (existsWithExactCase(packageFile, segments.length + 1)) {
    found.push(packageFile);
  }
  return found;
}

/**
 * Whether the file exists under exactly this casing. fs.existsSync is
 * case-insensitive on macOS and Windows, so a wrongly-cased import
 * resolved locally and abstained on Linux, and the two disagreed
 * (#188). Only the trailing segments the dotted path chose are
 * compared, so a symlinked root keeps resolving.
 */
function existsWithExactCase(file: string, trailingSegments: number): boolean {
  if (!fs.existsSync(file)) {
    return false;
  }
  let real: string;
  try {
    real = fs.realpathSync.native(file);
  } catch {
    return false;
  }
  const tail = (p: string): string =>
    p.split(path.sep).slice(-trailingSegments).join(path.sep);
  return tail(real) === tail(file);
}

export function resolveAbsoluteModule(
  dotted: string,
  options: ModuleResolverOptions,
): ModuleResolution {
  const byRoot: string[] = [];
  for (const root of options.roots) {
    const candidates = candidatesUnderRoot(root, dotted);
    if (candidates.length > 0) {
      byRoot.push(candidates[0] as string);
    }
  }
  if (byRoot.length === 0) {
    return { status: "unresolved", reason: "external" };
  }
  if (byRoot.length > 1) {
    return { status: "unresolved", reason: "ambiguous" };
  }
  return { status: "resolved", file: byRoot[0] as string };
}

/**
 * The search starts in the importing file's own directory, because Python
 * resolves a relative import against `__package__` and not against `sys.path`.
 * `options.roots` only limits how far the dots can walk up, so a deeply relative
 * import cannot land in an unrelated checkout.
 */
export function resolveRelativeModule(
  importingFile: string,
  spec: RelativeModuleSpec,
  options: ModuleResolverOptions,
): ModuleResolution {
  let dir = path.dirname(importingFile);
  if (!isInsideAnyRoot(dir, options.roots)) {
    return { status: "unresolved", reason: "outsideRoots" };
  }
  for (let i = 1; i < spec.relativeLevel; i++) {
    dir = path.dirname(dir);
    if (!isInsideAnyRoot(dir, options.roots)) {
      return { status: "unresolved", reason: "outsideRoots" };
    }
  }
  const candidates = candidatesUnderRoot(dir, spec.module);
  if (candidates.length === 0) {
    return { status: "unresolved", reason: "external" };
  }
  return { status: "resolved", file: candidates[0] as string };
}

export function resolveModule(
  importingFile: string,
  spec: RelativeModuleSpec,
  options: ModuleResolverOptions,
): ModuleResolution {
  if (spec.relativeLevel > 0) {
    return resolveRelativeModule(importingFile, spec, options);
  }
  return resolveAbsoluteModule(spec.module, options);
}
