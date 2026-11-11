/**
 * Which arguments of a call become the key of an environment read down
 * the callee: `requireEnv("TABLE")` passes `TABLE` to the `name` that
 * `process.env[name]` reads. A read through a helper is reported at the
 * call that passes the name, so the helper's own read takes on none of
 * its callers' names.
 *
 * The store works out once for the whole project which parameters end up
 * as a read's key. A helper in a file the store did not read is looked at
 * in its own body instead, which the README beside the Node pack explains.
 */

import { type Identifier, Node, SyntaxKind } from "ts-morph";

import { toFunctionRoot } from "../discovery/shared.js";
import { functionTargetOf, symbolBehind } from "./functionBehind.js";
import { declarationsBehind } from "./unfollowedCall.js";

import type { KeySupplied, RuntimeObject } from "@suss/extractor";
import type {
  CallExpression,
  ElementAccessExpression,
  ParameterDeclaration,
} from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The arguments of the call whose value becomes the key of a read off the
 * object, with each node as the key `keyOf` gives it. Nothing is stated
 * to answer, since the access walk asks this at every call it visits.
 */
export function keysSuppliedAt(
  call: Node,
  object: RuntimeObject,
  resolution: ResolutionStore,
  keyOf: (node: Node) => string,
): readonly KeySupplied[] {
  if (!Node.isCallExpression(call) || object.origin !== "global") {
    return [];
  }
  const callee = helperCalleeOf(call, resolution);
  if (callee === null) {
    return [];
  }
  const namers = resolution.envNamers(callee.getProject());
  const parameters = callee.getParameters();
  return call.getArguments().flatMap((passed, at): KeySupplied[] => {
    const parameter = parameters[at];
    if (parameter === undefined) {
      return [];
    }
    const sites = (
      namers.sitesNaming(parameter) ??
      directEnvReads(callee, parameter, resolution)
    ).filter((site) => object.paths.includes(objectReadAt(site, resolution)));
    if (sites.length === 0) {
      return [];
    }
    return [
      {
        at,
        value: keyOf(passed),
        forwarded: handsOnParameter(passed),
        sites: sites.map(keyOf),
      },
    ];
  });
}

/**
 * The environment object a helper's read site is off: the one its object
 * is spelled as, or for an object the rules followed an environment into,
 * the first the packs declare.
 */
function objectReadAt(site: Node, resolution: ResolutionStore): string {
  const object = Node.isElementAccessExpression(site)
    ? site.getExpression()
    : null;
  return resolution.environmentReadOff(object);
}

/**
 * Whether the argument is the calling function's own parameter, as in
 * `getEnv(key)` calling `requireEnv(key)`. The name comes from whoever
 * calls `getEnv`, and the rules follow it to that call, so the
 * forwarding call records nothing. Settling the parameter here would
 * give the helper its callers' names.
 */
function handsOnParameter(passed: Node): boolean {
  if (!Node.isIdentifier(passed)) {
    return false;
  }
  const declared = symbolBehind(passed)?.getValueDeclaration();
  return declared !== undefined && Node.isParameterDeclaration(declared);
}

/** The function a call resolves to, or null when it cannot be followed. */
export function helperCalleeOf(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): FunctionRoot | null {
  const callee = call.getExpression();
  const nameNode = Node.isPropertyAccessExpression(callee)
    ? callee.getNameNode()
    : callee;
  if (!Node.isIdentifier(nameNode)) {
    return null;
  }
  const declared = functionTargetOf(nameNode)?.func;
  if (declared !== undefined || resolution === undefined) {
    return declared ?? null;
  }
  return factoryReturnedCallee(nameNode, callee, resolution);
}

/**
 * The function returned by `makeReader` in `const requireEnv =
 * makeReader(process.env)`. Store queries are costly, so only a name
 * declared as a call's result is asked about.
 */
function factoryReturnedCallee(
  nameNode: Identifier,
  callee: Node,
  resolution: ResolutionStore,
): FunctionRoot | null {
  if (!isDeclaredAsCall(nameNode)) {
    return null;
  }
  const returned = resolution.resolveReturnedCallable(callee);
  return returned === null ? null : toFunctionRoot(returned);
}

/** True when every declaration of the name sets it to a call's result. */
function isDeclaredAsCall(nameNode: Identifier): boolean {
  const declarations = declarationsBehind(symbolBehind(nameNode));
  return declarations.length > 0 && declarations.every(isVariableSetToCall);
}

function isVariableSetToCall(declaration: Node): boolean {
  if (!Node.isVariableDeclaration(declaration)) {
    return false;
  }
  const initializer = declaration.getInitializer();
  return initializer !== undefined && Node.isCallExpression(initializer);
}

function directEnvReads(
  fn: FunctionRoot,
  parameter: ParameterDeclaration,
  resolution: ResolutionStore,
): Node[] {
  const direct = directEnvRead(fn, parameter, resolution);
  return direct === null ? [] : [direct];
}

/** `process.env[name]` in the function's own body or a closure inside it. */
function directEnvRead(
  fn: FunctionRoot,
  parameter: ParameterDeclaration,
  resolution: ResolutionStore,
): ElementAccessExpression | null {
  for (const access of fn.getDescendantsOfKind(
    SyntaxKind.ElementAccessExpression,
  )) {
    if (resolution.spelledEnvironmentPath(access.getExpression()) === null) {
      continue;
    }
    const argument = access.getArgumentExpression();
    if (
      argument !== undefined &&
      Node.isIdentifier(argument) &&
      symbolBehind(argument)?.getValueDeclaration() === parameter
    ) {
      return access;
    }
  }
  return null;
}
