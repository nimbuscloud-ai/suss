/**
 * The ops a declared pack is handed for a TypeScript call: the ops in
 * `@suss/recognize/ops`, read off the store's facts, with the members
 * those leave out taken from `callOpsFor` at the same node. A run with no
 * store, or a call the facts do not state, such as a tagged template,
 * gets `callOpsFor` whole.
 */

import { Node } from "ts-morph";

import { factCallOps, factValueOps } from "@suss/recognize/ops";

import { nodeId } from "../facts/extract.js";
import { type CallReading, callOpsFor } from "./callOps.js";
import { factSourceFor, statedFactKey } from "./factSource.js";

import type { AstCapableOps, CallOps, ValueOps } from "@suss/extractor";
import type {
  CallExpression,
  NewExpression,
  SourceFile,
  TaggedTemplateExpression,
} from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

type Called = CallExpression | NewExpression | TaggedTemplateExpression;

/** One value a file exports, and the line its declaration starts on. */
export interface ExportedValue {
  readonly value: ValueOps;
  readonly line: number;
}

/**
 * The values a file exports, by the name each is exported under, as the
 * ops over the facts read them. A reader of a module's exports asks them
 * the questions a pack asks of a value a call states.
 */
export function exportedValuesOf(
  sourceFile: SourceFile,
  store: ResolutionStore,
): Map<string, ExportedValue[]> {
  const source = factSourceFor(store);
  const exported = new Map<string, ExportedValue[]>();
  for (const [name, nodes] of store.exportsOf(sourceFile)) {
    exported.set(
      name,
      nodes.map((node) => ({
        value: factValueOps(statedFactKey(node, store), source),
        line: node.getStartLineNumber(),
      })),
    );
  }
  return exported;
}

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
    receiverGlobal: (paths) => ops.receiverGlobal?.(paths),
    isFrom: (origin) => ops.isFrom(origin),
    argumentCount: () => ops.argumentCount(),
    nameAt: (index, unsettled) => ops.nameAt(index, unsettled),
    calleeText: () => ops.calleeText(),
    receiver: () => ops.receiver(),
    site: () => ops.site?.() ?? nodeId(node),
    chainedOn: () => ops.chainedOn?.() ?? null,
    member: () => ops.member?.() ?? null,
    file: () => ops.file?.() ?? null,
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
