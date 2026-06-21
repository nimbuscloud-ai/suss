// registrationCall.ts — discover handlers registered via library
// calls. Covers Express (`app.get("/users", h)`), ts-rest
// (`s.router(contract, { getUser })`), Fastify, and similar shapes
// where a runtime API call associates a handler function with a
// route or operation.

import {
  type ArrowFunction,
  type CallExpression,
  type FunctionExpression,
  type MethodDeclaration,
  Node,
  type SourceFile,
} from "ts-morph";

import type { BindingExtraction, DiscoveryPattern } from "@suss/extractor";
import type { DiscoveredUnit } from "./shared.js";

export function discoverRegistrationCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  kind: string,
  bindingExtraction?: BindingExtraction,
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
      // Last-arg-function style: works for any pack whose registration
      // shape is `subject.<method>(arg0, ..., handler)`. The pack's
      // own `bindingExtraction` decides whether the surrounding call
      // has a (method, path) pair the adapter can lift into a routed
      // boundary binding — HTTP packs declare this (their `method`
      // and `path` extractors point at the registration call); a
      // non-HTTP pack like a future `bus.on("event", handler)` would
      // simply omit those extractors, and the adapter falls back to
      // function-call binding.
      const lastArg = args[args.length - 1] as Node | undefined;
      if (lastArg !== undefined) {
        if (
          Node.isArrowFunction(lastArg) ||
          Node.isFunctionExpression(lastArg)
        ) {
          const routeInfo =
            bindingExtraction !== undefined
              ? extractRouteInfoFromBinding(node, methodName, bindingExtraction)
              : null;
          results.push({
            func: lastArg as ArrowFunction | FunctionExpression,
            kind,
            name: methodName,
            ...(routeInfo !== null ? { routeInfo } : {}),
          });
        }
      }
    }
  });

  return results;
}

/**
 * Read a (method, path) pair from a registration-style call site
 * using the pack's own `bindingExtraction` config. Only fires when
 * both halves of the config target the registration call itself
 * (the HTTP pattern: method comes from `.get` / `.post` / etc., path
 * is the first argument). Returns null when either half points
 * elsewhere (e.g. `fromContract`, `fromFilename`) — those shapes
 * need other discovery wiring and don't apply at the registration
 * call site.
 *
 * The point of routing through `bindingExtraction` rather than
 * hardcoding HTTP assumptions is that registrationCall is a generic
 * shape — any pack whose registration looks like
 * `subject.method(arg0, ..., handler)` can use it. Only packs whose
 * `bindingExtraction` says "the method name IS the method and arg N
 * IS the path" should get routed-boundary bindings; everything else
 * stays on the function-call fallback.
 */
function extractRouteInfoFromBinding(
  call: CallExpression,
  methodName: string,
  binding: BindingExtraction,
): { method: string; path: string } | null {
  if (
    binding.method.type !== "fromRegistration" ||
    binding.path.type !== "fromRegistration"
  ) {
    return null;
  }

  let method: string;
  if (binding.method.position === "methodName") {
    method = methodName.toUpperCase();
  } else {
    const args = call.getArguments();
    const arg = args[binding.method.position] as Node | undefined;
    if (
      arg === undefined ||
      !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
    ) {
      return null;
    }
    method = arg.getLiteralValue().toUpperCase();
  }

  const args = call.getArguments();
  const pathArg = args[binding.path.position] as Node | undefined;
  if (
    pathArg === undefined ||
    !(
      Node.isStringLiteral(pathArg) ||
      Node.isNoSubstitutionTemplateLiteral(pathArg)
    )
  ) {
    return null;
  }
  return { method, path: pathArg.getLiteralValue() };
}
