// registrationCall.ts — discover handlers registered via library
// calls. Covers Express (`app.get("/users", h)`), ts-rest
// (`s.router(contract, { getUser })`), Fastify, and similar shapes
// where a runtime API call associates a handler function with a
// route or operation.

import {
  type ArrowFunction,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
} from "ts-morph";

import type { DiscoveryPattern } from "@suss/extractor";
import type { DiscoveredUnit } from "./shared.js";

export function discoverRegistrationCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  kind: string,
): DiscoveredUnit[] {
  const results: DiscoveredUnit[] = [];

  // Step 1: Find the import declaration
  let importedLocalName: string | null = null;

  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== match.importModule) {
      continue;
    }

    // Named import
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

    // Default import
    const defaultImport = importDecl.getDefaultImport();
    if (
      defaultImport !== undefined &&
      defaultImport.getText() === match.importName
    ) {
      importedLocalName = defaultImport.getText();
      break;
    }

    // Namespace import
    const namespaceImport = importDecl.getNamespaceImport();
    if (
      namespaceImport !== undefined &&
      namespaceImport.getText() === match.importName
    ) {
      importedLocalName = namespaceImport.getText();
      break;
    }
  }

  if (importedLocalName === null) {
    return results;
  }

  // Step 2: Find what variable holds the result of calling the imported function
  // e.g. const s = initServer(); or const router = Router();
  const registrationVarNames = new Set<string>();

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const init = varDecl.getInitializer();
    if (init === undefined) {
      continue;
    }

    // Might be: initServer() or new Router() etc.
    let calleeText: string | null = null;
    if (Node.isCallExpression(init)) {
      calleeText = init.getExpression().getText();
    } else if (Node.isNewExpression(init)) {
      calleeText = init.getExpression().getText();
    }

    if (calleeText === importedLocalName) {
      registrationVarNames.add(varDecl.getName());
    }
  }

  // Step 3: Walk all call expressions and match registration chains
  const registrationMethods = match.registrationChain.map((c) =>
    c.startsWith(".") ? c.slice(1) : c,
  );

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) {
      return;
    }

    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) {
      return;
    }

    const methodName = callee.getName();
    if (!registrationMethods.includes(methodName)) {
      return;
    }

    // The subject of the call must resolve to our registration variable
    const subject = callee.getExpression();
    let subjectName: string | null = null;

    if (Node.isIdentifier(subject)) {
      subjectName = subject.getText();
    }

    if (subjectName === null || !registrationVarNames.has(subjectName)) {
      return;
    }

    // Step 4: Extract handlers from the call
    const args = node.getArguments();

    // ts-rest style: second arg is object literal with handler methods
    let foundObjectArg = false;
    for (const arg of args) {
      if (!Node.isObjectLiteralExpression(arg)) {
        continue;
      }

      foundObjectArg = true;
      for (const prop of arg.getProperties()) {
        // Method shorthand: { async getUser() { ... } }
        if (Node.isMethodDeclaration(prop)) {
          results.push({
            func: prop as MethodDeclaration,
            kind,
            name: prop.getName(),
          });
          continue;
        }

        if (!Node.isPropertyAssignment(prop)) {
          continue;
        }

        const propInit = prop.getInitializer();
        if (propInit === undefined) {
          continue;
        }

        if (
          Node.isArrowFunction(propInit) ||
          Node.isFunctionExpression(propInit)
        ) {
          results.push({
            func: propInit as ArrowFunction | FunctionExpression,
            kind,
            name: prop.getName(),
          });
        }
      }
    }

    if (!foundObjectArg) {
      // Express style: last arg is a function
      const lastArg = args[args.length - 1] as Node | undefined;
      if (lastArg !== undefined) {
        if (
          Node.isArrowFunction(lastArg) ||
          Node.isFunctionExpression(lastArg)
        ) {
          results.push({
            func: lastArg as ArrowFunction | FunctionExpression,
            kind,
            name: methodName,
          });
        }
      }
    }
  });

  return results;
}
