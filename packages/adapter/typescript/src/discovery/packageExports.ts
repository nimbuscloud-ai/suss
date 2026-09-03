// packageExports.ts (discovery handler): emit one library-kind unit
// per public-API export of the target package. Pairs with the
// resolver in ../packageExports.ts which reads package.json.

import { Node, type SourceFile } from "ts-morph";

import { exportedDeclarationsOf } from "../moduleExports.js";
import {
  type ResolvedPackageExport,
  resolvePackageExportsCached,
} from "../packageExports.js";
import { sourceDeclarationsBehind } from "../resolve/sourceDeclaration.js";
import { surfaceMethods } from "./factorySurface.js";
import { type DiscoveredUnit, toFunctionRoot } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

export { clearPackageExportsCache } from "../packageExports.js";

export function discoverPackageExports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "packageExports" }>,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  // A workspace-marked pattern only reaches dispatch unexpanded when no
  // workspace manifest was found, and then there is nothing to resolve.
  if (match.packageJsonPath === undefined) {
    return [];
  }

  const { entries } = resolvePackageExportsCached(match.packageJsonPath);
  const filePath = sourceFile.getFilePath();

  // Match this source file against resolved entries. A single
  // source file can back multiple sub-paths (rare, but possible
  // when a barrel is re-exported under two keys), so we collect
  // every matching entry rather than stopping at the first.
  const matching: ResolvedPackageExport[] = [];
  for (const entry of entries) {
    if (entry.sourceFile === filePath) {
      if (
        match.subPaths !== undefined &&
        !match.subPaths.includes(entry.subPath)
      ) {
        continue;
      }
      matching.push(entry);
    }
  }
  if (matching.length === 0) {
    return [];
  }

  const exclude = new Set(match.excludeNames ?? []);
  const results: DiscoveredUnit[] = [];
  const seenNames = new Set<string>();

  if (resolution === undefined) {
    return [];
  }

  for (const entry of matching) {
    const exported = exportedDeclarationsOf(sourceFile, resolution);
    for (const [exportName, decls] of exported) {
      if (exclude.has(exportName)) {
        continue;
      }
      const key = `${entry.subPath}::${exportName}`;
      if (seenNames.has(key)) {
        continue;
      }

      const candidates = decls.flatMap((decl) =>
        sourceDeclarationsBehind(decl, resolution),
      );
      for (const decl of candidates) {
        // Variable initialisers (export const foo = () => ...).
        if (Node.isVariableDeclaration(decl)) {
          const init = decl.getInitializer();
          if (
            init !== undefined &&
            (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
          ) {
            results.push(buildUnit(init, kind, exportName, entry));
            for (const m of surfaceMethods(init)) {
              results.push(buildSurfacedUnit(m, kind, exportName, entry));
            }
            seenNames.add(key);
            break;
          }
          continue;
        }
        // Class declarations: surface public methods only. The class
        // itself isn't a FunctionRoot, so the existing buildUnit path
        // doesn't apply: consumers calling `new Class()` without
        // method calls won't pair against a provider for now (tracked
        // gap; would need a constructor-as-unit synthesis step).
        if (Node.isClassDeclaration(decl)) {
          for (const m of surfaceMethods(decl)) {
            results.push(buildSurfacedUnit(m, kind, exportName, entry));
          }
          seenNames.add(key);
          break;
        }
        const fn = toFunctionRoot(decl);
        if (fn !== null) {
          results.push(buildUnit(fn, kind, exportName, entry));
          for (const m of surfaceMethods(fn)) {
            results.push(buildSurfacedUnit(m, kind, exportName, entry));
          }
          seenNames.add(key);
          break;
        }
      }
    }
  }

  return results;
}

function buildUnit(
  func: FunctionRoot,
  kind: string,
  exportName: string,
  entry: ResolvedPackageExport,
): DiscoveredUnit {
  return {
    func,
    kind,
    name: exportName,
    packageExportInfo: {
      packageName: entry.packageName,
      exportPath: [...entry.exportPathPrefix, exportName],
    },
  };
}

function buildSurfacedUnit(
  m: { func: FunctionRoot; name: string },
  kind: string,
  parentExportName: string,
  entry: ResolvedPackageExport,
): DiscoveredUnit {
  return {
    func: m.func,
    kind,
    name: `${parentExportName}.${m.name}`,
    packageExportInfo: {
      packageName: entry.packageName,
      exportPath: [...entry.exportPathPrefix, parentExportName, m.name],
    },
  };
}
