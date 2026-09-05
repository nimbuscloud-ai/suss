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
