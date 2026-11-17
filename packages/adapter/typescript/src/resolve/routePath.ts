/**
 * routePath.ts: read the path a route serves out of the argument that
 * states it. The argument is evaluated over the abstract value domain
 * and spelled by `@suss/values`, so a TypeScript route reads the same
 * as one in any other language.
 */

import { routePatternOf } from "@suss/values";

import { evaluatedValue } from "../values/evaluator.js";

import type { Node } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

/**
 * The route pattern a server registers at a call site, such as Express's
 * `router.get("/:pk/:filename?", ...)`, where a `?` marks an optional
 * parameter rather than a query.
 */
export function routePatternFromArgument(
  arg: Node,
  resolution?: ResolutionStore,
): string | undefined {
  return routePatternOf(evaluatedValue(arg, resolution));
}
