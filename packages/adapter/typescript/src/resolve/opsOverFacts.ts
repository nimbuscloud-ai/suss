/**
 * The ops a declared pack is handed for a TypeScript call: the ops in
 * `@suss/recognize/ops`, read off the store's facts, with the members
 * those leave out taken from `callOpsFor` at the same node. A run with no
 * store, or a call the facts do not state, such as a tagged template,
 * gets `callOpsFor` whole.
 */

import { Node } from "ts-morph";

import { factCallOps } from "@suss/recognize/ops";

import { type CallReading, callOpsFor } from "./callOps.js";
import { factSourceFor, statedFactKey } from "./factSource.js";

import type { AstCapableOps, CallOps } from "@suss/extractor";
import type {
  CallExpression,
  NewExpression,
  TaggedTemplateExpression,
} from "ts-morph";

type Called = CallExpression | NewExpression | TaggedTemplateExpression;

/** The ops for one call, as a context hands them to a pack. */
export function opsOverFacts(call: Called, reading: CallReading): CallOps {
  const store = reading.resolution;
  if (store === undefined) {
    return callOpsFor(call, reading);
  }
  const resolve = reading.walk?.writtenValueOf ?? reading.resolve;
  // What callOpsFor hands a call it steps to: the same reads, and none
  // of the walk's or the listener's.
  const nested: CallReading = {
    ...(resolve === undefined ? {} : { resolve }),
    resolution: store,
  };
  const source = factSourceFor(store, reading.originatesFrom, {
    ...(resolve === undefined ? {} : { resolve }),
    extend: (node, ops) =>
      withNodeMembers(ops, node, node === call ? reading : nested),
  });
  return (
    factCallOps(statedFactKey(call, store), source) ?? callOpsFor(call, reading)
  );
}

/** The fact ops for a call, with the members only the node can give added from `callOpsFor`. */
function withNodeMembers(
  ops: CallOps,
  node: Node,
  reading: CallReading,
): CallOps {
  if (
    !Node.isCallExpression(node) &&
    !Node.isNewExpression(node) &&
    !Node.isTaggedTemplateExpression(node)
  ) {
    return ops;
  }
  let fromNodes: AstCapableOps | null = null;
  const nodes = (): AstCapableOps => {
    fromNodes ??= callOpsFor(node, reading);
    return fromNodes;
  };
  const added: AstCapableOps = {
    method: () => ops.method(),
    receiverIsFrom: (origin) => ops.receiverIsFrom(origin),
    isFrom: (origin) => ops.isFrom(origin),
    argumentCount: () => ops.argumentCount(),
    nameAt: (index, unsettled) => ops.nameAt(index, unsettled),
    calleeText: () => ops.calleeText(),
    receiver: () => ops.receiver(),
    argument: (index) => ops.argument(index),
    callee: () => ops.callee(),
    propertyAt: (index, property, unsettled) =>
      ops.propertyAt(index, property, unsettled),
    valueAt: (index) => ops.valueAt(index),
    anchorCall: (origin) => ops.anchorCall?.(origin) ?? null,
    namedCallee: () => nodes().namedCallee?.() ?? false,
    calleeImportedAs: (modules) => ops.calleeImportedAs?.(modules) ?? null,
    parameterReadsAt: (index) => nodes().parameterReadsAt?.(index) ?? null,
    classAt: (index) => nodes().classAt?.(index) ?? null,
    readingArguments: (first, last) => nodes().readingArguments?.(first, last),
    readingReceivers: (methods) => nodes().readingReceivers?.(methods),
    ast: () => node,
  };
  return reading.statesSlots === undefined
    ? added
    : { ...added, statesSlots: reading.statesSlots };
}
