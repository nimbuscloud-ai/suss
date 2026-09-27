/**
 * One library-kind unit per public export of a package, or of a module
 * the project lists in suss.json. A package's entry files come from the
 * resolver that reads package.json, and a module's come from the list.
 * Both are then walked the same way, so a module export gets the same
 * treatment a package export does: class methods surfaced and barrels
 * followed.
 */

import { Node, type SourceFile } from "ts-morph";

import { exportedDeclarationsOf } from "../moduleExports.js";
import { resolvePackageExportsCached } from "../packageExports.js";
import { sourceDeclarationsBehind } from "../resolve/sourceDeclaration.js";
import { surfaceMethods } from "./factorySurface.js";
import { type DiscoveredUnit, toFunctionRoot } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

export { clearPackageExportsCache } from "../packageExports.js";

/** One entry file of a surface, and the export path its names start with. */
interface SurfaceEntry {
  /** Keyed with each export name, so a file behind two entries is read under both. */
  readonly subPath: string;
  readonly exportPathPrefix: readonly string[];
}

/** Whose surface the exports are on, which decides how each one is keyed. */
type ExportOwner = { readonly package: string } | { readonly module: string };

function identityOf(
  owner: ExportOwner,
  exportPath: readonly string[],
): Pick<DiscoveredUnit, "packageExportInfo" | "functionCallInfo"> {
  if ("module" in owner) {
    return {
      functionCallInfo: {
        module: owner.module,
        exportName: exportPath.join("."),
      },
    };
  }
  return {
    packageExportInfo: {
      packageName: owner.package,
      exportPath: [...exportPath],
    },
  };
}

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

  const { entries, packageName } = resolvePackageExportsCached(
    match.packageJsonPath,
  );
  const filePath = sourceFile.getFilePath();

  // A barrel re-exported under two sub-paths backs both, so every
  // matching entry is kept rather than the first.
  const matching = entries.filter(
    (entry) =>
      entry.sourceFile === filePath &&
      (match.subPaths === undefined || match.subPaths.includes(entry.subPath)),
  );
  return discoverExports(sourceFile, matching, {
    kind,
    exclude: new Set(match.excludeNames ?? []),
    owner: { package: packageName },
    resolution,
  });
}

/**
 * The public exports of one module in `suss.json`. Each is keyed by the
 * module's name and the export's dotted path, so a class method comes out
 * as `fn:billing::InvoiceService.charge`.
 */
export function discoverModuleSurface(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "moduleSurface" }>,
  kind: string,
  resolution?: ResolutionStore,
): DiscoveredUnit[] {
  if (!match.publicFiles.includes(sourceFile.getFilePath())) {
    return [];
  }
  return discoverExports(sourceFile, [{ subPath: ".", exportPathPrefix: [] }], {
    kind,
    exclude: new Set(),
    owner: { module: match.module },
    resolution,
  });
}

interface ExportWalk {
  readonly kind: string;
  readonly exclude: ReadonlySet<string>;
  readonly owner: ExportOwner;
  readonly resolution: ResolutionStore | undefined;
}

function discoverExports(
  sourceFile: SourceFile,
  entries: readonly SurfaceEntry[],
  walk: ExportWalk,
): DiscoveredUnit[] {
  const { resolution } = walk;
  if (entries.length === 0 || resolution === undefined) {
    return [];
  }

  const results: DiscoveredUnit[] = [];
  const seenNames = new Set<string>();
  for (const entry of entries) {
    const exported = exportedDeclarationsOf(sourceFile, resolution);
    for (const [exportName, decls] of exported) {
      if (walk.exclude.has(exportName)) {
        continue;
      }
      const key = `${entry.subPath}::${exportName}`;
      if (seenNames.has(key)) {
        continue;
      }

      const candidates = decls.flatMap((decl) =>
        sourceDeclarationsBehind(decl, resolution),
      );
      const units = unitsForExport(candidates, exportName, entry, {
        ...walk,
        resolution,
      });
      if (units !== null) {
        results.push(...units);
        seenNames.add(key);
      }
    }
  }
  return results;
}

/**
 * The units for one exported name, from the first declaration behind it
 * that is a function or a class, or null when none is.
 */
function unitsForExport(
  candidates: readonly Node[],
  exportName: string,
  entry: SurfaceEntry,
  walk: ExportWalk & { readonly resolution: ResolutionStore },
): DiscoveredUnit[] | null {
  const path = [...entry.exportPathPrefix, exportName];
  for (const decl of candidates) {
    // Variable initialisers (export const foo = () => ...).
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (
        init !== undefined &&
        (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
      ) {
        return [
          exportUnit(init, exportName, path, walk),
          ...methodUnits(init, exportName, path, walk),
        ];
      }
      continue;
    }
    // The class itself is not a function, so only its public methods
    // become units, and a bare `new Class()` pairs with nothing yet.
    if (Node.isClassDeclaration(decl)) {
      return methodUnits(decl, exportName, path, walk);
    }
    const fn = toFunctionRoot(decl);
    if (fn !== null) {
      return [
        exportUnit(fn, exportName, path, walk),
        ...methodUnits(fn, exportName, path, walk),
      ];
    }
  }
  return null;
}

/** The public methods an exported class or factory surfaces, one unit each. */
function methodUnits(
  owner: Node,
  exportName: string,
  path: readonly string[],
  walk: ExportWalk & { readonly resolution: ResolutionStore },
): DiscoveredUnit[] {
  return surfaceMethods(owner, walk.resolution).map((m) =>
    exportUnit(m.func, `${exportName}.${m.name}`, [...path, m.name], walk),
  );
}

function exportUnit(
  func: FunctionRoot,
  name: string,
  exportPath: readonly string[],
  walk: ExportWalk,
): DiscoveredUnit {
  return { func, kind: walk.kind, name, ...identityOf(walk.owner, exportPath) };
}
