/**
 * wrappedExport.ts, the handler a route export runs when the export is
 * written as a call.
 *
 * A file convention takes every export it looks for as a handler, so
 * `export const POST = withWorkspace(async (ctx) => { ... })` serves POST
 * with whatever `withWorkspace` hands back, and the function it was given
 * runs inside that. The function is the part written for this route
 * alone, so it becomes the unit. What runs around it is recorded as
 * layers on the unit: the closure a project factory hands back, which is
 * summarized and folded into the route, and any wrapper the run has no
 * body for, such as one a library factory built. The README beside this
 * file walks through the cases.
 */

import { Node } from "ts-morph";

import { factKeyOf } from "../facts/extract.js";
import { enclosingParameterReads } from "../parameterReads.js";
import { isInExternalCode } from "../resolve/unfollowedCall.js";
import { returnPositionOf } from "../terminals/shared.js";
import { functionNameOrAnon } from "./graphqlShared.js";
import { specifierImportedAs } from "./importScan.js";
import { functionValuesOf } from "./resolveValue.js";
import { findEnclosingFunction, toFunctionRoot } from "./shared.js";

import type { WrapperReference } from "@suss/behavioral-ir";
import type { CallExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";
import type { DiscoveredUnit } from "./shared.js";

export interface WrappedExport {
  /** The function the call was given, which runs inside every layer. */
  handler: FunctionRoot;
  /** What runs around the handler, outermost first. */
  layers: WrapperReference[];
  /** The layer the run can read, as a unit of its own to summarize. */
  closure?: DiscoveredUnit;
}

/** A function passed to a call, and the position it was passed at. */
interface Given {
  func: FunctionRoot;
  position: number;
}

/**
 * The handler inside an export written as `wrapper(fn)`, with the layers
 * around it. Null when the call is given no function, or when it goes
 * through a project factory whose result this module cannot place, which
 * leaves the export to the store's own answer.
 */
export function wrappedExportOf(
  value: Node,
  kind: string,
  resolution: ResolutionStore,
): WrappedExport | null {
  const call = callWrittenAt(value, resolution);
  if (call === null) {
    return null;
  }
  const given = functionGivenTo(call, resolution);
  if (given === null) {
    return null;
  }

  const callee = call.getExpression();
  const factory = functionOrNull(resolution.resolveCalledFunction(callee));
  if (factory === null) {
    return { handler: given.func, layers: [unreadLayer(callee, resolution)] };
  }
  return layersInside(factory, given, kind, resolution);
}

/**
 * The layers a project factory puts around the function it was given.
 * It hands back a closure of its own, or what a wrapper the run cannot
 * read makes of one, `withAxiom(async (req) => ...)`.
 */
function layersInside(
  factory: FunctionRoot,
  given: Given,
  kind: string,
  resolution: ResolutionStore,
): WrappedExport | null {
  // The facts list a shorthand body's nested returns under the factory
  // too, and only the factory's own return says what it hands back.
  const handedBack = resolution
    .returnedValuesOf(factory)
    .filter((value) => findEnclosingFunction(value) === factory);
  const only = handedBack.length === 1 ? handedBack[0] : undefined;
  if (only === undefined) {
    return null;
  }

  const returned = factKeyOf(only);
  const closure = toFunctionRoot(returned);
  if (closure !== null) {
    const layer = closureLayer(
      factory,
      closure,
      given.position,
      kind,
      resolution,
    );
    return layer === null
      ? null
      : {
          handler: given.func,
          layers: [layer.reference],
          ...(layer.unit === undefined ? {} : { closure: layer.unit }),
        };
  }

  if (!Node.isCallExpression(returned)) {
    return null;
  }
  const outer = returned.getExpression();
  if (resolution.resolveCalledFunction(outer) !== null) {
    return null;
  }
  const inner = functionGivenTo(returned, resolution);
  const layer =
    inner === null
      ? null
      : closureLayer(factory, inner.func, given.position, kind, resolution);
  if (layer === null) {
    return { handler: given.func, layers: [unreadLayer(outer, resolution)] };
  }
  return {
    handler: given.func,
    layers: [unreadLayer(outer, resolution), layer.reference],
    ...(layer.unit === undefined ? {} : { closure: layer.unit }),
  };
}

/**
 * The closure a factory runs around the function at `position`, when it
 * is written inside the factory and calls that parameter. The call is
 * where the handler runs, so the unit reads it as its continuation.
 *
 * One that keeps going after the handler returns, or reads the factory's
 * other parameters, gets no unit, and the README says why.
 */
function closureLayer(
  factory: FunctionRoot,
  closure: FunctionRoot,
  position: number,
  kind: string,
  resolution: ResolutionStore,
): { reference: WrapperReference; unit?: DiscoveredUnit } | null {
  const parameter = factory.getParameters()[position];
  if (parameter === undefined || findEnclosingFunction(closure) !== factory) {
    return null;
  }
  const handsOn = resolution
    .callsThrough(parameter)
    .filter((call) => isWithin(call, closure));
  if (handsOn.length === 0) {
    return null;
  }

  // The factory has a summary of its own under its name, so the closure
  // goes by what calling the factory writes.
  const name = `${functionNameOrAnon(factory)}(${parameter.getName()})`;
  const reference = { file: closure.getSourceFile().getFilePath(), name };
  const options = factory
    .getParameters()
    .filter((_, at) => at !== position)
    .flatMap((one) => namesBoundBy(one.getNameNode()));
  if (
    !handsOn.every((call) => returnedBy(call, closure)) ||
    enclosingParameterReads(closure, factory, options).length > 0
  ) {
    return { reference };
  }
  return {
    reference,
    unit: {
      func: closure,
      kind,
      name,
      nameKind: "label",
      factoryContinuation: position,
    },
  };
}

/** The names a parameter declares, each one a destructuring pattern takes apart included. */
function namesBoundBy(name: Node): string[] {
  if (Node.isIdentifier(name)) {
    return [name.getText()];
  }
  if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
    return name
      .getElements()
      .flatMap((element) =>
        Node.isBindingElement(element)
          ? namesBoundBy(element.getNameNode())
          : [],
      );
  }
  return [];
}

/** Whether `func` itself returns the call's result, so nothing of `func` runs after it. */
function returnedBy(call: Node, func: FunctionRoot): boolean {
  return (
    findEnclosingFunction(call) === func && returnPositionOf(call) !== null
  );
}

/**
 * The call an export is written as: at the export, on the declaration a
 * re-export lists, or behind another export's name, `export const PUT =
 * PATCH`.
 */
function callWrittenAt(
  value: Node,
  resolution: ResolutionStore,
): CallExpression | null {
  const asked = Node.isVariableDeclaration(value) ? value.getNameNode() : value;
  const key = factKeyOf(asked);
  if (Node.isCallExpression(key)) {
    return key;
  }
  if (!Node.isIdentifier(key)) {
    return null;
  }
  const behind = resolution.resolveWrittenValue(key);
  return behind !== null && Node.isCallExpression(behind) ? behind : null;
}

/** The first argument that is a function, written there or named. */
function functionGivenTo(
  call: CallExpression,
  resolution: ResolutionStore,
): Given | null {
  const args = call.getArguments();
  const functions = functionValuesOf(args, resolution);
  for (const [position, arg] of args.entries()) {
    const func = functions.get(arg);
    if (func !== null && func !== undefined) {
      return { func, position };
    }
  }
  return null;
}

/**
 * A wrapper the run has no body for, with the file or module a reader
 * can find it in. No summary in the run goes by this file and name,
 * which is how the checker knows the layer was not read.
 */
function unreadLayer(
  callee: Node,
  resolution: ResolutionStore,
): WrapperReference {
  // `withRateLimit(options)(handler)` is the wrapper `withRateLimit` makes.
  const written = Node.isCallExpression(callee)
    ? callee.getExpression()
    : callee;
  const name = Node.isPropertyAccessExpression(written)
    ? written.getName()
    : written.getText();
  return { file: declaredIn(written, resolution), name };
}

/**
 * The project file a wrapper is written in, or the module it is
 * imported from when the run has no source for it.
 */
function declaredIn(written: Node, resolution: ResolutionStore): string {
  const behind = resolution.resolveWrittenValue(written);
  if (behind !== null && !isInExternalCode(behind.getSourceFile())) {
    return behind.getSourceFile().getFilePath();
  }
  const sourceFile = written.getSourceFile();
  return (
    specifierImportedAs(sourceFile, leftmostName(written)) ??
    sourceFile.getFilePath()
  );
}

/** `Sentry` in `Sentry.wrapRouteHandler`, the name an import binds. */
function leftmostName(written: Node): string {
  if (Node.isPropertyAccessExpression(written)) {
    return leftmostName(written.getExpression());
  }
  return written.getText();
}

function functionOrNull(node: Node | null): FunctionRoot | null {
  return node === null ? null : toFunctionRoot(node);
}

function isWithin(node: Node, container: Node): boolean {
  return (
    node.getSourceFile() === container.getSourceFile() &&
    node.getStart() >= container.getStart() &&
    node.getEnd() <= container.getEnd()
  );
}
