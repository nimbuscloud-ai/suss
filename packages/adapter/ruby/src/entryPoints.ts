/**
 * Units on the methods a deploy manifest says the platform calls, such as
 * a Lambda's `Handler`. The pack reads the manifest and says which method
 * in this file to use. Ruby's runtime calls either a method written at
 * the top of the file, `handler`, or a class method, which the manifest
 * writes with its class as `Billing::Handler.process`.
 */

import { instanceMethodsByName, singletonMethodsByName } from "./ast.js";
import { libraryUnit } from "./reach/closure.js";
import { walkDefinitions } from "./scope.js";

import type { RawCodeStructure } from "@suss/extractor";
import type { BodyReadOptions, ReachSeed } from "./discovery.js";
import type { RubyPack } from "./pack.js";
import type { RbNode } from "./parser.js";

export interface EntryPointOptions extends BodyReadOptions {
  readonly packs: readonly RubyPack[];
  readonly displayPathOf: (file: string) => string;
  /** Called for each unit, so the reach walk starts from its method. */
  readonly onReachSeed: (raw: RawCodeStructure, seed: ReachSeed) => void;
}

/** The method a manifest's name refers to, and the path the unit is exported under. */
interface EntryMethod {
  node: RbNode;
  exportPath: string[];
  enclosingQualifiedName: string | null;
}

export function declaredEntryUnits(
  root: RbNode,
  file: string,
  options: EntryPointOptions,
): RawCodeStructure[] {
  const units: RawCodeStructure[] = [];
  for (const pack of options.packs) {
    for (const entry of pack.entryPoints?.(file) ?? []) {
      const method = entryMethod(root, entry.name, options);
      if (method === null) {
        continue;
      }
      for (const declared of entry.units) {
        const raw = libraryUnit(
          {
            file,
            node: method.node,
            name: declared.name,
            exportPath: method.exportPath,
          },
          options,
          declared.binding,
        );
        const unit: RawCodeStructure = {
          ...raw,
          identity: { ...raw.identity, kind: declared.kind },
          deployableUnit: declared.deployableUnit,
          ...(declared.metadata !== undefined
            ? { packMetadata: declared.metadata }
            : {}),
        };
        units.push(unit);
        options.onReachSeed(unit, {
          file,
          node: method.node,
          enclosingQualifiedName: method.enclosingQualifiedName,
        });
      }
    }
  }
  return units;
}

/** `Billing::Handler.process` is a class method of `Billing::Handler`; a name with no dot is a method at the top of the file. */
function entryMethod(
  root: RbNode,
  name: string,
  options: BodyReadOptions,
): EntryMethod | null {
  const dot = name.lastIndexOf(".");
  if (dot === -1) {
    const node = instanceMethodsByName(root, options.bodyBlocks).get(name);
    return node === undefined
      ? null
      : { node, exportPath: [name], enclosingQualifiedName: null };
  }
  const className = name.slice(0, dot);
  const methodName = name.slice(dot + 1);
  let found: EntryMethod | null = null;
  walkDefinitions(root, (info) => {
    if (found !== null || info.qualifiedName !== className) {
      return;
    }
    const node =
      info.bodyNode === null
        ? undefined
        : singletonMethodsByName(info.bodyNode, options.bodyBlocks).get(
            methodName,
          );
    if (node !== undefined) {
      found = {
        node,
        exportPath: [className, methodName],
        enclosingQualifiedName: className,
      };
    }
  });
  return found;
}
