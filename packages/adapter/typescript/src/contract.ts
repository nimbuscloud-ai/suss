// contract.ts — Contract reading for ts-rest style frameworks (Task 2.5b)
//
// Given a DiscoveredUnit that was registered via s.router(contract, { handlers }),
// trace back to the contract definition and extract declared responses.

import { Node } from "ts-morph";

import type { ContractPattern, RawDeclaredContract } from "@suss/extractor";
import type { DiscoveredUnit } from "./discovery.js";

// ---------------------------------------------------------------------------
// Result type — includes both contract data and extracted binding
// ---------------------------------------------------------------------------

export interface ContractReadResult {
  declaredContract: RawDeclaredContract;
  boundaryBinding: {
    protocol: string;
    method?: string;
    path?: string;
    framework: string;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const current: Node = func;

  // Walk up to the PropertyAssignment or MethodDeclaration
  const parent = current.getParent();
  if (parent === undefined) {
    return null;
  }

  let propNode: Node;
  if (Node.isPropertyAssignment(parent)) {
    propNode = parent;
  } else if (Node.isMethodDeclaration(func)) {
    propNode = func;
  } else {
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
 * Given a contract reference node (an Identifier or expression), resolve it
 * to the object literal that defines the contract routes.
 *
 * Expected shapes:
 *   - Identifier → follows symbol to VariableDeclaration → initializer is c.router({ ... })
 *   - Inline object literal (unlikely but handle it)
 */
function resolveContractObject(contractArg: Node): Node | null {
  // If it's already an object literal, return it
  if (Node.isObjectLiteralExpression(contractArg)) {
    return contractArg;
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

          responses.push({ statusCode });
        }
      }
    }
  }

  if (responses.length === 0) {
    return null;
  }

  const boundaryBinding: {
    protocol: string;
    method?: string;
    path?: string;
    framework: string;
  } | null =
    method !== undefined || path !== undefined
      ? {
          protocol: "http",
          ...(method !== undefined ? { method } : {}),
          ...(path !== undefined ? { path } : {}),
          framework,
        }
      : null;

  return { declaredContract: { framework, responses }, boundaryBinding };
}

// ---------------------------------------------------------------------------
// Main exported function
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
