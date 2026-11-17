// The context the TypeScript adapter hands a pack's `subUnits` hook: the
// ops `SubUnitOpsCarrier` declares, read off the run's store, so a declared
// pack claims a callback the same way in each language.

import { type CallExpression, type NewExpression, Node } from "ts-morph";

import { factElementOps } from "@suss/recognize/ops";

import { nodeId } from "./facts/extract.js";
import { fileMentions } from "./fileMentions.js";
import { factSourceFor } from "./resolve/factSource.js";
import { opsOverFacts } from "./resolve/opsOverFacts.js";

import type {
  AstCapableValueOps,
  CallOps,
  DiscoveredSubUnitParent,
  ElementOps,
  SubUnitOpsCarrier,
  ValueOps,
} from "@suss/extractor";
import type { FunctionRoot } from "./conditions.js";
import type { ResolutionStore } from "./facts/store.js";

/** The context the TypeScript adapter passes to a pack's `subUnits` hook. Without a store it can only say what a file mentions. */
export function createTsSubUnitContext(
  resolution?: ResolutionStore,
): SubUnitOpsCarrier {
  return {
    ...(resolution === undefined
      ? {}
      : {
          calls: (parent) => callsRunAsOps(parent, resolution),
          elements: (parent) => elementsRunAsOps(parent, resolution),
          writes: (parent, fn) => parentWrites(parent, fn),
        }),
    mentions: (parent, word) =>
      fileMentions((parent.func as Node).getSourceFile(), word),
  };
}

/** The JSX elements the parent renders, as the ops a declared pack reads each one's tag and attributes through. */
function elementsRunAsOps(
  parent: DiscoveredSubUnitParent,
  store: ResolutionStore,
): ElementOps[] {
  const source = factSourceFor(store, (value, module) =>
    store.originatesFrom(value, module),
  );
  return store
    .elementsRunBy(parent.func as FunctionRoot)
    .map((element) => factElementOps(nodeId(element), source));
}

/** Whether the function a value settles to is written in the parent's body, at any depth. */
function parentWrites(parent: DiscoveredSubUnitParent, fn: ValueOps): boolean {
  const node = (fn as Partial<AstCapableValueOps>).ast?.() ?? null;
  return (
    node instanceof Node && isWithinFunction(node, parent.func as FunctionRoot)
  );
}

/**
 * The calls the parent's body runs, as the ops a declared pack's
 * recognizer gets for each, so its hook matches a call the same way.
 */
function callsRunAsOps(
  parent: DiscoveredSubUnitParent,
  store: ResolutionStore,
): CallOps[] {
  const originatesFrom = (value: Node, module: string): boolean =>
    store.originatesFrom(value, module);
  return store
    .callsRunBy(parent.func as FunctionRoot)
    .filter(
      (call): call is CallExpression | NewExpression =>
        Node.isCallExpression(call) || Node.isNewExpression(call),
    )
    .map((call) => opsOverFacts(call, { resolution: store, originatesFrom }));
}

function isWithinFunction(node: Node, func: FunctionRoot): boolean {
  let current: Node | undefined = node.getParent();
  while (current !== undefined) {
    if (current === func) {
      return true;
    }
    current = current.getParent();
  }
  return false;
}
