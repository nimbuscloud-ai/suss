/**
 * What a value at a discovery site turns out to be, whether it was
 * written out there or referred to by name.
 *
 * A recognizer reading an argument, a property or a loop's iterable is
 * asking one of two things: which function is this, and which object is
 * this. The resolution store settles both over the fact layer, which
 * follows a name through a property read, an array element, an alias, an
 * import and a barrel. A recognizer that reads the syntax at the
 * position instead sees an identifier and gets no further.
 */

import { Node } from "ts-morph";

import { force, literalOf } from "@suss/values";

import { factKeyOf } from "../facts/extract.js";
import { evaluatedValue } from "../values/evaluator.js";
import { toFunctionRoot } from "./shared.js";

import type {
  ArrayLiteralExpression,
  CallExpression,
  ObjectLiteralElementLike,
  ObjectLiteralExpression,
} from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * Whether a value is a name rather than something written out where it
 * is used. A route's path argument is a string, and asking the fact
 * layer about that pulls in the file's import closure to produce a null
 * that was never in doubt.
 */
export function couldNameAValue(value: Node): boolean {
  return (
    Node.isIdentifier(value) ||
    Node.isPropertyAccessExpression(value) ||
    Node.isElementAccessExpression(value) ||
    Node.isCallExpression(value)
  );
}

/**
 * The expression a property of an object literal is set to, when it has
 * one. A shorthand property is set to whatever its name refers to, so
 * the name node is the expression.
 */
export function propertyValueOf(property: Node): Node | null {
  if (Node.isPropertyAssignment(property)) {
    return property.getInitializer() ?? null;
  }
  if (Node.isShorthandPropertyAssignment(property)) {
    return property.getNameNode();
  }
  return null;
}

/**
 * The function this value is, whether it was written out here or
 * referred to by name.
 *
 * A value the rules can reach two different functions from returns null,
 * because picking one would report a boundary's behaviour from a
 * function that may not be the one that runs. So does a handler that
 * arrives as a parameter, which nothing here can follow.
 */
export function functionValueOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): FunctionRoot | null {
  const written = factKeyOf(value);
  const here = toFunctionRoot(written);
  if (here !== null) {
    return here;
  }
  if (resolution === undefined || !couldNameAValue(written)) {
    return null;
  }
  const resolved = resolution.resolveCallable(written);
  if (resolved !== null) {
    return toFunctionRoot(resolved);
  }
  if (!Node.isCallExpression(written)) {
    return null;
  }
  // Asked as a name first so a pack's unwrapping answer wins; only then
  // as a factory, `requireCaller(config)` being what requireCaller returns.
  const returned = resolution.resolveReturnedCallable(written);
  return returned === null ? null : toFunctionRoot(returned);
}

/** The object literal this value is, written out here or named. */
export function objectLiteralOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): ObjectLiteralExpression | null {
  return literalValueOf(
    value,
    resolution,
    (node): node is ObjectLiteralExpression =>
      Node.isObjectLiteralExpression(node),
  );
}

/**
 * The properties of an object literal, with a spread replaced by the
 * properties of whatever it spreads.
 *
 * A spread is a name in property position, so it is the same question
 * `objectLiteralOf` settles. A spread of something the rules cannot
 * reach an object from contributes nothing, the same as a property whose
 * value nothing resolves. An object that spreads its way back to itself
 * is walked once.
 */
export function propertiesOf(
  object: ObjectLiteralExpression,
  resolution: ResolutionStore | undefined,
): ObjectLiteralElementLike[] {
  return propertiesReached(object, resolution, new Set());
}

function propertiesReached(
  object: ObjectLiteralExpression,
  resolution: ResolutionStore | undefined,
  seen: Set<ObjectLiteralExpression>,
): ObjectLiteralElementLike[] {
  if (seen.has(object)) {
    return [];
  }
  seen.add(object);

  return object.getProperties().flatMap((property) => {
    if (!Node.isSpreadAssignment(property)) {
      return [property];
    }
    const spread = objectLiteralOf(property.getExpression(), resolution);
    return spread === null ? [] : propertiesReached(spread, resolution, seen);
  });
}

/**
 * The expression `value` comes down to, whatever kind of expression that
 * turns out to be, whether it was a name or written out where it is
 * used. A mount call's target argument is sometimes a call or `new`
 * expression right there (`app.use("/x", Router())`) and sometimes a
 * name imported from wherever the sub-router is declared. A caller
 * comparing that against another value's creation site does not care
 * which.
 */
export function writtenNodeOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): Node | null {
  const written = factKeyOf(value);
  if (Node.isNewExpression(written)) {
    return written;
  }
  if (Node.isCallExpression(written)) {
    return writtenThroughCall(written, resolution);
  }
  if (resolution === undefined || !couldNameAValue(written)) {
    return null;
  }
  const resolved = resolution.resolveWrittenValue(written);
  return resolved !== null && Node.isCallExpression(resolved)
    ? writtenThroughCall(resolved, resolution)
    : resolved;
}

/**
 * A call's own construction, or what its callee's return value is
 * written as when the callee is a project function. A name bound to
 * `client()` and `client()` itself both land here, so a wrapper called
 * through a variable resolves the same way as one called directly.
 */
function writtenThroughCall(
  call: CallExpression,
  resolution: ResolutionStore | undefined,
): Node {
  if (
    resolution !== undefined &&
    resolution.resolveCallable(call.getExpression()) !== null
  ) {
    const resolved = resolution.resolveWrittenValue(call);
    if (resolved !== null) {
      return resolved;
    }
  }
  return call;
}

/**
 * The string this value comes to, with every name the evaluator can
 * follow folded in. Null rather than the empty string when the value
 * does not settle to one string, so a caller can tell "stated as
 * empty" from "could not read" (#123).
 */
export function stringValueOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  return literalOf(evaluatedValue(value, resolution));
}

/**
 * The string a named property of an object is set to, with the object
 * and the value each read through whatever name they were given.
 * `fetch(url, { method })`, `fetch(url, opts)` and `{ ...base, method }`
 * are all read here. Null when the property is absent or not a string.
 */
export function stringPropertyOf(
  object: Node,
  name: string,
  resolution: ResolutionStore | undefined,
): string | null {
  const record = evaluatedValue(object, resolution);
  if (record.kind !== "record") {
    return null;
  }
  const field = record.fields.get(name);
  return field === undefined ? null : literalOf(force(field.value));
}

/** The array literal this value is, written out here or named. */
export function arrayLiteralOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): ArrayLiteralExpression | null {
  return literalValueOf(
    value,
    resolution,
    (node): node is ArrayLiteralExpression =>
      Node.isArrayLiteralExpression(node),
  );
}

function literalValueOf<T extends Node>(
  value: Node,
  resolution: ResolutionStore | undefined,
  isWanted: (node: Node) => node is T,
): T | null {
  const written = factKeyOf(value);
  if (isWanted(written)) {
    return written;
  }
  if (resolution === undefined || !couldNameAValue(written)) {
    return null;
  }
  const resolved = resolution.resolveObject(written);
  return resolved !== null && isWanted(resolved) ? resolved : null;
}
