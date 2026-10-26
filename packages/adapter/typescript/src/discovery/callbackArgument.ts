/**
 * Discovery for a function handed to a call or construction of a library
 * export, such as BullMQ's `new Worker("emails", processor)`. The calls
 * come from one batched store question per file, and the function from
 * the same resolution any value gets, so a processor written in another
 * module and passed by name is the function that runs.
 *
 * A pattern with a declared binding gets a message-bus unit whose channel
 * is read off the same call. Without one the unit has no boundary of its
 * own and the adapter gives it a function-call binding.
 */

import { ResolutionStore } from "../facts/store.js";
import { declaredChannelOf } from "./declaredChannel.js";
import { callsResolvingTo } from "./importedCalls.js";
import { functionValueOf } from "./resolveValue.js";

import type { CallbackArgumentMatch, DeclaredBinding } from "@suss/extractor";
import type { CallExpression, NewExpression, SourceFile } from "ts-morph";
import type { DiscoveredUnit } from "./shared.js";

export function discoverCallbackArguments(
  sourceFile: SourceFile,
  match: CallbackArgumentMatch,
  kind: string,
  resolution?: ResolutionStore,
  binding?: DeclaredBinding,
): DiscoveredUnit[] {
  const store = resolution ?? new ResolutionStore();
  const units: DiscoveredUnit[] = [];
  for (const call of callsResolvingTo(sourceFile, store, {
    module: match.importModule,
    name: match.importName,
  })) {
    const handed = call.getArguments()[match.callbackPosition];
    if (handed === undefined) {
      continue;
    }
    const func = functionValueOf(handed, store);
    if (func === null) {
      continue;
    }
    units.push(unitFor(call, func, match, kind, store, binding));
  }
  return units;
}

function unitFor(
  call: CallExpression | NewExpression,
  func: NonNullable<DiscoveredUnit["func"]>,
  match: CallbackArgumentMatch,
  kind: string,
  store: ResolutionStore,
  binding: DeclaredBinding | undefined,
): DiscoveredUnit {
  if (binding === undefined) {
    return {
      func,
      kind,
      name: `${match.importName}@${call.getStartLineNumber()}`,
      nameKind: "label",
    };
  }
  const channel = declaredChannelOf(binding.channel, { call }, store);
  return {
    func,
    kind,
    // A label rather than a binding: nothing calls the processor by name.
    name: `${match.importName} ${channel ?? `@${call.getStartLineNumber()}`}`,
    nameKind: "label",
    channelInfo: { messageBus: binding.messageBus, channel },
  };
}
