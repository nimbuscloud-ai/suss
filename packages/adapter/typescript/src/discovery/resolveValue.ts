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

import { factKeyOf } from "../facts/extract.js";
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
  return resolved === null ? null : toFunctionRoot(resolved);
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
 * The string this value is, written out here or named. Null rather
 * than the empty string when nothing resolves, so a caller can tell
 * "stated as empty" from "could not read" (#123).
 */
export function stringValueOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): string | null {
  const written = factKeyOf(value);
  if (isStringNode(written)) {
    return written.getLiteralValue();
  }
  if (resolution === undefined || !couldNameAValue(written)) {
    return null;
  }
  const resolved = resolution.resolveWrittenValue(written);
  return resolved !== null && isStringNode(resolved)
    ? resolved.getLiteralValue()
    : null;
}

function isStringNode(
  node: Node,
): node is Node & { getLiteralValue(): string } {
  return (
    Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)
  );
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
