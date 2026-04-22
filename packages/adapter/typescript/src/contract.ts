// contract.ts — Contract reading for ts-rest style frameworks (Task 2.5b)
//
// Given a DiscoveredUnit that was registered via s.router(contract, { handlers }),
// trace back to the contract definition and extract declared responses.

import { Node } from "ts-morph";

import { restBinding } from "@suss/behavioral-ir";

import { shapeFromNodeType } from "./type-shapes.js";

import type { BoundaryBinding, TypeShape } from "@suss/behavioral-ir";
import type { ContractPattern, RawDeclaredContract } from "@suss/extractor";
import type { DiscoveredUnit } from "./discovery.js";

// ---------------------------------------------------------------------------
// Result type — includes both contract data and extracted binding
// ---------------------------------------------------------------------------

export interface ContractReadResult {
  declaredContract: RawDeclaredContract;
  boundaryBinding: BoundaryBinding | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a `TypeShape` from a response-schema expression like
 * `c.type<{ id: string }>()`. Pulls the first type argument of the call and
 * runs it through the shared shape extractor. Returns null for unsupported
 * forms (zod schemas, raw references, missing type arguments) — the contract
 * entry still records the status code, just without a body shape.
 */
function extractDeclaredBody(node: Node | undefined): TypeShape | null {
  if (node === undefined) {
    return null;
  }
  if (!Node.isCallExpression(node)) {
    return null;
  }
  const typeArgs = node.getTypeArguments();
  if (typeArgs.length === 0) {
    return null;
  }
  return shapeFromNodeType(typeArgs[0]);
}

/**
 * Walk up one step from the handler function to find the property
 * node that lives on the handlers object. Two shapes:
 *   - Arrow/function expr: `func` is a value assigned to a
 *     PropertyAssignment → return the PropertyAssignment.
 *   - Method shorthand: `func` IS a MethodDeclaration → return it.
 * Anything else (a standalone top-level function, an expression
 * statement, a function-declaration not in a router) returns null.
 */
function resolveHandlerPropNode(func: Node): Node | null {
  const parent = func.getParent();
  if (parent === undefined) {
    return null;
  }
  if (Node.isPropertyAssignment(parent)) {
    return parent;
  }
  if (Node.isMethodDeclaration(func)) {
    return func;
  }
  return null;
}

/**
 * Walk up from the handler function node to find the enclosing .router() call.
 *
 * Expected parent chain:
 *   ArrowFunction/FunctionExpression → PropertyAssignment → ObjectLiteralExpression → CallExpression
 *
 * Or for method shorthand:
 *   MethodDeclaration → ObjectLiteralExpression → CallExpression
 */
function findRouterCall(unit: DiscoveredUnit): {
  contractArg: Node;
  handlerName: string;
} | null {
  const func = unit.func;
  const propNode = resolveHandlerPropNode(func);
  if (propNode === null) {
    return null;
  }

  // The property's parent should be the handlers ObjectLiteralExpression
  const handlersObj = propNode.getParent();
  if (
    handlersObj === undefined ||
    !Node.isObjectLiteralExpression(handlersObj)
  ) {
    return null;
  }

  // The handlers object's parent should be the .router() CallExpression
  const routerCall = handlersObj.getParent();
  if (routerCall === undefined || !Node.isCallExpression(routerCall)) {
    return null;
  }

  // The first argument to .router() is the contract reference
  const args = routerCall.getArguments();
  if (args.length === 0) {
    return null;
  }

  return {
    contractArg: args[0],
    handlerName: unit.name,
  };
}

/**
 * Given a contract reference node, resolve it to the object literal that
 * defines the contract routes.
 *
 * Expected shapes:
 *   - ObjectLiteralExpression → already the routes literal
 *   - Identifier → follow symbol to VariableDeclaration → initializer is
 *     `c.router({ ... })` (or a direct object literal)
 *   - PropertyAccessExpression → composed contracts like
 *     `s.router(apiContract.internal, { ... })`. Resolve the base to its
 *     routes literal, pick the named property, and recurse on the value
 *     (usually another identifier bound to `subContract.router({ ... })`).
 */
function resolveContractObject(contractArg: Node): Node | null {
  // If it's already an object literal, return it
  if (Node.isObjectLiteralExpression(contractArg)) {
    return contractArg;
  }

  // Composed contracts: `apiContract.internal` — resolve the base to its
  // routes literal, then pick the property whose name matches the access.
  // The property's value is typically another identifier bound to a
  // sub-contract (`internal: internalApi`); recursion handles the chain.
  if (Node.isPropertyAccessExpression(contractArg)) {
    const base = resolveContractObject(contractArg.getExpression());
    if (base === null || !Node.isObjectLiteralExpression(base)) {
      return null;
    }
    const propName = contractArg.getName();
    for (const prop of base.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) {
        continue;
      }
      if (prop.getName() !== propName) {
        continue;
      }
      const value = prop.getInitializer();
      if (value === undefined) {
        return null;
      }
      if (Node.isObjectLiteralExpression(value)) {
        return value;
      }
      if (Node.isIdentifier(value) || Node.isPropertyAccessExpression(value)) {
        return resolveContractObject(value);
      }
      if (Node.isCallExpression(value)) {
        return unwrapContractInit(value);
      }
      return null;
    }
    return null;
  }

  // Follow the identifier to its declaration
  if (!Node.isIdentifier(contractArg)) {
    return null;
  }

  const symbol = contractArg.getSymbol();
  if (symbol === undefined) {
    return null;
  }

  const decls = symbol.getDeclarations();
  if (decls.length === 0) {
    return null;
  }

  const decl = decls[0];

  // Handle import specifier → follow to the source file's export
  if (Node.isImportSpecifier(decl)) {
    const importDecl = decl.getImportDeclaration();
    const sourceFile = importDecl.getModuleSpecifierSourceFile();
    if (sourceFile !== undefined) {
      // Use the original (non-aliased) name to find the export
      const exported = sourceFile.getExportedDeclarations().get(decl.getName());
      if (exported !== undefined && exported.length > 0) {
        const exportedDecl = exported[0];
        if (Node.isVariableDeclaration(exportedDecl)) {
          return unwrapContractInit(exportedDecl.getInitializer());
        }
      }
    }
    return null;
  }

  if (Node.isVariableDeclaration(decl)) {
    return unwrapContractInit(decl.getInitializer());
  }

  return null;
}

/**
 * Unwrap a contract initializer like `c.router({ ... })` to get the routes object.
 */
function unwrapContractInit(init: Node | undefined): Node | null {
  if (init === undefined) {
    return null;
  }

  // c.router({ getUser: { ... }, createUser: { ... } })
  if (Node.isCallExpression(init)) {
    const args = init.getArguments();
    if (args.length > 0 && Node.isObjectLiteralExpression(args[0])) {
      return args[0];
    }
    return null;
  }

  // Direct object literal
  if (Node.isObjectLiteralExpression(init)) {
    return init;
  }

  return null;
}

/**
 * Extract responses from a single endpoint definition in the contract.
 *
 * Expected shape:
 * ```
 * getUser: {
 *   method: "GET",
 *   path: "/users/:id",
 *   responses: {
 *     200: c.type<...>(),
 *     404: c.type<...>(),
 *   }
 * }
 * ```
 */
function extractEndpointContract(
  endpointNode: Node,
  pattern: ContractPattern,
  framework: string,
): ContractReadResult | null {
  if (!Node.isObjectLiteralExpression(endpointNode)) {
    return null;
  }

  const responses: RawDeclaredContract["responses"] = [];
  let method: string | undefined;
  let path: string | undefined;

  for (const prop of endpointNode.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) {
      continue;
    }

    const propName = prop.getName();

    // Extract method
    if (propName === "method") {
      const val = prop.getInitializer();
      if (val !== undefined && Node.isStringLiteral(val)) {
        method = val.getLiteralValue();
      }
    }

    // Extract path
    if (propName === "path") {
      const val = prop.getInitializer();
      if (val !== undefined && Node.isStringLiteral(val)) {
        path = val.getLiteralValue();
      }
    }

    // Extract responses
    if (propName === pattern.responseExtraction.property) {
      const val = prop.getInitializer();
      if (val !== undefined && Node.isObjectLiteralExpression(val)) {
        for (const respProp of val.getProperties()) {
          if (!Node.isPropertyAssignment(respProp)) {
            continue;
          }

          const statusStr = respProp.getName();
          const statusCode = Number(statusStr);
          if (!Number.isFinite(statusCode)) {
            continue;
          }

          const body = extractDeclaredBody(respProp.getInitializer());
          responses.push(body !== null ? { statusCode, body } : { statusCode });
        }
      }
    }
  }

  if (responses.length === 0) {
    return null;
  }

  const boundaryBinding: BoundaryBinding | null =
    method !== undefined || path !== undefined
      ? restBinding({
          transport: "http",
          method: method ?? "",
          path: path ?? "",
          recognition: framework,
        })
      : null;

  // Contract-reading packs (ts-rest, ts-rest clients) read a contract
  // that is authored *separately* from the handler implementation the
  // same summary's transitions come from. That makes them "independent"
  // observations — comparing transitions against this contract is
  // meaningful (the implementation can drift from the declaration).
  return {
    declaredContract: { framework, responses, provenance: "independent" },
    boundaryBinding,
  };
}

// ---------------------------------------------------------------------------
// Main exported function — provider side
// ---------------------------------------------------------------------------

/**
 * Read the declared contract for a discovered handler unit.
 *
 * Traces from the handler's registration site (e.g., `s.router(contract, { ... })`)
 * back to the contract definition, then extracts the declared responses for
 * this specific endpoint.
 *
 * Returns null if the handler wasn't registered with a contract or the contract
 * can't be resolved.
 */
export function readContract(
  unit: DiscoveredUnit,
  pattern: ContractPattern,
): ContractReadResult | null {
  // Step 1: Find the .router() call enclosing this handler
  const routerInfo = findRouterCall(unit);
  if (routerInfo === null) {
    return null;
  }

  // Step 2: Resolve the contract argument to the routes object literal
  const contractObj = resolveContractObject(routerInfo.contractArg);
  if (contractObj === null || !Node.isObjectLiteralExpression(contractObj)) {
    return null;
  }

  // Step 3: Find the endpoint matching this handler's name
  for (const prop of contractObj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) {
      continue;
    }

    if (prop.getName() !== routerInfo.handlerName) {
      continue;
    }

    const endpointInit = prop.getInitializer();
    if (endpointInit === undefined) {
      continue;
    }

    return extractEndpointContract(
      endpointInit,
      pattern,
      pattern.discovery.importModule.split("/").pop() ?? "unknown",
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Consumer-side contract resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the contract for a consumer call site.
 *
 * Given `client.getUser(...)`, traces back to the `initClient(contract, ...)`
 * call to find the contract, then extracts the endpoint definition for the
 * matched method name (e.g. "getUser").
 */
export function readContractForClientCall(
  callExpression: Node,
  methodName: string,
  pattern: ContractPattern,
): ContractReadResult | null {
  // Walk from client.getUser() → client → find the variable declaration
  const callee = Node.isCallExpression(callExpression)
    ? callExpression.getExpression()
    : null;
  if (callee === null || !Node.isPropertyAccessExpression(callee)) {
    return null;
  }

  const clientIdentifier = callee.getExpression();
  if (!Node.isIdentifier(clientIdentifier)) {
    return null;
  }

  const symbol = clientIdentifier.getSymbol();
  if (symbol === undefined) {
    return null;
  }

  const decls = symbol.getDeclarations();
  if (decls.length === 0) {
    return null;
  }

  const decl = decls[0];
  if (!Node.isVariableDeclaration(decl)) {
    return null;
  }

  // The variable init should be initClient(contract, ...) or similar
  const init = decl.getInitializer();
  if (init === undefined || !Node.isCallExpression(init)) {
    return null;
  }

  const args = init.getArguments();
  if (args.length === 0) {
    return null;
  }

  // First arg is the contract reference
  const contractObj = resolveContractObject(args[0]);
  if (contractObj === null || !Node.isObjectLiteralExpression(contractObj)) {
    return null;
  }

  // Find the endpoint for the method name
  for (const prop of contractObj.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) {
      continue;
    }

    if (prop.getName() !== methodName) {
      continue;
    }

    const endpointInit = prop.getInitializer();
    if (endpointInit === undefined) {
      continue;
    }

    return extractEndpointContract(
      endpointInit,
      pattern,
      pattern.discovery.importModule.split("/").pop() ?? "unknown",
    );
  }

  return null;
}
