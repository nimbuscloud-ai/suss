/**
 * Indexes providers and interaction effects once, for the per-class
 * pairing passes such as storage, message-bus and runtime-config.
 *
 * Each class pairs by its own rule, so this module does not share the
 * pairing. It shares the two lookups every pass needs: the providers
 * with a given semantics name, and the interaction effects of a given
 * class and semantics name. Building both in one walk means a new
 * pairing pass does not add another walk over every summary.
 */

import { bindingIs } from "@suss/ir-core";

import type { BehavioralSummary, Effect, Semantics } from "@suss/behavioral-ir";

type SemanticsName = Semantics["name"];

/** One interaction effect, with the summary and transition it came from. */
export interface InteractionRecord<TClass extends string> {
  effect: Extract<Effect, { type: "interaction" }> & {
    interaction: { class: TClass };
  };
  summary: BehavioralSummary;
  transitionId: string;
}

/**
 * `providersBySemantics` groups every summary that has a binding by its
 * semantics name, whatever its `kind`. A pass that needs one kind
 * filters for it, as message-bus does to tell `library` providers from
 * `consumer` summaries under the same semantics.
 *
 * `interactionsByClass` groups every interaction effect by
 * `interaction.class` and then by `binding.semantics.name`.
 */
export interface InteractionIndex {
  providersBySemantics: Map<SemanticsName, BehavioralSummary[]>;
  interactionsByClass: Map<
    string,
    Map<SemanticsName, InteractionRecord<string>[]>
  >;
}

/** Build both indexes in one walk over the summaries. */
export function buildInteractionIndex(
  summaries: BehavioralSummary[],
): InteractionIndex {
  const providersBySemantics = new Map<SemanticsName, BehavioralSummary[]>();
  const interactionsByClass = new Map<
    string,
    Map<SemanticsName, InteractionRecord<string>[]>
  >();

  for (const summary of summaries) {
    const semantics = summary.identity.boundaryBinding?.semantics;
    if (semantics !== undefined) {
      const existing = providersBySemantics.get(semantics.name);
      if (existing === undefined) {
        providersBySemantics.set(semantics.name, [summary]);
      } else {
        existing.push(summary);
      }
    }

    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "interaction") {
          continue;
        }
        const klass = effect.interaction.class;
        const sem = effect.binding.semantics.name;
        let byClass = interactionsByClass.get(klass);
        if (byClass === undefined) {
          byClass = new Map();
          interactionsByClass.set(klass, byClass);
        }
        const records = byClass.get(sem);
        const record: InteractionRecord<string> = {
          effect: effect as Extract<Effect, { type: "interaction" }> & {
            interaction: { class: string };
          },
          summary,
          transitionId: transition.id,
        };
        if (records === undefined) {
          byClass.set(sem, [record]);
        } else {
          records.push(record);
        }
      }
    }
  }

  return { providersBySemantics, interactionsByClass };
}

/** The summaries whose binding has this semantics name, or an empty array. */
export function providersOf(
  index: InteractionIndex,
  semanticsName: SemanticsName,
): BehavioralSummary[] {
  return index.providersBySemantics.get(semanticsName) ?? [];
}

/**
 * The interaction records of this class and semantics name, or an
 * empty array. Each class uses one semantics name today, as
 * `storage-access` uses `storage`, but the IR allows a class to pair
 * with several, so the lookup takes both.
 */
export function interactionsOf<TClass extends string>(
  index: InteractionIndex,
  klass: TClass,
  semanticsName: SemanticsName,
): InteractionRecord<TClass>[] {
  const byClass = index.interactionsByClass.get(klass);
  if (byClass === undefined) {
    return [];
  }
  return (byClass.get(semanticsName) ?? []) as InteractionRecord<TClass>[];
}

/**
 * The summaries whose binding has this semantics name, found without an
 * index. A caller with several lookups should build the index and use
 * `providersOf`.
 */
export function findSummariesByBindingSemantics<
  TName extends Semantics["name"],
>(summaries: BehavioralSummary[], semanticsName: TName): BehavioralSummary[] {
  return summaries.filter((s) =>
    bindingIs(s.identity.boundaryBinding, semanticsName),
  );
}

/**
 * The interaction effects of this class, optionally narrowed to one
 * semantics name, found without an index. A caller with several lookups
 * should build the index and use `interactionsOf`.
 */
export function collectInteractions<TClass extends string>(
  summaries: BehavioralSummary[],
  klass: TClass,
  bindingSemanticsName: Semantics["name"] | null = null,
): InteractionRecord<TClass>[] {
  const out: InteractionRecord<TClass>[] = [];
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        if (effect.type !== "interaction") {
          continue;
        }
        if (effect.interaction.class !== klass) {
          continue;
        }
        if (
          bindingSemanticsName !== null &&
          effect.binding.semantics.name !== bindingSemanticsName
        ) {
          continue;
        }
        out.push({
          effect: effect as Extract<Effect, { type: "interaction" }> & {
            interaction: { class: TClass };
          },
          summary,
          transitionId: transition.id,
        });
      }
    }
  }
  return out;
}
