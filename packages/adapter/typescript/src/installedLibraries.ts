/**
 * The manifests of the installed libraries a run's packs read through
 * `node_modules`, as inputs to the extraction cache's key.
 *
 * A pack says which libraries it reads by the imports it waits for, and
 * the type checker reads their types from `node_modules`, where the
 * cache stamps no file. Installing another version of one changes what
 * the pack recognises without changing a walked file, so each library's
 * `package.json`, with the version in it, goes into the key. A pack that
 * reads code a library's generator writes, such as a Prisma client,
 * declares those files itself.
 */

import fs from "node:fs";
import path from "node:path";

import type { PatternPack } from "@suss/extractor";

type GatingPack = Pick<PatternPack, "requiresImport" | "discovery">;

/** A pack-shaped declaration of those manifests, for the cache's run digest. */
export function installedLibraryInputs(
  packs: ReadonlyArray<GatingPack>,
  fromDir: string | undefined,
): { discoveryInputs: () => string[] } {
  return {
    discoveryInputs: () =>
      fromDir === undefined
        ? []
        : [...new Set(packs.flatMap(librariesOf))]
            .sort()
            .flatMap((name) => manifestsOf(name, fromDir)),
  };
}

function librariesOf(pack: GatingPack): string[] {
  return [
    ...(pack.requiresImport ?? []),
    ...pack.discovery.flatMap((pattern) => pattern.requiresImport ?? []),
  ];
}

/**
 * The manifest Node would load the library from, the nearest
 * `node_modules` up from `fromDir` that has it. A bare scope such as
 * `@ts-rest` means every package installed under it.
 */
function manifestsOf(name: string, fromDir: string): string[] {
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const installed = path.join(dir, "node_modules", name);
    if (fs.existsSync(installed)) {
      return isBareScope(name)
        ? scopedManifests(installed)
        : [path.join(installed, "package.json")];
    }

    if (path.dirname(dir) === dir) {
      return [];
    }
  }
}

function isBareScope(name: string): boolean {
  return name.startsWith("@") && !name.includes("/");
}

function scopedManifests(scopeDir: string): string[] {
  try {
    return fs
      .readdirSync(scopeDir)
      .sort()
      .map((entry) => path.join(scopeDir, entry, "package.json"));
  } catch {
    return [];
  }
}
