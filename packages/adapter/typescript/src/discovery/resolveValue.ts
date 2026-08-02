// resolveValue.ts — what a value written at a discovery site turns out
// to be, whether it was written out there or named.
//
// A recognizer reading an argument, a property or a loop's iterable is
// asking one of two questions: which function is this, and which object
// is this. The resolution store answers both over the fact layer, which
// follows a name through a property read, an array element, an alias,
// an import and a barrel. A recognizer that reads the syntax sitting at
// the position instead sees an identifier and stops there.

import { Node } from "ts-morph";

import { factKeyOf } from "../facts/extract.js";
import { toFunctionRoot } from "./shared.js";

import type { ArrayLiteralExpression, ObjectLiteralExpression } from "ts-morph";
import type { FunctionRoot } from "../conditions.js";
import type { ResolutionStore } from "../facts/store.js";

/**
 * Whether a value is written as a name rather than written out where it
 * is used. A route's path argument is a string, and asking the fact
 * layer about that pulls in the file's import closure for an answer
 * that was always going to be null.
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
 * The expression a property of an object literal holds, when it holds
 * one. A shorthand holds whatever its name refers to, which is what the
 * name node stands for.
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
 * The function this value is, whether it was written out here or named.
 *
 * A value the rules reach two different functions from answers null,
 * because picking one would report a boundary's behaviour from a
 * function that may not be the one that runs. So does a handler that
 * arrives as a parameter, which no chain reaches from here.
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

/** The object literal this value is, whether written out here or named. */
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

/** The array literal this value is, whether written out here or named. */
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
