/**
 * routePath.ts: read the path a boundary serves out of the argument that
 * states it. The argument is evaluated over the abstract value domain
 * and spelled by `@suss/values`, so a TypeScript route reads the same
 * as one in any other language.
 */

import { force, pathOf } from "@suss/values";

import { evaluatedValue } from "../values/evaluator.js";

import type { Node } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The path stated by the argument at a call site, with every name the
 * evaluator can follow folded in. Undefined when nothing readable is
 * there, which leaves the boundary unbound rather than bound to a guess.
 */
export function pathFromArgument(
  arg: Node,
  resolution?: ResolutionStore,
): string | undefined {
  return pathOf(evaluatedValue(arg, resolution));
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
): string | undefined {
  const record = evaluatedValue(arg, resolution);
  if (record.kind !== "record") {
    return undefined;
  }
  const field = record.fields.get(property);
  return field === undefined ? undefined : pathOf(force(field.value));
}
