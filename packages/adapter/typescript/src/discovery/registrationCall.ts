// registrationCall.ts (discovery handler) — handlers registered
// through a library call. Covers Express (`app.get("/users", h)`),
// ts-rest (`s.router(contract, { getUser })`), Fastify, and similar
// shapes where a runtime API call associates a handler function with a
// route or operation.
//
// `router.get("/users", listUsers)` is how most Express code is
// written, and reading the syntax at the argument position sees an
// identifier and stops. Which function sits there, and which object
// carries a route's method and path, are both asked of the fact layer.

import { type CallExpression, Node, type SourceFile } from "ts-morph";

import { functionValueOf, objectLiteralOf } from "./resolveValue.js";

import type { BindingExtraction, DiscoveryPattern } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

export function discoverRegistrationCalls(
  sourceFile: SourceFile,
  match: Extract<DiscoveryPattern["match"], { type: "registrationCall" }>,
  kind: string,
  bindingExtraction?: BindingExtraction,
  resolution?: ResolutionStore,
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

  // A function that takes the app as a parameter registers on it the
  // same way. The type annotation names the imported class, which is
  // how a service split across files hands its app around.
  sourceFile.forEachDescendant((node) => {
    if (!Node.isParameterDeclaration(node)) {
      return;
    }
    const typeNode = node.getTypeNode();
    if (typeNode === undefined) {
      return;
    }
    const typeText = typeNode.getText();
    if (
      typeText === importedLocalName ||
      typeText.startsWith(`${importedLocalName}<`)
    ) {
      registrationVarNames.add(node.getName());
    }
  });

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
            func: prop,
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

        const held = functionValueOf(propInit, resolution);
        if (held !== null) {
          results.push({ func: held, kind, name: prop.getName() });
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
      const handler =
        lastArg === undefined ? null : functionValueOf(lastArg, resolution);
      if (handler !== null) {
        const routeInfo =
          bindingExtraction !== undefined
            ? extractRouteInfoFromBinding(
                node,
                methodName,
                bindingExtraction,
                resolution,
              )
            : null;
        results.push({
          func: handler,
          kind,
          name: methodName,
          ...(routeInfo !== null ? { routeInfo } : {}),
        });
      }
    }
  });

  return results;
}

/** The string a property of an object literal holds, or null. */
function stringProperty(obj: Node, name: string): string | null {
  if (!Node.isObjectLiteralExpression(obj)) {
    return null;
  }
  const property = obj.getProperty(name);
  if (property === undefined || !Node.isPropertyAssignment(property)) {
    return null;
  }
  const value = property.getInitializer();
  if (
    value !== undefined &&
    (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value))
  ) {
    return value.getLiteralValue();
  }
  return null;
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
  resolution?: ResolutionStore,
): { method: string; path: string } | null {
  // Both halves on one argument's properties: the registration passes
  // a route object, `app.openapi(route, handler)`, and the object
  // carries its own method and path. The object usually lives on a
  // shared contract in another file, so the fact layer follows the
  // reference to the literal before the properties are read.
  if (
    binding.method.type === "fromArgumentProperty" &&
    binding.path.type === "fromArgumentProperty" &&
    binding.method.position === binding.path.position
  ) {
    const arg = call.getArguments()[binding.method.position];
    if (arg === undefined) {
      return null;
    }
    const routeObject = objectLiteralOf(arg, resolution);
    if (routeObject === null) {
      return null;
    }
    const method = stringProperty(routeObject, binding.method.property);
    const path = stringProperty(routeObject, binding.path.property);
    if (method === null || path === null) {
      return null;
    }
    return { method: method.toUpperCase(), path };
  }

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
