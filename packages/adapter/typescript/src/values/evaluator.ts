import { writtenValueRef } from "@suss/extractor";
import { Evaluator, force, type Value, writtenLiteralOf } from "@suss/values";

import { createProgramMemo } from "../programMemo.js";
import { declaredParameters, typescriptLowering } from "./lowering.js";
import { typescriptRows } from "./rows.js";
import { typescriptSoundLowering } from "./soundLowering.js";

import type { ValueRef } from "@suss/behavioral-ir";
import type { FunctionLikeDeclaration, Node, Project } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

const evaluators = createProgramMemo<object, Evaluator<Node>>();
const soundEvaluators = createProgramMemo<object, Evaluator<Node>>();

/**
 * Every value an expression can have when the program runs, or a hole
 * where the sound evaluator cannot cover every run. One evaluator per
 * resolution store, so the conditions of one function share its memo.
 */
export function soundValueOf(
  node: Node,
  resolution: ResolutionStore | undefined,
): Value {
  const project: Project = node.getProject();
  const key: object = resolution ?? project;
  let evaluator = soundEvaluators.get(project, key);
  if (evaluator === undefined) {
    evaluator = new Evaluator(typescriptSoundLowering(resolution), {
      sound: true,
    });
    soundEvaluators.set(project, key, evaluator);
  }
  return evaluator.evaluate(node);
}

/**
 * One evaluator per resolution store, or per project when a caller has
 * no store, so the statement memo is shared across every question asked
 * of the same source.
 */
export function evaluatorFor(
  node: Node,
  resolution: ResolutionStore | undefined,
): Evaluator<Node> {
  const project: Project = node.getProject();
  const key: object = resolution ?? project;
  let evaluator = evaluators.get(project, key);
  if (evaluator === undefined) {
    evaluator = new Evaluator(
      typescriptLowering(
        resolution === undefined
          ? { rows: typescriptRows }
          : { resolution, rows: typescriptRows },
      ),
    );
    evaluators.set(project, key, evaluator);
  }
  return evaluator;
}

/**
 * What each name a function's parameters bind takes when a caller passes
 * nothing for it: the literal its default comes down to, or a hole
 * quoting the default when the function works it out as it runs. A
 * name a destructured parameter binds has the default written beside it.
 */
export function parameterDefaults(
  fn: FunctionLikeDeclaration,
  resolution: ResolutionStore | undefined,
): ReadonlyMap<string, ValueRef> {
  const found = new Map<string, ValueRef>();
  for (const parameter of declaredParameters(fn)) {
    const written = parameter.default;
    if (written !== null) {
      const literal = writtenLiteralOf(evaluatedValue(written, resolution));
      found.set(parameter.name, writtenValueRef(literal, written.getText()));
    }
  }
  return found;
}

/**
 * What an expression is worth where it is written, with nothing left
 * lazy. With a site, what it is worth when the receiver behind it is
 * the instance that site made; that run is not memoized.
 */
export function evaluatedValue(
  node: Node,
  resolution: ResolutionStore | undefined,
  site?: string,
): Value {
  const evaluator = evaluatorFor(node, resolution);
  return force(
    site === undefined
      ? evaluator.evaluate(node)
      : evaluator.evaluate(node, { site }),
  );
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

/**
 * What a call gives each parameter of the function it calls, with the
 * parameters of the function the call is written in bound by
 * `bindings`: the argument passed, else the parameter's default, else
 * undefined. Null when the evaluator cannot see the function the call
 * runs.
 */
export function argumentsAt(
  call: Node,
  resolution: ResolutionStore | undefined,
  bindings: ReadonlyMap<string, Value>,
): ReadonlyMap<string, Value> | null {
  return evaluatorFor(call, resolution).argumentsAt(call, { bindings });
}

/**
 * What an expression is worth when the function it is written in runs
 * from one particular call. `calls` runs innermost first: the first one
 * calls the expression's function, the next calls the function the
 * first is written in, and so on out, and each call's arguments are
 * read with its own function's parameters bound by the call after it.
 * `given` takes a value in place of each construction it lists. Null
 * when a call in the chain runs a function the evaluator cannot see.
 */
export function evaluatedValueThrough(
  node: Node,
  calls: readonly Node[],
  resolution: ResolutionStore | undefined,
  given: ReadonlyMap<Node, Value>,
): Value | null {
  const evaluator = evaluatorFor(node, resolution);
  let bindings: ReadonlyMap<string, Value> = new Map();
  for (const call of [...calls].reverse()) {
    const bound = evaluator.argumentsAt(call, { bindings, given });
    if (bound === null) {
      return null;
    }
    bindings = bound;
  }
  return evaluator.evaluate(node, { bindings, given });
}
