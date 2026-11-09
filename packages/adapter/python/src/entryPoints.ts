/**
 * Units on the functions a deploy manifest says the platform calls, such
 * as a Lambda's `Handler`. The pack reads the manifest and says which
 * function in this file to use; a Python platform calls a function
 * written at the top of the module, so that is where the name is looked
 * up. The name is read through the facts, so `handler = real` finds
 * `real`, which is what the platform calls through it. A name the module
 * binds some other way, such as `handler = Mangum(app)`, has no body to
 * read and gets no unit.
 */

import { runPackHook } from "@suss/extractor";
import { factValueOps } from "@suss/recognize/ops";

import { pythonFactSource } from "./factSource.js";
import { libraryUnit } from "./reach/closure.js";

import type {
  AstCapableValueOps,
  FactSource,
  PackTally,
  RawCodeStructure,
} from "@suss/extractor";
import type { PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
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
  const facts = pythonFactSource(options.facts);
  for (const pack of packs) {
    const entries = runPackHook(
      options.tallies.get(pack.name),
      { pack: pack.name, hook: "entryPoints", file: file.file },
      () => pack.entryPoints?.(file.file) ?? [],
      [],
    );
    for (const entry of entries) {
      const node = exportedFunction(facts, file.file, entry.name);
      // An imported name's def is in another file, and the unit is read with this file's scope.
      if (node === null || node.tree !== file.root.tree) {
        continue;
      }
      for (const declared of entry.units) {
        const raw = libraryUnit(
          {
            file,
            node,
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

/**
 * The def a module-level name comes to. A name written more than once
 * with no one value left in it has no `exportsAs` row, the same answer
 * the binder gives a def written under `if` and `else`.
 */
function exportedFunction(
  facts: FactSource,
  file: string,
  name: string,
): PyNode | null {
  const exported = facts.db
    .lookup("exportsAs", 0, file)
    .find((row) => row[1] === name);
  if (exported === undefined) {
    return null;
  }
  const found = factValueOps(String(exported[2]), facts).function?.() ?? null;
  const node = (found as Partial<AstCapableValueOps> | null)?.ast?.() as
    | PyNode
    | null
    | undefined;
  return node ?? null;
}
