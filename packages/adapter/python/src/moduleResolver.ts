// moduleResolver.ts: repo-scoped module resolution.
//
// The roadmap's resolver was scoped to single-file name classification;
// the language-adapters proposal amends that (see "What the measurement
// added"): cross-file value tracing is where the payoff lives, so a
// dotted import maps deterministically to the repo file it names,
// abstaining rather than guessing when more than one candidate answers.
//
// This has no ts-morph analogue to lean on: TypeScript resolution comes
// from the type checker's own module graph. Here it's a direct
// filesystem walk against a small set of configured roots, the closest
// thing a Python project has to `tsconfig.json` `paths` without reading
// `sys.path` at runtime (which would mean running Python).

import fs from "node:fs";
import path from "node:path";

export interface RelativeModuleSpec {
  /** Dotted path after the leading dots; empty for a bare `from . import x`. */
  module: string;
  /** Dot count: 0 means absolute, 1 is `.`, 2 is `..`, and so on. */
  relativeLevel: number;
}

export type ModuleResolution =
  | { status: "resolved"; file: string }
  | {
      status: "unresolved";
      /**
       * "external": no configured root names it, the way a third-party
       * package or a genuinely missing module reads from here.
       * "ambiguous": more than one configured root names it, and
       * guessing which one runs at import time is exactly the kind of
       * wrong answer this resolver exists to avoid.
       * "outsideRoots": a relative import's dot count walked the
       * search directory above every configured root. Nothing past a
       * project's own boundary is this reader's to name, so it stops
       * rather than reporting whatever unrelated file happens to sit
       * there (a sibling checkout, a parent monorepo, …).
       */
      reason: "external" | "ambiguous" | "outsideRoots";
    };

export interface ModuleResolverOptions {
  /**
   * Directories an absolute dotted import is resolved against, in the
   * order a project would search them. A module found under more than
   * one root resolves as ambiguous rather than picking the first:
   * `sys.path` order is a runtime fact this reader doesn't have.
   */
  roots: string[];
}

/**
 * Whether `dir` is the root itself or somewhere under it. The boundary
 * is inclusive: a relative import landing exactly on a configured root
 * (the common case for a project's top-level package) is still inside
 * it, not past it.
 */
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

/** The file(s) a dotted path names under one root, package (`__init__.py`) or plain module, most specific first. */
function candidatesUnderRoot(root: string, dotted: string): string[] {
  if (dotted === "") {
    const initFile = path.join(root, "__init__.py");
    return fs.existsSync(initFile) ? [initFile] : [];
  }
  const base = path.join(root, ...dotted.split("."));
  const found: string[] = [];
  const moduleFile = `${base}.py`;
  if (fs.existsSync(moduleFile)) {
    found.push(moduleFile);
  }
  const packageFile = path.join(base, "__init__.py");
  if (fs.existsSync(packageFile)) {
    found.push(packageFile);
  }
  return found;
}

/** Resolve an absolute dotted module path against the configured roots. */
export function resolveAbsoluteModule(
  dotted: string,
  options: ModuleResolverOptions,
): ModuleResolution {
  const byRoot: string[] = [];
  for (const root of options.roots) {
    const candidates = candidatesUnderRoot(root, dotted);
    if (candidates.length > 0) {
      // Within one root, a plain module and a same-named package
      // can't both be what one import statement names; take the
      // module file, the more specific of the two.
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
 * Resolve a relative import (`from . import x`, `from ..pkg import x`)
 * against the file that wrote it. The starting directory is the
 * importing file's own containing directory, not a configured root
 * (Python resolves a relative import against `__package__`, not
 * `sys.path`); `options.roots` instead bounds how far the dot count is
 * allowed to walk upward. A dot count deep enough to step above every
 * configured root abstains rather than searching whatever directory it
 * lands on next: nothing prunes that walk otherwise, so a four-dot
 * import from a nested file would otherwise happily resolve against an
 * unrelated sibling checkout that happens to share a module name.
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

/** `resolveAbsoluteModule` / `resolveRelativeModule`, chosen by whether the import carried any leading dots. */
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
