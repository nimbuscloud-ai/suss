// clientCall.ts — discover call sites of a specific imported client
// (axios, fetch, ts-rest initClient, …). Each matched call becomes
// a unit identified by its enclosing function — the consumer
// summary describes what that function does around the call.

import { Node, type SourceFile } from "ts-morph";

import { type DiscoveredUnit, findEnclosingFunction } from "./shared.js";

import type { DiscoveryPattern } from "@suss/extractor";
import type { FunctionRoot } from "../conditions.js";

export function discoverClientCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "clientCall" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];
  const isGlobal = match.importModule === "global";

  // Step 1: Resolve the local name of the imported identifier.
  // For globals (fetch, etc.), match directly on the importName.
  let importedLocalName: string | null = isGlobal ? match.importName : null;

  if (!isGlobal) {
    for (const importDecl of sourceFile.getImportDeclarations()) {
      if (importDecl.getModuleSpecifierValue() !== match.importModule) {
        continue;
      }
      for (const namedImport of importDecl.getNamedImports()) {
        if (
          namedImport.getName() === match.importName ||
          namedImport.getAliasNode()?.getText() === match.importName
        ) {
          importedLocalName =
            namedImport.getAliasNode()?.getText() ?? namedImport.getName();
          break;
        }
      }
      if (importedLocalName !== null) {
        break;
      }
      const defaultImport = importDecl.getDefaultImport();
      if (
        defaultImport !== undefined &&
        defaultImport.getText() === match.importName
      ) {
        importedLocalName = defaultImport.getText();
        break;
      }
    }
  }

  if (importedLocalName === null) {
    return results;
  }

  // Step 2: For non-global imports, find variables holding the result of
  // calling the imported function (`const client = initClient(...)`) OR
  // calling one of its declared factory methods (`const api = axios.create(...)`).
  const clientVarNames = new Set<string>();
  const factoryCallTexts =
    match.factoryMethods !== undefined
      ? new Set(match.factoryMethods.map((m) => `${importedLocalName}.${m}`))
      : null;

  if (!isGlobal) {
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      const init = varDecl.getInitializer();
      if (init === undefined || !Node.isCallExpression(init)) {
        continue;
      }
      const calleeText = init.getExpression().getText();
      if (
        calleeText === importedLocalName ||
        factoryCallTexts?.has(calleeText)
      ) {
        clientVarNames.add(varDecl.getName());
      }
    }
  }

  // Step 3: Walk all call expressions looking for matching client calls
  const methodFilter =
    match.methodFilter !== undefined ? new Set(match.methodFilter) : null;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    let methodName: string | null = null;
    let matched = false;

    if (isGlobal && Node.isIdentifier(callee)) {
      // Bare call: fetch(...)
      if (callee.getText() === importedLocalName) {
        matched = true;
      }
    } else if (Node.isPropertyAccessExpression(callee)) {
      // Method call. Two shapes:
      //   1. client.getUser(...)        — `client` is a variable holding the
      //                                    result of calling the import (e.g.
      //                                    `const client = initClient(...)`).
      //   2. axios.get("/users")        — the import itself is the client and
      //                                    methods are called on it directly.
      const subject = callee.getExpression();
      if (
        Node.isIdentifier(subject) &&
        (clientVarNames.has(subject.getText()) ||
          subject.getText() === importedLocalName)
      ) {
        methodName = callee.getName();
        if (methodFilter === null || methodFilter.has(methodName)) {
          matched = true;
        }
      }
    }

    if (!matched) {
      return;
    }

    // Step 4: Walk up to the enclosing function
    const enclosingFunc = findEnclosingFunction(node);
    if (enclosingFunc === null) {
      return;
    }

    results.push({
      func: enclosingFunc,
      kind,
      name: clientUnitName(enclosingFunc, methodName),
      callSite: {
        callExpression: node,
        methodName,
      },
    });
  });

  return results;
}

/**
 * Pick a stable name for a clientCall-discovered unit by walking the
 * enclosing function's shape. Prefers the function's own identifier,
 * then the variable or property it's bound to, then finally the
 * method name of the call site. "anonymous" is the last-resort
 * label when no other identifier is available.
 */
function clientUnitName(
  enclosingFunc: FunctionRoot,
  methodName: string | null,
): string {
  if (Node.isFunctionDeclaration(enclosingFunc)) {
    return enclosingFunc.getName() ?? methodName ?? "anonymous";
  }
  if (Node.isMethodDeclaration(enclosingFunc)) {
    return enclosingFunc.getName();
  }
  const parent = enclosingFunc.getParent();
  if (parent !== undefined && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  if (parent !== undefined && Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  return methodName ?? "anonymous";
}
