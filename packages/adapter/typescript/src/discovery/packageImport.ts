// packageImport.ts (discovery handler) — emit one consumer-side unit
// per (enclosing function × consumed binding) for any call into a
// targeted package. Pairs with packageExports-discovered providers.
//
// Recognized call shapes:
//   foo(...)                                 // direct call to named import
//   const x = foo(...); x.method(...)        // method on factory result
//   const x = new Foo(...); x.method(...)    // method on class instance
//   const x = await getX(); x.method(...)    // method on awaited factory result
//   foo().method(...)                        // one-shot method on call result
//   new Foo().method(...)                    // method on inline new
//   (await getX()).method(...)               // method on awaited inline call
//   Foo.staticMethod(...)                    // method on the import itself
//   const { method } = foo(); method(...)    // direct call to destructured method
//
// Out of scope: receiver-chain walking (factory().a().b()), reassignment,
// parameter passthrough, namespace imports, re-exports. See
// project_packageimport_gaps.md.

import { Node, type SourceFile } from "ts-morph";

import {
  type FactoryProvenance,
  trackFactoryBindings,
} from "./factoryTracking.js";
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

  // Map local-binding-name → {packageName, exportPath} for every
  // import from a targeted package.
  const localToExport = new Map<string, FactoryProvenance>();

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

  // Walk variable declarations for bindings whose initializer is a
  // call/new (optionally awaited) of a tracked import. The returned
  // table is scope-aware — `resolve(name, fromNode)` walks outward
  // through enclosing function / file scopes, so two sibling
  // functions binding the same name to different factories do not
  // clobber each other.
  const trackedBindings = trackFactoryBindings(sourceFile, (callee) => {
    if (!Node.isIdentifier(callee)) {
      return null;
    }
    return localToExport.get(callee.getText()) ?? null;
  });

  // Resolve the provenance of an arbitrary expression that appears
  // as the receiver in `<expr>.method(...)`. `fromNode` is the call
  // site — used as the lookup origin for scope resolution. Returns
  // null when the receiver doesn't trace to a tracked import or
  // binding.
  function resolveReceiverProvenance(
    node: Node,
    fromNode: Node,
  ): FactoryProvenance | null {
    let n = node;
    // Peel parentheses: `(await x()).method()` parses as
    // PropertyAccess { expression: ParenthesizedExpression { ... } }.
    while (Node.isParenthesizedExpression(n)) {
      n = n.getExpression();
    }
    if (Node.isAwaitExpression(n)) {
      const inner = n.getExpression();
      if (inner === undefined) {
        return null;
      }
      n = inner;
    }
    if (Node.isIdentifier(n)) {
      const text = n.getText();
      return (
        trackedBindings.resolve(text, fromNode) ??
        localToExport.get(text) ??
        null
      );
    }
    if (Node.isCallExpression(n)) {
      const callee = n.getExpression();
      if (Node.isIdentifier(callee)) {
        return localToExport.get(callee.getText()) ?? null;
      }
      return null;
    }
    if (Node.isNewExpression(n)) {
      const expr = n.getExpression();
      if (expr !== undefined && Node.isIdentifier(expr)) {
        return localToExport.get(expr.getText()) ?? null;
      }
      return null;
    }
    return null;
  }

  // Attribute a CallExpression's callee to a (packageName, exportPath)
  // pair, or return null when the call isn't into a tracked import.
  function attributeCall(callee: Node): FactoryProvenance | null {
    if (Node.isIdentifier(callee)) {
      const text = callee.getText();
      return (
        trackedBindings.resolve(text, callee) ?? localToExport.get(text) ?? null
      );
    }
    if (Node.isPropertyAccessExpression(callee)) {
      const subject = callee.getExpression();
      const subjectProvenance = resolveReceiverProvenance(subject, callee);
      if (subjectProvenance === null) {
        return null;
      }
      return {
        packageName: subjectProvenance.packageName,
        exportPath: [...subjectProvenance.exportPath, callee.getName()],
      };
    }
    return null;
  }

  const results: DiscoveredUnit[] = [];
  // Dedup: one unit per (enclosing function × consumed exportPath).
  // Multiple call sites inside the same function targeting the same
  // export collapse to a single unit — the consumer summary describes
  // the function's behaviour around the boundary, not each call.
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }
    const callee = node.getExpression();
    const provenance = attributeCall(callee);
    if (provenance === null) {
      return;
    }

    const enclosing = findEnclosingFunction(node);
    if (enclosing === null) {
      return;
    }

    const key = `${enclosing.getStart()}-${enclosing.getEnd()}-${provenance.packageName}::${provenance.exportPath.join(".")}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);

    results.push({
      func: enclosing,
      kind,
      name: enclosingFunctionName(enclosing),
      packageExportInfo: {
        packageName: provenance.packageName,
        exportPath: provenance.exportPath,
      },
    });
  });

  return results;
}
