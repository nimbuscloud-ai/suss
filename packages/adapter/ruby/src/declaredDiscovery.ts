/**
 * Units from the discovery patterns every adapter reads the same way,
 * such as a method a deploy manifest says the platform calls. The reader
 * in `@suss/recognize` finds each method through the module ops over this
 * adapter's facts; this file hands it the module and builds a unit on
 * each method it finds, the way a reached method is built, so the reach
 * walk starts there too.
 *
 * A class method is found by the path the manifest spells,
 * `Reports::Nightly.run`, through the module's nested class, and its
 * unit is exported as `Reports::Nightly` then `run`, the way Ruby writes
 * the constant.
 */

import {
  bindingOfDiscoveredUnit,
  functionCallBindingOfDiscoveredUnit,
  runPackHook,
} from "@suss/extractor";
import { discoverDeclared } from "@suss/recognize";
import { factCallOps, factModuleOps } from "@suss/recognize/ops";
import { stateHandedIn } from "@suss/resolution";

import { LAMBDA_TYPE, METHOD_TYPES, NESTING_TYPES } from "./ast.js";
import { rubyFactSource } from "./factSource.js";
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
import type { BodyReadOptions, ReachSeed } from "./discovery.js";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

export interface DeclaredDiscoveryOptions extends BodyReadOptions {
  readonly packs: readonly RubyPack[];
  readonly displayPathOf: (file: string) => string;
  /** Called for each unit, so the reach walk starts from its method. */
  readonly onReachSeed: (raw: RawCodeStructure, seed: ReachSeed) => void;
  /** A pattern that throws finds nothing in this file, and the failure goes on its pack's tally. */
  readonly tallies: ReadonlyMap<string, PackTally>;
}

/** How Ruby writes a constant nested in another in one piece. */
const QUALIFIER = "::";

export function declaredDiscoveryUnits(
  root: RbNode,
  file: string,
  options: DeclaredDiscoveryOptions,
): RawCodeStructure[] {
  const { facts } = options;
  if (facts === undefined) {
    return [];
  }
  const units: RawCodeStructure[] = [];
  let module: ModuleOps | null = null;
  for (const pack of options.packs) {
    for (const pattern of pack.declaredDiscovery ?? []) {
      module ??= rubyModuleOps(root, file, facts);
      const inModule = module;
      const found = runPackHook(
        options.tallies.get(pack.name),
        { pack: pack.name, hook: "discovery", file },
        () => discoverDeclared(pattern.match, pattern.kind, inModule),
        [],
      );
      for (const unit of found) {
        const node = unit.func as RbNode;
        if (node.tree !== root.tree) {
          continue;
        }
        if (unit.handedIn !== undefined) {
          stateHandedIn(facts, nodeId(file, node), unit.handedIn);
        }
        units.push(unitOf(file, node, unit, pack, options));
      }
    }
  }
  return units;
}

function unitOf(
  file: string,
  node: RbNode,
  unit: DeclaredUnit,
  pack: RubyPack,
  options: DeclaredDiscoveryOptions,
): RawCodeStructure {
  const path = unit.foundAt ?? [unit.name];
  const method = path[path.length - 1] ?? unit.name;
  const enclosing = path.length > 1 ? path.slice(0, -1).join(QUALIFIER) : null;
  const raw = libraryUnit(
    {
      file,
      node,
      name: unit.name,
      exportPath: enclosing === null ? [method] : [enclosing, method],
    },
    options,
    bindingOfDiscoveredUnit(unit, pack) ??
      functionCallBindingOfDiscoveredUnit(unit, pack),
  );
  const built: RawCodeStructure = {
    ...raw,
    identity: { ...raw.identity, kind: unit.kind as CodeUnitKind },
    ...(unit.deployableUnit !== undefined
      ? { deployableUnit: unit.deployableUnit }
      : {}),
    ...(unit.metadata !== undefined ? { packMetadata: unit.metadata } : {}),
  };
  options.onReachSeed(built, { file, node, enclosingQualifiedName: enclosing });
  return built;
}

/**
 * The file as the declared patterns ask about it. Ruby states every fact
 * before discovery, so the exports are `exportsAs`, and a nested class is
 * a member of the module it is written in.
 */
export function rubyModuleOps(
  root: RbNode,
  file: string,
  db: Database,
): ModuleOps {
  const source = rubyFactSource(db);
  return factModuleOps(file, source, {
    calls: () => callsOutsideMethods(root, file, source),
    classes: () => classesIn(root, file),
    qualifier: QUALIFIER,
  });
}

/** Every class and module the file writes, however deep, in source order. */
function classesIn(root: RbNode, file: string): string[] {
  const found: string[] = [];
  const visit = (node: RbNode): void => {
    if (NESTING_TYPES.has(node.type)) {
      found.push(nodeId(file, node));
    }
    for (const child of node.namedChildren) {
      if (child !== null) {
        visit(child);
      }
    }
  };
  visit(root);
  return found;
}

/** A method, a lambda and a block run later, so their calls are not the file body's. */
const DEFERRED_BODIES: ReadonlySet<string> = new Set([
  ...METHOD_TYPES,
  LAMBDA_TYPE,
  "block",
  "do_block",
]);

function callsOutsideMethods(
  root: RbNode,
  file: string,
  source: FactSource,
): CallOps[] {
  const calls: CallOps[] = [];
  const visit = (node: RbNode): void => {
    if (DEFERRED_BODIES.has(node.type)) {
      return;
    }
    if (node.type === "call") {
      const ops = factCallOps(nodeId(file, node), source);
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
  visit(root);
  return calls;
}
