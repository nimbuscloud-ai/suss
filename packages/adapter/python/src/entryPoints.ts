/**
 * Units on the functions a deploy manifest says the platform calls, such
 * as a Lambda's `Handler`. The pack reads the manifest and says which
 * function in this file to use; a Python platform calls a function
 * written at the top of the module, so that is where the name is looked
 * up. A name the module binds some other way, such as
 * `handler = Mangum(app)`, has no body to read and gets no unit.
 */

import { runPackHook } from "@suss/extractor";

import { libraryUnit } from "./reach/closure.js";

import type { PackTally, RawCodeStructure } from "@suss/extractor";
import type { PythonPack } from "./pack.js";
import type { ReachOptions } from "./reach/closure.js";
import type { BoundPythonFile } from "./routers.js";

export function declaredEntryUnits(
  file: BoundPythonFile,
  packs: readonly PythonPack[],
  options: Pick<ReachOptions, "storageFor" | "facts" | "tests"> & {
    /** A pack whose `entryPoints` throws gets no units in this file, and the failure goes on its tally. */
    readonly tallies: ReadonlyMap<string, PackTally>;
  },
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const pack of packs) {
    const entries = runPackHook(
      options.tallies.get(pack.name),
      { pack: pack.name, hook: "entryPoints", file: file.file },
      () => pack.entryPoints?.(file.file) ?? [],
      [],
    );
    for (const entry of entries) {
      const binding = file.module.moduleScope.bindings.get(entry.name);
      if (binding?.kind !== "functionDef") {
        continue;
      }
      for (const declared of entry.units) {
        const raw = libraryUnit(
          {
            file,
            node: binding.node,
            name: declared.name,
            exportPath: [entry.name],
          },
          options,
          declared.binding,
        );
        units.push({
          ...raw,
          identity: { ...raw.identity, kind: declared.kind },
          deployableUnit: declared.deployableUnit,
          ...(declared.metadata !== undefined
            ? { packMetadata: declared.metadata }
            : {}),
        });
      }
    }
  }
  return units;
}
