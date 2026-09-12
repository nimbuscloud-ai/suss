import { Evaluator, force, type Value } from "@suss/values";

import { typescriptLowering } from "./lowering.js";
import { typescriptRows } from "./rows.js";

import type { Node } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

const evaluators = new WeakMap<object, Evaluator<Node>>();

/**
 * One evaluator per resolution store, or per project when a caller has
 * no store, so the statement memo is shared across every question asked
 * of the same source.
 */
export function evaluatorFor(
  node: Node,
  resolution: ResolutionStore | undefined,
): Evaluator<Node> {
  const key: object = resolution ?? node.getProject();
  let evaluator = evaluators.get(key);
  if (evaluator === undefined) {
    evaluator = new Evaluator(
      typescriptLowering(
        resolution === undefined
          ? { rows: typescriptRows }
          : { resolution, rows: typescriptRows },
      ),
    );
    evaluators.set(key, evaluator);
  }
  return evaluator;
}

/** What an expression is worth where it is written, with nothing left lazy. */
export function evaluatedValue(
  node: Node,
  resolution: ResolutionStore | undefined,
): Value {
  return force(evaluatorFor(node, resolution).evaluate(node));
}

/**
 * The same, with parameters of the enclosing function given the values
 * a call site passed them. A parameter left out of the map stays a
 * hole, and the run is not memoized, so a second caller's values do not
 * see the first caller's.
 */
export function evaluatedValueUnder(
  node: Node,
  resolution: ResolutionStore | undefined,
  bindings: ReadonlyMap<string, Value>,
): Value {
  // Binding nothing is the plain question, and only the plain question
  // is allowed to reuse the statement memo.
  return bindings.size === 0
    ? evaluatedValue(node, resolution)
    : force(evaluatorFor(node, resolution).evaluate(node, { bindings }));
}
