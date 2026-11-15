// The context the TypeScript adapter hands a pack's `subUnits` hook: the
// ops `SubUnitOpsCarrier` declares, read off the run's store, so a declared
// pack claims a callback the same way in each language.

import { type CallExpression, type NewExpression, Node } from "ts-morph";

import { factElementOps } from "@suss/recognize/ops";

import { nodeId } from "./facts/extract.js";
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

/**
 * The context the TypeScript adapter passes to a pack's `subUnits` hook:
 * the ops a declared pack reads a parent through, and the run's store.
 */
export interface TsSubUnitContext extends SubUnitOpsCarrier {
  /**
   * The run's store, the same one a recognizer's context has, so a pack
   * that claims a callback off a call it recognized can ask the store
   * the same questions about that call. Undefined when the run has no
   * store.
   */
  readonly resolution?: ResolutionStore;
}

export function createTsSubUnitContext(
  resolution?: ResolutionStore,
): TsSubUnitContext {
  return {
    ...(resolution === undefined
      ? {}
      : {
          resolution,
          calls: (parent) => callsRunAsOps(parent, resolution),
          elements: (parent) => elementsRunAsOps(parent, resolution),
          writes: (parent, fn) => parentWrites(parent, fn),
        }),
    mentions: (parent, word) =>
      (parent.func as Node).getSourceFile().getFullText().includes(word),
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
