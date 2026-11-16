/**
 * The files of a run, each parsed and bound once, and the lookup from a
 * module a file imports to the file in the run that defines it.
 */

import { resolveModule } from "./moduleResolver.js";

import type { ModuleResolverOptions } from "./moduleResolver.js";
import type { PyNode } from "./parser.js";
import type { ModuleBinding } from "./scope.js";

/** One file, already parsed and bound. A run is read as a list of these. */
export interface BoundPythonFile {
  /** The absolute path. Module resolution matches files on it. */
  file: string;
  /** The path a gap reason prints for this file, so a reader can open it. */
  displayPath: string;
  root: PyNode;
  module: ModuleBinding;
}

/** The file in this run that a module written in `fromFile` refers to, or null when the module is outside the run. */
export function boundModuleAt(
  fromFile: string,
  spec: { module: string; relativeLevel: number },
  byFile: ReadonlyMap<string, BoundPythonFile>,
  resolverOptions: ModuleResolverOptions,
): BoundPythonFile | null {
  const resolution = resolveModule(fromFile, spec, resolverOptions);
  if (resolution.status !== "resolved") {
    return null;
  }
  return byFile.get(resolution.file) ?? null;
}
