/**
 * Copies of a summary for the constructions a call's receiver was made at.
 *
 * A method many objects share can read a field its constructor set, as
 * `select(self.model)` does in a repository class every model gets one
 * of. The method has one summary, so the table it reads stays out of the
 * binding and is listed per construction in `containerByConstruction`. A
 * call whose receiver settled on constructions lists them too. Reading
 * the summaries, this copies the callee for each construction it reads a
 * table for, itself or through a call on its own receiver, fills in that
 * table, and points the call at the copy. A call the copy makes on its own
 * receiver goes to the copy for the same construction, so a route's reach
 * follows one repository all the way down. No copy is written to a file.
 */

import { namedBinding } from "@suss/ir-core";

import { constructionCopyId, summaryIdentifier } from "./summaryId.js";

import type { BehavioralSummary, Effect } from "./index.js";

type Invocation = Extract<Effect, { type: "invocation" }>;

/**
 * The summaries with a copy added for each construction a call runs its
 * callee on, where the callee does something different on it.
 */
export function withConstructions(
  summaries: readonly BehavioralSummary[],
): BehavioralSummary[] {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const dependsOn = constructionsDependedOn(summaries);
  const copies = new Map<string, BehavioralSummary>();
  const unlinked: { copy: BehavioralSummary; construction: string }[] = [];

  const copyOf = (target: string, construction: string): string | null => {
    const original = byId.get(target);
    if (
      original === undefined ||
      dependsOn.get(target)?.has(construction) !== true
    ) {
      return null;
    }
    const id = constructionCopyId(target, construction);
    if (!copies.has(id)) {
      const copy = onConstruction(original, construction, id);
      copies.set(id, copy);
      unlinked.push({ copy, construction });
    }
    return id;
  };

  const relinked = summaries.map((summary) => withLinks(summary, null, copyOf));
  for (let next = unlinked.pop(); next !== undefined; next = unlinked.pop()) {
    next.copy.transitions = withLinks(
      next.copy,
      next.construction,
      copyOf,
    ).transitions;
  }
  return [...relinked, ...copies.values()];
}

/**
 * Takes the receiver records off every call whose callee does the same
 * thing whichever construction it runs on, so a summary file lists them
 * only where a reader makes a copy from them.
 */
export function dropIdleReceivers(
  summaries: readonly BehavioralSummary[],
): void {
  const dependsOn = constructionsDependedOn(summaries);
  for (const effect of summaries.flatMap(effectsOf)) {
    if (effect.type !== "invocation") {
      continue;
    }
    const depended =
      effect.summary === undefined ? undefined : dependsOn.get(effect.summary);
    if (depended === undefined) {
      delete effect.onOwnReceiver;
    }
    const made = effect.receiverConstructions ?? [];
    if (!made.some((one) => depended?.has(one) === true)) {
      delete effect.receiverConstructions;
    }
  }
}

/**
 * The constructions each summary does something different on, by summary
 * id: those its reads list a table for, and those of every method it
 * calls on its own receiver.
 */
function constructionsDependedOn(
  summaries: readonly BehavioralSummary[],
): Map<string, Set<string>> {
  const depended = new Map<string, Set<string>>();
  const callersOnSelf = new Map<string, string[]>();
  const add = (id: string, construction: string): boolean => {
    const known = depended.get(id) ?? new Set<string>();
    depended.set(id, known);
    const fresh = !known.has(construction);
    known.add(construction);
    return fresh;
  };
  for (const summary of summaries) {
    const id = summaryIdentifier(summary);
    for (const effect of effectsOf(summary)) {
      if (effect.type === "interaction") {
        for (const one of Object.keys(effect.containerByConstruction ?? {})) {
          add(id, one);
        }
      }
      if (
        effect.type === "invocation" &&
        effect.onOwnReceiver === true &&
        effect.summary !== undefined
      ) {
        callersOnSelf.set(effect.summary, [
          ...(callersOnSelf.get(effect.summary) ?? []),
          id,
        ]);
      }
    }
  }
  const queue = [...depended.keys()];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const own = [...(depended.get(id) ?? [])];
    for (const caller of callersOnSelf.get(id) ?? []) {
      const grew = own.map((one) => add(caller, one)).some(Boolean);
      if (grew) {
        queue.push(caller);
      }
    }
  }
  return depended;
}

function effectsOf(summary: BehavioralSummary): Effect[] {
  return summary.transitions.flatMap((transition) => transition.effects);
}

/** A copy of a summary as it runs on an object made at `construction`, with that construction's containers. */
function onConstruction(
  original: BehavioralSummary,
  construction: string,
  id: string,
): BehavioralSummary {
  const copy = structuredClone(original);
  copy.receiverConstruction = construction;
  copy.identity.id = id;
  for (const transition of copy.transitions) {
    transition.effects = transition.effects.map((effect) =>
      withContainerFor(effect, construction),
    );
  }
  return copy;
}

function withContainerFor(effect: Effect, construction: string): Effect {
  if (effect.type !== "interaction") {
    return effect;
  }
  const container = effect.containerByConstruction?.[construction];
  return container === undefined
    ? effect
    : { ...effect, binding: namedBinding(effect.binding, container) };
}

/**
 * The summary with each call that runs its callee on known constructions
 * pointed at the callee's copies. `construction` is the one the summary
 * itself runs on, or null for one that runs on no particular object.
 */
function withLinks(
  summary: BehavioralSummary,
  construction: string | null,
  copyOf: (target: string, construction: string) => string | null,
): BehavioralSummary {
  let changed = false;
  const transitions = summary.transitions.map((transition) => {
    const effects = transition.effects.map((effect) => {
      if (effect.type !== "invocation") {
        return effect;
      }
      const linked = linkedToCopies(effect, construction, copyOf);
      changed ||= linked !== effect;
      return linked;
    });
    return { ...transition, effects };
  });
  return changed ? { ...summary, transitions } : summary;
}

/** The constructions a call's receiver was made at, given the one the caller runs on. */
function receiverConstructionsOf(
  call: Invocation,
  construction: string | null,
): readonly string[] {
  if (construction !== null && call.onOwnReceiver === true) {
    return [construction];
  }
  return call.receiverConstructions ?? [];
}

function linkedToCopies(
  call: Invocation,
  construction: string | null,
  copyOf: (target: string, construction: string) => string | null,
): Invocation {
  const target = call.summary;
  const made = receiverConstructionsOf(call, construction);
  if (target === undefined || made.length === 0) {
    return call;
  }
  // On a construction it does nothing different on, the callee is itself.
  const ids = [...new Set(made.map((one) => copyOf(target, one) ?? target))];
  if (ids.length === 1) {
    return ids[0] === target ? call : { ...call, summary: ids[0] as string };
  }
  // The receiver is one of several constructions, and only one of them
  // runs, which is what a call that may run any of several functions says.
  const { summary: _single, ...rest } = call;
  return { ...rest, possibleSummaries: ids };
}
