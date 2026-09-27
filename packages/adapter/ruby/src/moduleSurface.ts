/**
 * The public exports of each module a project lists in `suss.json`, one
 * `library` unit each, keyed `fn:<module>::<exportName>`.
 *
 * Ruby has no export statement, so a module's surface is every method a
 * class or module in its public file defines for callers: each class
 * method, spelled `Billing.charge_invoice`, and each public instance
 * method, spelled `Billing::Invoice#total` the way Ruby's own
 * documentation writes one. When `suss.json` does not say which file is
 * public, it is the file named for the module, inside the root or next
 * to it, as a gem keeps `lib/billing.rb` beside `lib/billing/`.
 */

import { moduleExportBinding } from "@suss/behavioral-ir";
import {
  type DeclaredModule,
  MODULE_SURFACE_RECOGNITION,
  moduleOfFile,
  type SettledModule,
  settleModules,
} from "@suss/extractor";

import {
  instanceMethodsByName,
  instanceMethodVisibility,
  singletonMethodsByName,
} from "./ast.js";
import { libraryUnit } from "./reach/closure.js";
import { walkDefinitions } from "./scope.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { BodyReadOptions, ReachSeed } from "./discovery.js";
import type { RbNode } from "./parser.js";

export function settleRubyModules(
  modules: readonly DeclaredModule[] | undefined,
): SettledModule[] {
  return settleModules(modules, ["{name}.rb", "../{name}.rb"]);
}

export interface ModuleSurfaceOptions extends BodyReadOptions {
  readonly modules: readonly SettledModule[];
  readonly displayPathOf: (file: string) => string;
  /** Called for each unit, so the reach walk starts from its method as it does from a route's. */
  readonly onReachSeed: (raw: RawCodeStructure, seed: ReachSeed) => void;
}

/** The module export units in `file`, which is empty unless it is a module's public file. */
export function moduleExportUnits(
  root: RbNode,
  file: string,
  options: ModuleSurfaceOptions,
): RawCodeStructure[] {
  const module = moduleOfFile(options.modules, file);
  if (module === undefined || !module.public.includes(file)) {
    return [];
  }
  const units: RawCodeStructure[] = [];
  walkDefinitions(root, (info) => {
    if (info.bodyNode === null) {
      return;
    }
    const exported = [
      ...[...singletonMethodsByName(info.bodyNode, options.bodyBlocks)].map(
        ([method, node]) => ({ method, node, separator: "." }),
      ),
      ...publicInstanceMethods(info.bodyNode, options).map(
        ([method, node]) => ({ method, node, separator: "#" }),
      ),
    ];
    for (const { method, node, separator } of exported) {
      const name = `${info.qualifiedName}${separator}${method}`;
      const raw = libraryUnit(
        {
          file,
          node,
          name,
          exportPath: [info.qualifiedName, method],
        },
        options,
        moduleExportBinding({
          recognition: MODULE_SURFACE_RECOGNITION,
          module: module.name,
          exportName: name,
        }),
      );
      units.push(raw);
      options.onReachSeed(raw, {
        file,
        node,
        enclosingQualifiedName: info.qualifiedName,
      });
    }
  });
  return units;
}

function publicInstanceMethods(
  body: RbNode,
  options: BodyReadOptions,
): Array<[string, RbNode]> {
  const visibility = instanceMethodVisibility(body);
  return [...instanceMethodsByName(body, options.bodyBlocks)].filter(
    ([name]) => (visibility.get(name) ?? "public") === "public",
  );
}
