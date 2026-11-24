/**
 * The ops for a call that state the call's facts only when a chain asks
 * something its source text cannot settle.
 *
 * A schema chain runs at every call the access walk visits, and looks
 * the call's name up before anything else. Building the ops over the
 * facts states the call's facts, which for a call at module scope
 * nothing else would, and every fact stated is one more the store
 * reads for every later question. So `method()`, `calleeText()`, the
 * callee's own import and the calls in the callee are read off the
 * nodes here, and the ops over the facts are built on the first other
 * question.
 */

import { Node, SyntaxKind } from "ts-morph";

import { nodeId } from "../facts/extract.js";
import { fileMentions } from "../fileMentions.js";
import { peelValue } from "../walk/unwrap.js";
import { opsOverFacts } from "./opsOverFacts.js";
import { helperCalleeOf } from "./suppliedKeys.js";

import type { CallOps } from "@suss/extractor";
import type { CallExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";
import type { CallReading } from "./callOps.js";

/**
 * The ops for one call, its facts stated on the first question that
 * needs them. `overFacts` builds the ops over the facts, by default with
 * a fact source of their own.
 */
export function deferredCallOps(
  call: CallExpression,
  reading: CallReading,
  overFacts: () => CallOps = () => opsOverFacts(call, reading),
): CallOps {
  const callee = peelValue(call.getExpression());
  const method = Node.isPropertyAccessExpression(callee)
    ? callee.getName()
    : null;
  let text: string | null = null;
  let facts: CallOps | null = null;
  const stated = (): CallOps => {
    facts ??= overFacts();
    return facts;
  };
  let inCallee: readonly CallOps[] | null = null;
  return {
    method: () => method,
    calleeText: () => {
      text ??= callee.getText();
      return text;
    },
    calleeImport: (modules) =>
      importedUnder(callee, modules, reading.resolution),
    callsInCallee: () => {
      inCallee ??= callsInCalleeOf(call, reading);
      return inCallee;
    },
    site: () => nodeId(call),
    file: () => call.getSourceFile().getFilePath(),
    mentions: (word) => fileMentions(call.getSourceFile(), word),
    receiverIsFrom: (origin) => stated().receiverIsFrom(origin),
    receiverSettledFrom: (origin) => stated().receiverSettledFrom?.(origin),
    receiverGlobal: (paths) => stated().receiverGlobal?.(paths),
    isFrom: (origin) => stated().isFrom(origin),
    calleeSettledFrom: (origin) => stated().calleeSettledFrom?.(origin),
    constructionSites: () => stated().constructionSites?.() ?? [],
    forks: () => stated().forks?.() ?? null,
    takingArms: (arms) => stated().takingArms?.(arms) ?? stated(),
    argumentCount: () => stated().argumentCount(),
    nameAt: (index, unsettled) => stated().nameAt(index, unsettled),
    receiver: () => stated().receiver(),
    receiverValue: () => stated().receiverValue?.() ?? null,
    chainedOn: () => stated().chainedOn?.() ?? null,
    passedTo: () => stated().passedTo?.() ?? null,
    enclosingBody: () => stated().enclosingBody?.() ?? null,
    member: () => stated().member?.() ?? null,
    argument: (index) => stated().argument(index),
    callee: () => stated().callee(),
    namedCallee: () => stated().namedCallee?.() ?? false,
    calleeImportedAs: (modules) => stated().calleeImportedAs?.(modules) ?? null,
    parameterReadsAt: (index) => stated().parameterReadsAt?.(index) ?? null,
    propertyAt: (index, property, unsettled) =>
      stated().propertyAt(index, property, unsettled),
    valueAt: (index) => stated().valueAt(index),
    anchorCall: (origin) => stated().anchorCall?.(origin) ?? null,
    classAt: (index) => stated().classAt?.(index) ?? null,
  };
}

/** The one export of the modules the file's own import binds the callee to, or null. */
function importedUnder(
  callee: Node,
  modules: readonly string[],
  store: ResolutionStore | undefined,
): string | null {
  const names = new Set(store?.importedUnder(callee, modules) ?? []);
  const [one] = names;
  return names.size === 1 && one !== undefined ? one : null;
}

/**
 * The calls each callee writes, worked out once per store, so a helper
 * that twenty handlers call is read once and its calls keep what the
 * chains already asked them.
 */
const CALLS_BY_CALLEE = new WeakMap<
  ResolutionStore,
  WeakMap<Node, readonly CallOps[]>
>();

/** The calls written in the project function the call reaches, nested functions included, in source order. */
function callsInCalleeOf(
  call: CallExpression,
  reading: CallReading,
): readonly CallOps[] {
  const callee = helperCalleeOf(call, reading.resolution);
  if (callee === null) {
    return [];
  }
  const kept = keptFor(reading.resolution);
  const known = kept?.get(callee);
  if (known !== undefined) {
    return known;
  }
  const calls = callee
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .map((one) => deferredCallOps(one, reading));
  kept?.set(callee, calls);
  return calls;
}

/** The calls kept for one store's callees, or none to keep without a store. */
function keptFor(
  store: ResolutionStore | undefined,
): WeakMap<Node, readonly CallOps[]> | undefined {
  if (store === undefined) {
    return undefined;
  }
  const kept = CALLS_BY_CALLEE.get(store);
  if (kept !== undefined) {
    return kept;
  }
  const made = new WeakMap<Node, readonly CallOps[]>();
  CALLS_BY_CALLEE.set(store, made);
  return made;
}
