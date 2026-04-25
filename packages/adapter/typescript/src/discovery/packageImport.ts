// packageImport.ts (discovery handler) — emit one consumer-side unit
// per (enclosing function × consumed binding) for any call into a
// targeted package. Pairs with packageExports-discovered providers.

import { Node, type SourceFile } from "ts-morph";

import { type DiscoveredUnit, findEnclosingFunction } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

function splitPackageSpec(spec: string): {
  packageName: string;
  subPath: string[];
} {
  // Scoped packages keep the first two segments together (`@scope/pkg`).
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    if (parts.length < 2) {
      return { packageName: spec, subPath: [] };
    }
    const packageName = `${parts[0]}/${parts[1]}`;
    const subPath = parts.slice(2);
    return { packageName, subPath };
  }
  const parts = spec.split("/");
  return {
    packageName: parts[0],
    subPath: parts.slice(1),
  };
}

function enclosingFunctionName(func: FunctionRoot): string {
  if (Node.isFunctionDeclaration(func) || Node.isMethodDeclaration(func)) {
    const n = func.getName?.();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  if (Node.isFunctionExpression(func)) {
    const n = func.getName();
    if (typeof n === "string" && n.length > 0) {
      return n;
    }
  }
  // Arrow / anonymous: climb to the containing variable or property.
  const parent = func.getParent();
  if (parent !== undefined) {
    if (Node.isVariableDeclaration(parent)) {
      return parent.getName();
    }
    if (Node.isPropertyAssignment(parent)) {
      return parent.getName();
    }
  }
  return "<anon>";
}

export function discoverPackageImports(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "packageImport" }>,
  kind: string,
): DiscoveredUnit[] {
  const targetPackages = new Set(match.packages);

  // Map local-binding-name → { packageName, exportPath } for every
  // import from a targeted package.
  const localToExport = new Map<
    string,
    { packageName: string; exportPath: string[] }
  >();

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const moduleSpec = importDecl.getModuleSpecifierValue();
    if (!targetPackages.has(moduleSpec)) {
      continue;
    }
    const { packageName, subPath } = splitPackageSpec(moduleSpec);
    for (const namedImport of importDecl.getNamedImports()) {
      const imported = namedImport.getName();
      const local = namedImport.getAliasNode()?.getText() ?? imported;
      localToExport.set(local, {
        packageName,
        exportPath: [...subPath, imported],
      });
    }
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport !== undefined) {
      localToExport.set(defaultImport.getText(), {
        packageName,
        exportPath: [...subPath, "default"],
      });
    }
  }

  if (localToExport.size === 0) {
    return [];
  }

  const results: DiscoveredUnit[] = [];
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    if (!Node.isIdentifier(callee)) {
      return;
    }
    const localName = callee.getText();
    const info = localToExport.get(localName);
    if (info === undefined) {
      return;
    }

    const enclosing = findEnclosingFunction(node);
    if (enclosing === null) {
      return;
    }

    // One unit per (enclosing function × consumed binding). Multiple
    // call sites inside the same function to the same imported binding
    // collapse to one unit — the consumer summary describes the
    // function's behaviour around that boundary, not individual calls.
    const key = `${enclosing.getStart()}-${enclosing.getEnd()}-${info.packageName}::${info.exportPath.join(".")}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    results.push({
      func: enclosing,
      kind,
      name: enclosingFunctionName(enclosing),
      packageExportInfo: info,
    });
  });

  return results;
}
