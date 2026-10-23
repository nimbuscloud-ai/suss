/**
 * Units on the functions a deploy manifest says the platform calls, such
 * as a Lambda's `Handler`. The pack reads the manifest and says which
 * function in this file to use; a Python platform calls a function
 * written at the top of the module, so that is where the name is looked
 * up. A name the module binds some other way, such as
 * `handler = Mangum(app)`, has no body to read and gets no unit.
 */

import { libraryUnit } from "./reach/closure.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { PythonPack } from "./pack.js";
import type { ReachOptions } from "./reach/closure.js";
import type { BoundPythonFile } from "./routers.js";

export function declaredEntryUnits(
  file: BoundPythonFile,
  packs: readonly PythonPack[],
  options: Pick<ReachOptions, "storageFor" | "facts" | "tests">,
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const pack of packs) {
    for (const entry of pack.entryPoints?.(file.file) ?? []) {
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
