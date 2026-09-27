/**
 * routePath.ts: read the path a boundary serves out of the argument that
 * states it. The argument is evaluated over the abstract value domain
 * and spelled by `@suss/values`, so a TypeScript route reads the same
 * as one in any other language.
 */

import { force, isLocalUrl, pathOf } from "@suss/values";

import { evaluatedValue } from "../values/evaluator.js";

import type { Value } from "@suss/values";
import type { Node } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The path stated by the argument at a call site, with every name the
 * evaluator can follow folded in. Undefined when nothing readable is
 * there, which leaves the boundary unbound rather than bound to a guess.
 * With a site, the path when the receiver behind the argument is the
 * instance that site made.
 */
export function pathFromArgument(
  arg: Node,
  resolution?: ResolutionStore,
  site?: string,
): string | undefined {
  return pathOf(evaluatedValue(arg, resolution, site));
}

/**
 * The path stated by a property of the object at a call site, for a
 * client that takes its request as one config object, `axios({ url })`.
 * The object is evaluated whole, so a spread from a name the evaluator
 * can follow contributes its `url` the same as one written in place.
 */
export function pathFromProperty(
  arg: Node,
  property: string,
  resolution?: ResolutionStore,
  site?: string,
): string | undefined {
  const value = propertyValueAt(arg, property, resolution, site);
  return value === undefined ? undefined : pathOf(value);
}

/**
 * Whether the URL at the argument, or at one of its properties, is one
 * fetch reads without a request, such as a `data:` URI.
 */
export function statesLocalUrl(
  arg: Node,
  property: string | undefined,
  resolution?: ResolutionStore,
): boolean {
  const value =
    property === undefined
      ? evaluatedValue(arg, resolution)
      : propertyValueAt(arg, property, resolution);
  return value !== undefined && isLocalUrl(value);
}

function propertyValueAt(
  arg: Node,
  property: string,
  resolution?: ResolutionStore,
  site?: string,
): Value | undefined {
  const record = evaluatedValue(arg, resolution, site);
  if (record.kind !== "record") {
    return undefined;
  }
  const field = record.fields.get(property);
  return field === undefined ? undefined : force(field.value);
}
