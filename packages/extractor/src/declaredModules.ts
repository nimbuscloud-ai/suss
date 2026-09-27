/**
 * The modules a project lists in `suss.json`, as every adapter reads them.
 *
 * A module is a name, a root folder, and the files whose exports other
 * modules are meant to call. The CLI reads the list and hands it to the
 * adapter with absolute paths. Which file is public when the list does not
 * say is a fact about the language, so each adapter settles that first.
 * The rest is the same in all three adapters: which module a file belongs
 * to, the module stamped on each summary, and the part of the cache key
 * that makes an edit to the list run discovery again.
 */

import fs from "node:fs";
import path from "node:path";

import type { BehavioralSummary } from "@suss/behavioral-ir";

/** The recognition on every module export's binding, in each language. */
export const MODULE_SURFACE_RECOGNITION = "modules";

export interface DeclaredModule {
  readonly name: string;
  /** Absolute. Every file under it belongs to the module. */
  readonly root: string;
  /**
   * Absolute. The files whose exports are the module's public surface.
   * Left out when `suss.json` does not say, and then the adapter's
   * convention for its language decides.
   */
  readonly public?: readonly string[];
}

/** A module whose public files are settled. An empty list means it has none. */
export interface SettledModule extends DeclaredModule {
  readonly public: readonly string[];
}

/**
 * Each module with its public files. A module `suss.json` gave files for
 * keeps them. Otherwise the language's candidates are tried, and only the
 * ones on disk are kept. A candidate is a path relative to the module's
 * root, with `{name}` standing for the module's name, as in `index.ts`
 * or `../{name}.rb`.
 */
export function settleModules(
  modules: readonly DeclaredModule[] | undefined,
  candidates: readonly string[],
): SettledModule[] {
  return (modules ?? []).map((module) => ({
    ...module,
    public:
      module.public ??
      candidates
        .map((one) =>
          path.join(module.root, one.replace("{name}", module.name)),
        )
        .filter((file) => fs.existsSync(file)),
  }));
}

function isInside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/**
 * The module a file belongs to. A public file belongs to its module even
 * when it is outside the root, as a Ruby `lib/billing.rb` is next to
 * `lib/billing/`. Otherwise the deepest root that contains the file
 * wins, so a module nested inside another's folder keeps its own files.
 */
export function moduleOfFile(
  modules: readonly SettledModule[],
  file: string,
): SettledModule | undefined {
  const byPublicFile = modules.find((module) => module.public.includes(file));
  if (byPublicFile !== undefined) {
    return byPublicFile;
  }

  let deepest: SettledModule | undefined;
  for (const module of modules) {
    if (
      isInside(file, module.root) &&
      (deepest === undefined || module.root.length > deepest.root.length)
    ) {
      deepest = module;
    }
  }
  return deepest;
}

/**
 * Writes each summary's module onto its location. `root` is the directory
 * a shortened `location.file` is relative to, when the adapter has
 * already shortened it.
 */
export function stampModules(
  summaries: readonly BehavioralSummary[],
  modules: readonly SettledModule[],
  root: string | undefined,
): void {
  if (modules.length === 0) {
    return;
  }
  for (const summary of summaries) {
    const file = path.resolve(root ?? "", summary.location.file);
    const module = moduleOfFile(modules, file);
    if (module !== undefined) {
      summary.location.module = module.name;
    }
  }
}

/**
 * The module list as part of the cache key. It is undefined for a project
 * with no list, so adding this left every existing key as it was.
 */
export function modulesStamp(
  modules: readonly SettledModule[] | undefined,
): string | undefined {
  if (modules === undefined || modules.length === 0) {
    return undefined;
  }
  return JSON.stringify(
    modules.map((module) => [module.name, module.root, [...module.public]]),
  );
}
