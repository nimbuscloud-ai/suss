/**
 * graphqlWrapper.ts: a project function that hands its own parameter to
 * one of the library's GraphQL calls, read as one operation per caller.
 *
 * The document argument inside such a wrapper is the wrapper's
 * parameter, which is no operation at all, and the components that do
 * name an operation never reach a library call of their own. The
 * callers come from the facts: the store says which calls filled the
 * parameter and what each of them wrote there. The README beside this
 * file says what that buys and where it stops.
 */

import { Node } from "ts-morph";

import {
  enclosingFunctionRoot,
  functionNameOrAnon,
  type GraphqlOperationType,
  operationInfoFromResolution,
  resolveGraphqlDocument,
  unreadableDocument,
} from "./graphqlShared.js";

import type { CallExpression, ParameterDeclaration } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { DocumentResolution } from "./graphqlShared.js";
import type { DiscoveredUnit } from "./shared.js";

/**
 * How many wrappers deep an expansion follows. Three covers a hook over
 * a hook over the library, which is as far as the layering goes before
 * a project has an abstraction nobody reads either.
 */
const MAX_WRAPPER_DEPTH = 3;

/** How far into a returned expression the result is still the call's. */
const MAX_RETURN_DEPTH = 4;

/** What the caller's units are made of, once a wrapper is recognized. */
export interface WrapperContext {
  kind: string;
  operationType: GraphqlOperationType;
  /** The library call's own name, so the pack reads the caller's result. */
  methodName: string;
  store: ResolutionStore;
}

export interface WrapperExpansion {
  /** One unit per caller the facts could follow. */
  units: DiscoveredUnit[];
  /**
   * Why the wrapper's own unit is still worth emitting, or null when
   * every call of it became a unit of its own.
   */
  unfollowedReason: string | null;
}

/**
 * The callers of the function this document argument belongs to, each
 * read as its own operation. Null when the argument is not a parameter
 * of the function around it, which is every direct call.
 */
export function expandDocumentParameterCallers(
  documentArgument: Node,
  libraryCall: Node,
  context: WrapperContext,
): WrapperExpansion | null {
  const wrapper = enclosingFunctionRoot(libraryCall);
  if (wrapper === null) {
    return null;
  }
  const parameter = parameterBehind(documentArgument, wrapper);
  if (parameter === null) {
    return null;
  }

  const expanded = expandParameter(
    parameter,
    givesBackCall(wrapper, libraryCall),
    0,
    new Set([parameter]),
    context,
  );
  return {
    units: expanded.units,
    unfollowedReason:
      expanded.unfollowed === 0
        ? null
        : unfollowedReason(expanded.units.length, expanded.unfollowed),
  };
}

/**
 * What to report for the wrapper itself. `wrapperReason` is set when
 * the document is the wrapper's parameter and some caller could not be
 * followed, and it says what happened instead of the generic gap.
 */
export function documentBehindWrapper(
  value: Node,
  store: ResolutionStore | undefined,
  wrapperReason: string | undefined,
): DocumentResolution {
  if (wrapperReason !== undefined) {
    return unreadableDocument(value, wrapperReason);
  }
  return resolveGraphqlDocument(value, store) ?? unreadableDocument(value);
}

interface ExpandedCallers {
  units: DiscoveredUnit[];
  /** Calls that reached no unit, and calls nobody found. */
  unfollowed: number;
}

function expandParameter(
  parameter: ParameterDeclaration,
  forwardsResult: boolean,
  depth: number,
  expanded: ReadonlySet<ParameterDeclaration>,
  context: WrapperContext,
): ExpandedCallers {
  const passed = context.store.argumentsPassedTo(parameter);
  if (passed.length === 0) {
    return { units: [], unfollowed: 1 };
  }

  const units: DiscoveredUnit[] = [];
  let unfollowed = 0;
  for (const { call, argument } of passed) {
    const caller = enclosingFunctionRoot(call);
    if (caller === null || !Node.isCallExpression(call)) {
      unfollowed++;
      continue;
    }
    const nested = parameterBehind(argument, caller);
    if (nested !== null) {
      const deeper = expandNested(
        nested,
        forwardsResult && givesBackCall(caller, call),
        depth,
        expanded,
        context,
      );
      units.push(...deeper.units);
      unfollowed += deeper.unfollowed;
      continue;
    }
    const unit = callerUnit(caller, call, argument, forwardsResult, context);
    if (unit === null) {
      unfollowed++;
      continue;
    }
    units.push(unit);
  }
  return { units, unfollowed };
}

/** The caller is a wrapper too, so its own callers are the operations. */
function expandNested(
  parameter: ParameterDeclaration,
  forwardsResult: boolean,
  depth: number,
  expanded: ReadonlySet<ParameterDeclaration>,
  context: WrapperContext,
): ExpandedCallers {
  if (depth + 1 >= MAX_WRAPPER_DEPTH || expanded.has(parameter)) {
    return { units: [], unfollowed: 1 };
  }
  return expandParameter(
    parameter,
    forwardsResult,
    depth + 1,
    new Set([...expanded, parameter]),
    context,
  );
}

function callerUnit(
  caller: FunctionRoot,
  call: CallExpression,
  argument: Node,
  forwardsResult: boolean,
  context: WrapperContext,
): DiscoveredUnit | null {
  const document =
    resolveGraphqlDocument(argument, context.store) ??
    unreadableDocument(argument);
  const operationInfo = operationInfoFromResolution(
    document,
    context.operationType,
  );
  if (operationInfo === null) {
    return null;
  }
  const nameToken =
    operationInfo.operationName ??
    operationInfo.unresolved?.reference ??
    `<anon-${operationInfo.operationType}>`;
  return {
    func: caller,
    kind: context.kind,
    name: `${functionNameOrAnon(caller)}.${nameToken}`,
    // A wrapper handing back something of its own leaves the caller
    // none of the library's result to read.
    ...(forwardsResult
      ? { callSite: { callExpression: call, methodName: context.methodName } }
      : {}),
    operationInfo,
  };
}

function unfollowedReason(followed: number, unfollowed: number): string {
  if (followed === 0) {
    return "the document argument is this function's parameter, and no call of the function was found in the files read";
  }
  return `the document argument is this function's parameter: ${followed} of its callers were read as operations of their own, and ${unfollowed} could not be followed`;
}

/**
 * The parameter of `func` this value is written as, or null when it is
 * anything else. A cast or a parenthesis in front of the name is peeled
 * off first, the way the document resolvers peel one.
 */
function parameterBehind(
  value: Node,
  func: FunctionRoot,
): ParameterDeclaration | null {
  const name = stripCasts(value);
  if (!Node.isIdentifier(name)) {
    return null;
  }
  for (const declaration of name.getSymbol()?.getDeclarations() ?? []) {
    if (
      Node.isParameterDeclaration(declaration) &&
      declaration.getParent() === func
    ) {
      return declaration;
    }
  }
  return null;
}

function stripCasts(node: Node): Node {
  let current = node;
  while (
    Node.isAsExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/**
 * Whether running `func` hands back what `call` returned: the call
 * itself, a name the call was written into, or a call given the result.
 * A wrapper that returns something of its own is still one operation
 * per caller, but the caller reads its result rather than the library's.
 */
function givesBackCall(func: FunctionRoot, call: Node): boolean {
  return returnedExpressions(func).some((returned) =>
    leadsToCall(returned, call, func, 0),
  );
}

function returnedExpressions(func: FunctionRoot): Node[] {
  const returned: Node[] = [];
  const body = func.getBody();
  if (body !== undefined && !Node.isBlock(body)) {
    returned.push(body);
  }
  func.forEachDescendant((node) => {
    if (!Node.isReturnStatement(node)) {
      return;
    }
    const expression = node.getExpression();
    if (expression !== undefined && enclosingFunctionRoot(node) === func) {
      returned.push(expression);
    }
  });
  return returned;
}

function leadsToCall(
  expression: Node,
  call: Node,
  func: FunctionRoot,
  depth: number,
): boolean {
  if (depth > MAX_RETURN_DEPTH) {
    return false;
  }
  const value = stripReturnWrappers(expression);
  if (value === call) {
    return true;
  }
  if (Node.isIdentifier(value)) {
    return declaredValuesIn(value, func).some((written) =>
      leadsToCall(written, call, func, depth + 1),
    );
  }
  if (Node.isCallExpression(value)) {
    return value
      .getArguments()
      .some((argument) => leadsToCall(argument, call, func, depth + 1));
  }
  return false;
}

/** What a name inside this function was declared as. */
function declaredValuesIn(name: Node, func: FunctionRoot): Node[] {
  const written: Node[] = [];
  for (const declaration of name.getSymbol()?.getDeclarations() ?? []) {
    if (
      !Node.isVariableDeclaration(declaration) ||
      enclosingFunctionRoot(declaration) !== func
    ) {
      continue;
    }
    const initializer = declaration.getInitializer();
    if (initializer !== undefined) {
      written.push(initializer);
    }
  }
  return written;
}

function stripReturnWrappers(node: Node): Node {
  let current = stripCasts(node);
  while (Node.isAwaitExpression(current)) {
    current = stripCasts(current.getExpression());
  }
  return current;
}
