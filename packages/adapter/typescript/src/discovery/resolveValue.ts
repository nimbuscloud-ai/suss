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

import { constantOf, force, literalOf, literalsOf } from "@suss/values";

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
  return functionValuesOf([value], resolution).get(value) ?? null;
}

/**
 * `functionValueOf` for several values, asked of the store as one
 * question, which costs one derivation rather than one per value.
 */
export function functionValuesOf(
  values: readonly Node[],
  resolution: ResolutionStore | undefined,
): Map<Node, FunctionRoot | null> {
  const found = new Map<Node, FunctionRoot | null>();
  const asked: Node[] = [];
  for (const value of values) {
    const written = factKeyOf(value);
    const here = toFunctionRoot(written);
    if (
      here !== null ||
      resolution === undefined ||
      !couldNameAValue(written)
    ) {
      found.set(value, here);
      continue;
    }
    asked.push(value);
  }
  if (resolution === undefined || asked.length === 0) {
    return found;
  }
  // A pack's unwrapping answer wins; only then is a call, or a name
  // written as one, what its factory returns.
  for (const [value, resolved] of resolution.resolveCalledFunctions(asked)) {
    found.set(value, resolved === null ? null : toFunctionRoot(resolved));
  }
  return found;
}

/**
 * The name a property of an object literal is written under, or null
 * for a spread, which has none.
 */
export function propertyNameOf(property: Node): string | null {
  if (
    Node.isPropertyAssignment(property) ||
    Node.isShorthandPropertyAssignment(property) ||
    Node.isMethodDeclaration(property)
  ) {
    return keyNameOf(property.getNameNode());
  }
  return null;
}

/**
 * `{ "fetch"() {} }` and `{ fetch() {} }` define the same property, so
 * a quoted key gives the string inside the quotes. A computed key
 * gives null, which is what a caller matching a name can do with it.
 */
function keyNameOf(name: Node): string | null {
  if (Node.isIdentifier(name) || Node.isPrivateIdentifier(name)) {
    return name.getText();
  }
  if (
    Node.isStringLiteral(name) ||
    Node.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.getLiteralValue();
  }
  return Node.isNumericLiteral(name) ? String(name.getLiteralValue()) : null;
}

/**
 * The function a property of an object literal is set to. A method
 * written into the literal is that function; a property set to a name
 * or a call is followed the way `functionValueOf` follows any value.
 */
export function propertyFunctionOf(
  property: Node,
  resolution: ResolutionStore | undefined,
): FunctionRoot | null {
  if (Node.isMethodDeclaration(property)) {
    return property;
  }
  const held = propertyValueOf(property);
  return held === null ? null : functionValueOf(held, resolution);
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
 * What an object sets one named property to, with a spread walked and
 * a shorthand giving back the name it forwards. Null when nothing in
 * the object sets that name.
 */
export function propertyOf(
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
  return writtenNodesOf([value], resolution).get(value) ?? null;
}

/**
 * `writtenNodeOf` for several values, asked of the store in at most
 * three questions however many values there are: what each name is
 * written as, which callees resolve, and what those calls return.
 */
export function writtenNodesOf(
  values: readonly Node[],
  resolution: ResolutionStore | undefined,
): Map<Node, Node | null> {
  const found = new Map<Node, Node | null>();
  const names = new Map<Node, Node>();
  const calls = new Map<Node, CallExpression>();
  for (const value of values) {
    const written = factKeyOf(value);
    if (Node.isNewExpression(written)) {
      found.set(value, written);
      continue;
    }
    if (Node.isCallExpression(written)) {
      calls.set(value, written);
      continue;
    }
    if (resolution === undefined || !couldNameAValue(written)) {
      found.set(value, null);
      continue;
    }
    names.set(value, written);
  }

  if (resolution !== undefined && names.size > 0) {
    const resolved = resolution.resolveWrittenValues([...names.values()]);
    for (const [value, name] of names) {
      const one = resolved.get(name) ?? null;
      if (one !== null && Node.isCallExpression(one)) {
        calls.set(value, one);
      } else {
        found.set(value, one);
      }
    }
  }

  const throughCalls = writtenThroughCalls([...calls.values()], resolution);
  for (const [value, call] of calls) {
    found.set(value, throughCalls.get(call) ?? call);
  }
  return found;
}

/**
 * Each call's own construction, or what its callee's return value is
 * written as when the callee is a project function. A name bound to
 * `client()` and `client()` itself both land here, so a wrapper called
 * through a variable resolves the same way as one called directly.
 */
function writtenThroughCalls(
  calls: readonly CallExpression[],
  resolution: ResolutionStore | undefined,
): Map<CallExpression, Node> {
  const found = new Map<CallExpression, Node>(
    calls.map((call) => [call, call]),
  );
  if (resolution === undefined || calls.length === 0) {
    return found;
  }
  const callees = resolution.resolveCallables(
    calls.map((call) => call.getExpression()),
  );
  const intoProject = calls.filter(
    (call) => callees.get(call.getExpression()) !== null,
  );
  if (intoProject.length === 0) {
    return found;
  }
  const returned = resolution.resolveWrittenValues(intoProject);
  for (const call of intoProject) {
    const resolved = returned.get(call) ?? null;
    if (resolved !== null) {
      found.set(call, resolved);
    }
  }
  return found;
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

/** The number this value comes to, or null when it does not settle to one. */
export function numberValueOf(
  value: Node,
  resolution: ResolutionStore | undefined,
): number | null {
  const settled = constantOf(evaluatedValue(value, resolution));
  return typeof settled === "number" && Number.isFinite(settled)
    ? settled
    : null;
}

/**
 * Every string this value can come to, when the evaluator settles it to
 * a few: a template over a string literal union, or a name two branches
 * set. Null when part of it could be anything, or past `cap` strings.
 */
export function stringValuesOf(
  value: Node,
  resolution: ResolutionStore | undefined,
  cap: number,
): readonly string[] | null {
  return literalsOf(evaluatedValue(value, resolution), cap);
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
  site?: string,
): string | null {
  const record = evaluatedValue(object, resolution, site);
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
