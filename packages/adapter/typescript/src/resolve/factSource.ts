/**
 * What this adapter hands the fact-based ops in `@suss/recognize/ops`:
 * the store's facts, and the reads only TypeScript can make. Each read
 * is the one `callOpsFor` makes, so the two answer alike wherever the
 * facts say what the nodes do.
 */

import { Node } from "ts-morph";

import { type FactSource, factCallOps } from "@suss/recognize/ops";

import { stringValuesOf, writtenNodeOf } from "../discovery/resolveValue.js";
import { nodeId } from "../facts/extract.js";
import { peelValue } from "../walk/unwrap.js";
import { functionCalledAt } from "./functionBehind.js";
import {
  effectArgOf,
  isImportedFrom,
  methodDeclaredIn,
  type OriginatesFrom,
} from "./invocationEffects.js";
import { readName } from "./readName.js";

import type { CallOps } from "@suss/extractor";
import type { ResolutionStore } from "../facts/store.js";

/** The fact source for one run's store. */
export function factSourceFor(
  store: ResolutionStore,
  originatesFrom?: OriginatesFrom,
): FactSource {
  const access = store.factAccess();
  const nodeOf = (key: string): Node | null => access.nodeOf(key) ?? null;
  const resolve = (value: Node): Node | null =>
    store.resolveWrittenValue(value);
  const keyOf = (node: Node | null): string | null =>
    node === null ? null : nodeId(peelValue(node));
  const at = <T>(key: string, empty: T, read: (node: Node) => T): T => {
    const node = nodeOf(key);
    return node === null ? empty : read(node);
  };

  return {
    db: access.db,
    read: (key) => at(key, undefined, access.state),
    writtenAs: (key) => at(key, null, (node) => keyOf(resolve(node))),
    anchorCalls: (key) =>
      at(key, [], (node) => store.anchorCallsOf(node, () => true).map(nodeId)),
    importedFrom: (key, module) =>
      at(key, false, (node) => isImportedFrom(node, module, originatesFrom)),
    shapeOf: (key) => at(key, null, shapeOf),
    textOf: (key) => at(key, "", (node) => node.getText()),
    literalOf: (key) => at(key, null, literalOf),
    nameOf: (key, unsettled) =>
      at(key, null, (node) => readName(node, { resolve, unsettled })),
    computedKeyOf: (held, unsettled) =>
      at(held, null, (node) => {
        const key = computedKeyOfEntry(node);
        return key === null ? null : readName(key, { resolve, unsettled });
      }),
    namesOf: (key, cap) =>
      at(key, null, (node) => stringValuesOf(node, store, cap)),
    argOf: (key) => at(key, null, effectArgOf),
    callsProjectMethod: (call) =>
      at(
        call,
        false,
        (node) =>
          Node.isCallExpression(node) && functionCalledAt(node) !== null,
      ),
    returnedBy: (call) =>
      at(call, null, (node) =>
        Node.isCallExpression(node) ? keyOf(writtenNodeOf(node, store)) : null,
      ),
    declares: (call, module) =>
      at(call, false, (node) => {
        const callee =
          Node.isCallExpression(node) || Node.isNewExpression(node)
            ? node.getExpression()
            : null;
        return (
          callee !== null &&
          methodDeclaredIn(callee, module, resolve, originatesFrom)
        );
      }),
  };
}

/** The fact-based ops for one call, with the call's own facts stated first. */
export function factOpsFor(
  call: Node,
  store: ResolutionStore,
  originatesFrom?: OriginatesFrom,
): CallOps | null {
  store.factAccess().state(call);
  return factCallOps(nodeId(call), factSourceFor(store, originatesFrom));
}

/** The expression a computed key is written with, for the value of that entry, or null. */
function computedKeyOfEntry(held: Node): Node | null {
  let at = held.getParent();
  while (at !== undefined && !Node.isPropertyAssignment(at)) {
    if (Node.isObjectLiteralExpression(at)) {
      return null;
    }
    at = at.getParent();
  }
  const name = at?.getNameNode();
  return name !== undefined && Node.isComputedPropertyName(name)
    ? name.getExpression()
    : null;
}

function shapeOf(node: Node): "object" | "list" | null {
  if (Node.isObjectLiteralExpression(node)) {
    return "object";
  }
  return Node.isArrayLiteralExpression(node) ? "list" : null;
}

/** A string, number or boolean the source writes out, or null for anything else. */
function literalOf(node: Node): string | number | boolean | null {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  if (Node.isNumericLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isTrueLiteral(node) || Node.isFalseLiteral(node)) {
    return Node.isTrueLiteral(node);
  }
  return null;
}
