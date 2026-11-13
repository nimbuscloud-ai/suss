/**
 * Units from the discovery patterns every adapter reads the same way,
 * such as a function a deploy manifest says the platform calls. The
 * reader in `@suss/recognize` finds each function through the module ops
 * over this adapter's facts; this file hands it the module and builds a
 * unit on each function it finds, the way a reached function is built.
 *
 * A function found in another file, through a name the module imports,
 * gets no unit here, since the unit is read with this file's scope.
 */

import {
  bindingOfDiscoveredUnit,
  functionCallBindingOfDiscoveredUnit,
  runPackHook,
} from "@suss/extractor";
import { discoverDeclared } from "@suss/recognize";
import { factCallOps, factModuleOps } from "@suss/recognize/ops";
import { stateHandedIn } from "@suss/resolution";

import { pythonFactSource } from "./factSource.js";
import { nodeId } from "./facts/values.js";
import { libraryUnit } from "./reach/closure.js";

import type { CodeUnitKind } from "@suss/behavioral-ir";
import type { Database } from "@suss/datalog";
import type {
  CallOps,
  FactSource,
  ModuleOps,
  PackTally,
  RawCodeStructure,
} from "@suss/extractor";
import type { DeclaredUnit } from "@suss/recognize";
import type { PythonPack } from "./pack.js";
import type { PyNode } from "./parser.js";
import type { ReachOptions } from "./reach/closure.js";
import type { BoundPythonFile } from "./routers.js";

export function declaredDiscoveryUnits(
  file: BoundPythonFile,
  packs: readonly PythonPack[],
  options: Pick<ReachOptions, "storageFor" | "facts" | "tests"> & {
    /** A pattern that throws finds nothing in this file, and the failure goes on its pack's tally. */
    readonly tallies: ReadonlyMap<string, PackTally>;
  },
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  let module: ModuleOps | null = null;
  for (const pack of packs) {
    for (const pattern of pack.declaredDiscovery ?? []) {
      module ??= pythonModuleOps(file, options.facts);
      const inModule = module;
      const found = runPackHook(
        options.tallies.get(pack.name),
        { pack: pack.name, hook: "discovery", file: file.file },
        () => discoverDeclared(pattern.match, pattern.kind, inModule),
        [],
      );
      for (const unit of found) {
        const built = unitOf(file, unit, pack, options);
        if (built !== null) {
          units.push(built);
        }
      }
    }
  }
  return units;
}

function unitOf(
  file: BoundPythonFile,
  unit: DeclaredUnit,
  pack: PythonPack,
  options: Pick<ReachOptions, "storageFor" | "facts" | "tests">,
): RawCodeStructure | null {
  const node = unit.func as PyNode;
  if (node.tree !== file.root.tree) {
    return null;
  }
  if (unit.handedIn !== undefined) {
    stateHandedIn(options.facts, nodeId(file.file, node), unit.handedIn);
  }
  const raw = libraryUnit(
    {
      file,
      node,
      name: unit.name,
      exportPath: [...(unit.foundAt ?? [unit.name])],
    },
    options,
    bindingOfDiscoveredUnit(unit, pack) ??
      functionCallBindingOfDiscoveredUnit(unit, pack),
  );
  return {
    ...raw,
    identity: { ...raw.identity, kind: unit.kind as CodeUnitKind },
    ...(unit.deployableUnit !== undefined
      ? { deployableUnit: unit.deployableUnit }
      : {}),
    ...(unit.metadata !== undefined ? { packMetadata: unit.metadata } : {}),
  };
}

/** The module as the declared patterns ask about it. Python states every fact before discovery, so the exports are `exportsAs`. */
export function pythonModuleOps(
  file: BoundPythonFile,
  db: Database,
): ModuleOps {
  const source = pythonFactSource(db);
  return factModuleOps(file.file, source, {
    calls: () => callsOutsideFunctions(file, source),
    classes: () => classesIn(file),
  });
}

/** Every class the module writes, however deep, in source order. */
function classesIn(file: BoundPythonFile): string[] {
  const found: string[] = [];
  const visit = (node: PyNode): void => {
    if (node.type === "class_definition") {
      found.push(nodeId(file.file, node));
    }
    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(file.root);
  return found;
}

/** Functions and lambdas run later, so their calls are not the module body's. */
const DEFERRED_BODIES: ReadonlySet<string> = new Set([
  "function_definition",
  "lambda",
]);

function callsOutsideFunctions(
  file: BoundPythonFile,
  source: FactSource,
): CallOps[] {
  const calls: CallOps[] = [];
  const visit = (node: PyNode): void => {
    if (DEFERRED_BODIES.has(node.type)) {
      return;
    }
    if (node.type === "call") {
      const ops = factCallOps(nodeId(file.file, node), source);
      if (ops !== null) {
        calls.push(ops);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(file.root);
  return calls;
}
