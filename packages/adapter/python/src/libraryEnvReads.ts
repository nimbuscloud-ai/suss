/**
 * One marker per library a pack says reads environment variables from
 * its own installed code, when some file in the run imports it. The
 * marker goes on the first such file, the same way the TypeScript
 * adapter places it.
 */

import { libraryEnvReadMarker } from "@suss/extractor";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { PythonPack } from "./pack.js";
import type { BoundPythonFile } from "./routers.js";

export function libraryEnvReadMarkers(
  files: readonly BoundPythonFile[],
  packs: readonly PythonPack[],
): BehavioralSummary[] {
  const markers: BehavioralSummary[] = [];
  for (const pack of packs) {
    for (const declared of pack.libraryEnvVars ?? []) {
      const importer = files.find((file) =>
        importsModule(file, declared.module),
      );
      if (importer !== undefined) {
        markers.push(
          libraryEnvReadMarker(pack.name, declared, importer.displayPath),
        );
      }
    }
  }
  return markers;
}

function importsModule(file: BoundPythonFile, prefix: string): boolean {
  for (const binding of file.module.moduleScope.bindings.values()) {
    if (
      (binding.kind === "import" || binding.kind === "importFrom") &&
      binding.relativeLevel === 0 &&
      binding.module.startsWith(prefix)
    ) {
      return true;
    }
  }
  return false;
}
