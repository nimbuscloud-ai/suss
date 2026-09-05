/**
 * routePath.ts: read the path a boundary serves out of the argument that
 * states it. The argument is evaluated over the abstract value domain
 * and spelled by `@suss/values`, so a TypeScript route reads the same
 * as one in any other language.
 */

import { pathOf } from "@suss/values";

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
