// dispatcher.ts — shared indexing for per-class interaction pairing
// passes (storage, message-bus, runtime-config, future RPC).
//
// The actual PAIRING rules differ per class:
//   - storage-relational: binding equality on (storageSystem, scope, table)
//   - message-bus:        binding equality after env-var → CFN-resource collapse
//   - runtime-config:     env-var-name equality + codeScope file-prefix match
// — so this file doesn't try to unify the pairing. It only shares the
// two ingredients every per-class checker needs:
//
//   1. Enumerate provider summaries by binding.semantics.name
//   2. Walk transition.effects for interaction effects of a given
//      class + binding semantics
//
// Per-class checkers consume these helpers and apply their own pairing
// + finding-generation logic. This keeps the per-class logic
// self-contained while removing the boilerplate every new class would
// otherwise duplicate.
//
// The indexes are built in ONE walk (not N walks per pass). On a
// project with ~thousand summaries the difference is small in
// absolute terms, but it scales linearly with the number of pairing
// passes — adding new classes (Drizzle, Redis, k8s, etc.) doesn't
// add another walk.

import type { BehavioralSummary, Effect, Semantics } from "@suss/behavioral-ir";

type SemanticsName = Semantics["name"];

/**
 * One interaction effect, paired with the summary + transition it
 * lives on. Per-class checkers consume these as the "consumer side"
 * input to their finding generators.
 */
export interface InteractionRecord<TClass extends string> {
  effect: Extract<Effect, { type: "interaction" }> & {
    interaction: { class: TClass };
  };
  summary: BehavioralSummary;
  transitionId: string;
}

/**
 * Pre-built indexes over a summary set:
 *   - `providersBySemantics`: provider summaries grouped by their
 *     identity binding's semantics name (e.g. all storage-relational
 *     providers, all message-bus providers, etc.). Includes every
 *     summary with a binding regardless of `kind` — per-class
 *     checkers further filter by kind when needed (message-bus
 *     distinguishes `library` providers from `consumer` summaries
 *     under the same semantics).
 *   - `interactionsByClass`: every interaction effect found in the
 *     summary set, grouped first by `interaction.class`, then by
 *     `binding.semantics.name`. Lets per-class checkers query
 *     `interactionsByClass.get("storage-access")?.get("storage-relational")`
 *     to get the slice they care about without re-walking.
 *
 * Built in one pass over the summary set; reused by every per-class
 * checker that wants to consume providers or interaction effects.
 */
export interface InteractionIndex {
  providersBySemantics: Map<SemanticsName, BehavioralSummary[]>;
  interactionsByClass: Map<
    string,
    Map<SemanticsName, InteractionRecord<string>[]>
  >;
}

/**
 * Build the indexes in one pass over the summary set. Per-class
 * checkers consume slices via the lookup helpers below.
 */
export function buildInteractionIndex(
  summaries: BehavioralSummary[],
): InteractionIndex {
  const providersBySemantics = new Map<SemanticsName, BehavioralSummary[]>();
  const interactionsByClass = new Map<
    string,
    Map<SemanticsName, InteractionRecord<string>[]>
  >();

  for (const summary of summaries) {
    // Provider index — bucket by binding's semantics name.
    const semantics = summary.identity.boundaryBinding?.semantics;
    if (semantics !== undefined) {
      const existing = providersBySemantics.get(semantics.name);
      if (existing === undefined) {
        providersBySemantics.set(semantics.name, [summary]);
      } else {
        existing.push(summary);
      }
    }

    // Interaction-effect index — bucket by class + binding semantics name.
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

/**
 * Lookup helper — returns the providers whose binding semantics name
 * matches. Returns an empty array (not undefined) when no providers
 * of that name exist; lets per-class checkers iterate without a
 * presence check.
 */
export function providersOf(
  index: InteractionIndex,
  semanticsName: SemanticsName,
): BehavioralSummary[] {
  return index.providersBySemantics.get(semanticsName) ?? [];
}

/**
 * Lookup helper — returns the interaction records of the given class
 * AND binding semantics name. Returns an empty array when no records
 * match.
 *
 * The two-key lookup (class + semantics) is intentional: in v0 the
 * pairing is 1:1 between class and semantics name (e.g. "storage-access"
 * always uses "storage-relational" semantics), but the IR allows future
 * classes to be paired with multiple semantics types — the second key
 * keeps that option open without locking the dispatcher to today's 1:1
 * convention.
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

// ---------------------------------------------------------------------------
// Backward-compat helpers (keep old call sites green during migration)
// ---------------------------------------------------------------------------

/**
 * Filter summaries to those whose identity binding has the given
 * semantics name. Builds a one-shot index internally — call sites
 * with multiple lookups should use `buildInteractionIndex` +
 * `providersOf` directly.
 */
export function findSummariesByBindingSemantics<
  TName extends Semantics["name"],
>(summaries: BehavioralSummary[], semanticsName: TName): BehavioralSummary[] {
  return summaries.filter(
    (s) => s.identity.boundaryBinding?.semantics.name === semanticsName,
  );
}

/**
 * Walk every transition's effects and collect interaction effects of
 * the given class + binding semantics. Builds a one-shot pass
 * internally — call sites with multiple lookups should use
 * `buildInteractionIndex` + `interactionsOf` directly.
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
