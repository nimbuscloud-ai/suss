/**
 * Where the value in each slot of a unit's effects came from.
 *
 * A recognizer says which value a call states for each column it writes
 * or picks rows by. This asks the store once for every such value in the
 * unit. The extractor's `sourceRefsOf` turns where each walk ended into
 * value references, and what an input is in TypeScript is said here: a
 * path off one of the unit's own parameters. The walk itself is in
 * `@suss/resolution`, whose DESIGN.md says why it stops at a parameter.
 */

import { Node } from "ts-morph";

import { sourceRefsOf } from "@suss/extractor";
import { constantOf } from "@suss/values";

import { evaluatedValue } from "./values/evaluator.js";

import type { ValueRef } from "@suss/behavioral-ir";
import type { RawBranch, RawProvenance, SourceSpelling } from "@suss/extractor";
import type { SourceLeaf } from "@suss/resolution";
import type { BindingElement } from "ts-morph";
import type { FunctionRoot } from "./conditions.js";
import type { ResolutionStore, SourceFound } from "./facts/store.js";
import type { RecognizedEffectLocation } from "./resolve/invocationEffects.js";

/** Put on each branch where the values in its recognized effects' slots came from. */
export function recordProvenance(
  func: FunctionRoot,
  firing: ReadonlyMap<RawBranch, readonly RecognizedEffectLocation[]>,
  resolution: ResolutionStore,
): void {
  const values = [
    ...new Set(
      [...firing.values()]
        .flat()
        .flatMap((located) => (located.slots ?? []).map((one) => one.value)),
    ),
  ];
  if (values.length === 0) {
    return;
  }
  const sources = resolution.sourcesOf(values);
  const refs = new Map(
    values.map((value) => [
      value,
      refsOf(sources.get(value) ?? [], func, resolution),
    ]),
  );
  for (const [branch, located] of firing) {
    const provenance: RawProvenance[] = located.flatMap((one) =>
      (one.slots ?? []).map((slot) => ({
        effect: one.effect,
        slot: slot.slot,
        name: slot.name,
        from: refs.get(slot.value) ?? [],
      })),
    );
    if (provenance.length > 0) {
      branch.provenance = provenance;
    }
  }
}

function refsOf(
  found: readonly SourceFound[],
  func: FunctionRoot,
  resolution: ResolutionStore,
): ValueRef[] {
  const nodes = new Map<string, Node>();
  const byLeaf = new Map<SourceLeaf, SourceFound>();
  for (const one of found) {
    byLeaf.set(one.leaf, one);
    if (one.node !== null) {
      nodes.set(one.leaf.key, one.node);
    }
    if (one.leaf.computedAt !== null && one.computedAt !== null) {
      nodes.set(one.leaf.computedAt, one.computedAt);
    }
  }
  const spelling: SourceSpelling<SourceLeaf> = {
    inputOf: (leaf) => {
      const one = byLeaf.get(leaf);
      return one === undefined ? null : inputOf(one, func);
    },
    literalAt: (key) => literalAt(nodes.get(key), resolution),
    textAt: (key) => nodes.get(key)?.getText() ?? null,
  };
  return sourceRefsOf(
    found.map((one) => one.leaf),
    spelling,
  );
}

/**
 * A path off one of the unit's own parameters. A destructured parameter
 * is written the way a guard writes one, with the name it binds as the
 * input.
 */
function inputOf(found: SourceFound, func: FunctionRoot): ValueRef | null {
  const { leaf, node, parameterOf } = found;
  if (node !== null && Node.isBindingElement(node)) {
    return boundByParameterOf(node, func)
      ? { type: "input", inputRef: node.getName(), path: leaf.path }
      : null;
  }
  if (
    parameterOf !== func ||
    node === null ||
    !Node.isParameterDeclaration(node)
  ) {
    return null;
  }
  const name = node.getNameNode();
  return Node.isIdentifier(name)
    ? { type: "input", inputRef: name.getText(), path: leaf.path }
    : null;
}

/** Whether a name is bound by taking apart one of `func`'s own parameters. */
function boundByParameterOf(element: BindingElement, func: FunctionRoot) {
  const parameter = element.getParent().getParent();
  return (
    Node.isParameterDeclaration(parameter) && parameter.getParent() === func
  );
}

/** The constant a value the source writes out settles to, or undefined when it has none. */
function literalAt(
  node: Node | undefined,
  resolution: ResolutionStore,
): string | number | boolean | null | undefined {
  return node === undefined
    ? undefined
    : constantOf(evaluatedValue(node, resolution));
}
