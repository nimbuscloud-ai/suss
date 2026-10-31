/**
 * Copies of a summary for the constructions a call's receiver was made at.
 *
 * A method many objects share can read a field its constructor set, as
 * `select(self.model)` does in a repository class every model gets one
 * of. The method has one summary, so the table it reads stays out of the
 * binding and is listed per construction in `containerByConstruction`. A
 * call whose receiver settled on constructions lists them too. Reading
 * the summaries, this copies the callee once for each such construction,
 * fills in the containers that construction gives, and points the call at
 * the copy. A call the copy makes on its own receiver goes to the copy
 * for the same construction, so a route's reach follows one repository
 * all the way down. The copies are never written to a file.
 */

import { namedBinding } from "@suss/ir-core";

import { summaryIdentifier } from "./summaryId.js";

import type { BehavioralSummary, Effect } from "./index.js";

type Invocation = Extract<Effect, { type: "invocation" }>;

/** The summaries with a copy added for each construction a call runs its callee on. */
export function withConstructions(
  summaries: readonly BehavioralSummary[],
): BehavioralSummary[] {
  const byId = new Map(
    summaries.map((summary) => [summaryIdentifier(summary), summary]),
  );
  const copies = new Map<string, BehavioralSummary>();
  const unlinked: { copy: BehavioralSummary; construction: string }[] = [];

  const copyOf = (target: string, construction: string): string | null => {
    const original = byId.get(target);
    if (original === undefined) {
      return null;
    }
    const id = `${target} on ${construction}`;
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
  const ids = made.flatMap((one) => copyOf(target, one) ?? []);
  if (ids.length === 0) {
    return call;
  }
  if (ids.length === 1) {
    return { ...call, summary: ids[0] as string };
  }
  // The receiver is one of several constructions, and only one of them
  // runs, which is what a call that may run any of several functions says.
  const { summary: _single, ...rest } = call;
  return { ...rest, possibleSummaries: ids };
}
