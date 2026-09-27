/**
 * The public surface of each module a project lists in `suss.json`, as a
 * pack the adapter adds to the run.
 *
 * No library defines a project's modules, so no pack in the registry can
 * declare them. The adapter writes one `moduleSurface` pattern per module
 * instead, and the run then reads each module's public files the way the
 * package-exports pack reads a package's entry points. When `suss.json`
 * does not say which files are public, the module's `index.ts` (or
 * `index.tsx`) is, which is where a TypeScript folder keeps what it
 * exports.
 */

import {
  type DeclaredModule,
  MODULE_SURFACE_RECOGNITION,
  type SettledModule,
  settleModules,
} from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";

export function settleTypeScriptModules(
  modules: readonly DeclaredModule[] | undefined,
): SettledModule[] {
  return settleModules(modules, ["index.ts", "index.tsx"]);
}

/** Null when no module has a public file, so the run loads no extra pack. */
export function moduleSurfacePack(
  modules: readonly SettledModule[],
): PatternPack | null {
  const surfaced = modules.filter((module) => module.public.length > 0);
  if (surfaced.length === 0) {
    return null;
  }
  return {
    name: MODULE_SURFACE_RECOGNITION,
    languages: ["typescript"],
    protocol: "in-process",
    discovery: surfaced.map((module) => ({
      kind: "library",
      match: {
        type: "moduleSurface",
        module: module.name,
        publicFiles: [...module.public],
      },
    })),
    terminals: [
      { kind: "return", match: { type: "returnStatement" }, extraction: {} },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
    ],
    inputMapping: { type: "allPositional" },
  };
}
