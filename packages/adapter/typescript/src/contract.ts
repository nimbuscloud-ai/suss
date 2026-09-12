// contract.ts: Contract reading for ts-rest style frameworks (Task 2.5b)
//
// Given a DiscoveredUnit that was registered via s.router(contract, { handlers }),
// trace back to the contract definition and extract declared responses.

import { Node } from "ts-morph";

import { restBinding } from "@suss/behavioral-ir";

import {
  objectLiteralOf,
  propertiesOf,
  propertyNameOf,
  propertyValueOf,
  stringPropertyOf,
  writtenNodeOf,
} from "./discovery/resolveValue.js";
import { shapeFromNodeType } from "./shapes/typeShapes.js";
import { peelSyntax } from "./walk/unwrap.js";

import type { BoundaryBinding, TypeShape } from "@suss/behavioral-ir";
import type { ContractPattern, RawDeclaredContract } from "@suss/extractor";
import type { ObjectLiteralExpression } from "ts-morph";
import type { DiscoveredUnit } from "./discovery/index.js";
import type { ResolutionStore } from "./facts/store.js";

// ---------------------------------------------------------------------------
// Result type: includes both contract data and extracted binding
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
 * forms (zod schemas, raw references, missing type arguments): the contract
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
  const propNode = func === null ? null : resolveHandlerPropNode(func);
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
 * The object literal a contract reference comes down to: the routes of a
 * whole contract, or the definition of one endpoint.
 *
 * A contract is written as `c.router({ ... })`, bound to a name, exported,
 * imported, and composed into a parent contract, so a registration site
 * is hardly ever given the literal itself. The resolution store
 * settles the name, the property read, the import and the barrel; the only
 * step left is taking off the `router(...)` call, which is the part
 * ts-rest and zod-openapi know about and the store does not.
 */
function contractObjectOf(
  contractValue: Node,
  resolution: ResolutionStore | undefined,
): ObjectLiteralExpression | null {
  return contractObjectReached(contractValue, resolution, new Set());
}

function contractObjectReached(
  contractValue: Node,
  resolution: ResolutionStore | undefined,
  seen: Set<Node>,
): ObjectLiteralExpression | null {
  if (seen.has(contractValue)) {
    return null;
  }
  seen.add(contractValue);

  // A contract written out at the registration site needs no name
  // settled, and asking anyway costs a query per route.
  const here = peelSyntax(contractValue);
  if (Node.isObjectLiteralExpression(here) || Node.isCallExpression(here)) {
    return unwrapContractInit(here, resolution);
  }

  const literal = objectLiteralOf(here, resolution);
  if (literal !== null) {
    return literal;
  }
  const written = writtenNodeOf(here, resolution);
  if (written !== null) {
    return unwrapContractInit(written, resolution);
  }
  return subContractOf(here, resolution, seen);
}

/**
 * A sub-contract read off a parent, `apiContract.internal`. The store
 * settles the parent to the `router(...)` call it is written as and
 * stops there, because only a contract-reading pack knows that call
 * gives back the routes it was passed. Take the call off first, and the
 * property read is an ordinary one.
 */
function subContractOf(
  read: Node,
  resolution: ResolutionStore | undefined,
  seen: Set<Node>,
): ObjectLiteralExpression | null {
  if (!Node.isPropertyAccessExpression(read)) {
    return null;
  }
  const parent = contractObjectReached(read.getExpression(), resolution, seen);
  if (parent === null) {
    return null;
  }
  const sub = declaredUnder(parent, read.getName(), resolution);
  return sub === null ? null : contractObjectReached(sub, resolution, seen);
}

/**
 * The routes object inside a contract initializer, `c.router({ ... })` or
 * `createRoute({ ... })`. A contract written straight out, with no call
 * around it, is its own initializer.
 */
function unwrapContractInit(
  init: Node,
  resolution: ResolutionStore | undefined,
): ObjectLiteralExpression | null {
  // `{ ... } as const` and `route as RouteConfig` both leave the object
  // as written; the cast is only there for the type.
  const node = peelSyntax(init);
  if (!Node.isCallExpression(node)) {
    return objectLiteralOf(node, resolution);
  }
  const routes = node.getArguments()[0];
  return routes === undefined ? null : objectLiteralOf(routes, resolution);
}

/**
 * What a contract object declares under `name`: an endpoint on a routes
 * object, or a sub-contract on a composed one.
 */
function declaredUnder(
  object: ObjectLiteralExpression,
  name: string,
  resolution: ResolutionStore | undefined,
): Node | null {
  for (const property of propertiesOf(object, resolution)) {
    if (propertyNameOf(property) === name) {
      return propertyValueOf(property);
    }
  }
  return null;
}

/**
 * The statuses an endpoint declares, with the body shape of each one the
 * shape extractor can read. A status the endpoint spreads in from a
 * shared object counts the same as one written out here.
 */
function declaredResponsesOf(
  endpoint: ObjectLiteralExpression,
  pattern: ContractPattern,
  resolution: ResolutionStore | undefined,
): RawDeclaredContract["responses"] {
  const responses: RawDeclaredContract["responses"] = [];

  for (const property of propertiesOf(endpoint, resolution)) {
    if (propertyNameOf(property) !== pattern.responseExtraction.property) {
      continue;
    }
    const value = propertyValueOf(property);
    const declared = value === null ? null : objectLiteralOf(value, resolution);
    if (declared === null) {
      continue;
    }

    for (const status of propertiesOf(declared, resolution)) {
      const name = propertyNameOf(status);
      if (name === null) {
        continue;
      }
      const statusCode = Number(name);
      if (!Number.isFinite(statusCode)) {
        continue;
      }
      const body = extractDeclaredBody(propertyValueOf(status) ?? undefined);
      responses.push(body !== null ? { statusCode, body } : { statusCode });
    }
  }

  return responses;
}

/**
 * The contract one endpoint declares: its statuses, and the method and
 * path its binding comes from.
 *
 * ```
 * getUser: { method: "GET", path: "/users/:id", responses: { 200: c.type<...>() } }
 * ```
 */
function extractEndpointContract(
  endpointValue: Node,
  pattern: ContractPattern,
  framework: string,
  resolution: ResolutionStore | undefined,
): ContractReadResult | null {
  const endpoint = contractObjectOf(endpointValue, resolution);
  if (endpoint === null) {
    return null;
  }

  const responses = declaredResponsesOf(endpoint, pattern, resolution);
  if (responses.length === 0) {
    return null;
  }

  const method = stringPropertyOf(endpoint, pattern.methodProperty, resolution);
  const path = stringPropertyOf(endpoint, pattern.pathProperty, resolution);

  const boundaryBinding: BoundaryBinding | null =
    method !== null || path !== null
      ? restBinding({
          transport: "http",
          method,
          path,
          recognition: framework,
        })
      : null;

  // Contract-reading packs (ts-rest, ts-rest clients) read a contract
  // that is authored *separately* from the handler implementation the
  // same summary's transitions come from. That makes them "independent"
  // observations: comparing transitions against this contract is
  // meaningful (the implementation can drift from the declaration).
  return {
    declaredContract: { framework, responses, provenance: "independent" },
    boundaryBinding,
  };
}

// ---------------------------------------------------------------------------
// Main exported function: provider side
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
  framework: string,
  resolution?: ResolutionStore,
): ContractReadResult | null {
  if (pattern.endpoint?.from === "registrationArgument") {
    const endpointNode = endpointFromRegistrationArgument(
      unit,
      pattern.endpoint.position,
      resolution,
    );
    if (endpointNode === null) {
      return null;
    }
    return extractEndpointContract(
      endpointNode,
      pattern,
      framework,
      resolution,
    );
  }

  const routerInfo = findRouterCall(unit);
  if (routerInfo === null) {
    return null;
  }

  const routes = contractObjectOf(routerInfo.contractArg, resolution);
  if (routes === null) {
    return null;
  }

  const endpoint = declaredUnder(routes, routerInfo.handlerName, resolution);
  if (endpoint === null) {
    return null;
  }

  return extractEndpointContract(endpoint, pattern, framework, resolution);
}

/**
 * The zod-openapi shape: `app.openapi(route, handler)`. The endpoint's
 * contract is the handler's sibling argument, usually a
 * `createRoute({...})` call, a variable bound to one, or a property on
 * a shared contract object, possibly behind a cast.
 */
function endpointFromRegistrationArgument(
  unit: DiscoveredUnit,
  position: number,
  resolution?: ResolutionStore,
): Node | null {
  const func = unit.func;
  if (func === null) {
    return null;
  }
  const call = func.getParent();
  if (call === undefined || !Node.isCallExpression(call)) {
    return null;
  }
  const args = call.getArguments();
  if (!args.includes(func)) {
    return null;
  }
  const arg = args[position];
  if (arg === undefined || arg === func) {
    return null;
  }

  return contractObjectOf(arg, resolution);
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
  framework: string,
  resolution?: ResolutionStore,
): ContractReadResult | null {
  // Walk from client.getUser() back to the client the call is made on.
  const callee = Node.isCallExpression(callExpression)
    ? callExpression.getExpression()
    : null;
  if (callee === null || !Node.isPropertyAccessExpression(callee)) {
    return null;
  }

  // The client is written as initClient(contract, ...), here or in
  // whichever module the project set it up in.
  const client = writtenNodeOf(callee.getExpression(), resolution);
  if (client === null || !Node.isCallExpression(client)) {
    return null;
  }

  const contractArg = client.getArguments()[0];
  if (contractArg === undefined) {
    return null;
  }

  const routes = contractObjectOf(contractArg, resolution);
  if (routes === null) {
    return null;
  }

  const endpoint = declaredUnder(routes, methodName, resolution);
  if (endpoint === null) {
    return null;
  }

  return extractEndpointContract(endpoint, pattern, framework, resolution);
}
