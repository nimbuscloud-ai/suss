/**
 * composeWrappers.ts: what a unit does once the code registered around
 * it is folded in.
 *
 * A wrapper is a meta-function: it takes a unit and returns a unit. The
 * call to its continuation comes through as a `delegate` transition, so
 * a path that ends before that call is a response the caller gets
 * instead of the unit's own, and a path that reaches it hands the
 * request on without responding. The responses go beside the unit's own
 * outcomes and the pass-throughs go nowhere, because the unit's
 * outcomes already say what happens on them. The package README works
 * the example through and says what composition does not read.
 */

import {
  exchangesHttpResponses,
  readHttpMetadata,
  readWrapperMetadata,
  withinScope,
  withWrapperMetadata,
  wrapperFor,
  wrapperIndex,
} from "@suss/behavioral-ir";

import { contractStatusGaps } from "./contractStatusGaps.js";

import type {
  BehavioralSummary,
  Gap,
  Transition,
  WrapperIndex,
  WrapperReference,
} from "@suss/behavioral-ir";

/**
 * Whether to keep gaps at all. A run that asked for none has none on
 * the summaries coming in, and composition adds none either.
 */
export interface ComposeOptions {
  gapHandling?: "strict" | "permissive" | "silent";
}

/** A wrapper's reference on the wrapped unit, beside the summary it points at. */
interface ResolvedWrapper {
  reference: WrapperReference;
  summary: BehavioralSummary;
}

/**
 * Every summary, with the ones that record wrappers replaced by their
 * composition. A summary with no wrappers, and one whose wrappers this
 * run has no summaries for, comes back untouched.
 */
export function composeWrappers(
  summaries: readonly BehavioralSummary[],
  options: ComposeOptions = {},
): BehavioralSummary[] {
  const chain = wrapperIndex(summaries);
  const keepGaps = options.gapHandling !== "silent";
  return summaries.map((summary) => composeOne(summary, chain, keepGaps));
}

function composeOne(
  summary: BehavioralSummary,
  chain: WrapperIndex,
  keepGaps: boolean,
): BehavioralSummary {
  const recorded = readWrapperMetadata(summary);
  const applied = recorded?.applied ?? [];
  const covering = applied.filter((reference) =>
    coversUnit(reference, summary),
  );
  // A registration whose pattern this unit's path never matches is not
  // one of its wrappers, so it goes from the list a reader is shown as
  // well as from the composition.
  const narrowed =
    covering.length === applied.length
      ? summary
      : {
          ...summary,
          metadata: withWrapperMetadata(summary.metadata, {
            applied: covering,
          }),
        };

  const wrappers = covering.flatMap((reference): ResolvedWrapper[] => {
    const found = wrapperFor(chain, reference);
    return found === undefined ? [] : [{ reference, summary: found }];
  });
  if (wrappers.length === 0) {
    return narrowed;
  }

  const responses = respondedInstead(wrappers);
  const handled = handledThrows(wrappers);
  const transitions = beside(summary, responses, handled);
  if (!keepGaps) {
    return transitions === summary.transitions
      ? narrowed
      : { ...narrowed, transitions };
  }
  const gaps = withContractStatusGaps(
    summary,
    [...responses, ...summary.transitions],
    handled,
  );
  if (transitions === summary.transitions && gaps === summary.gaps) {
    return narrowed;
  }
  return { ...narrowed, transitions, gaps };
}

/**
 * The unit's own outcomes with the wrappers' beside them, outermost
 * first. An error handler runs only where a path ends by throwing.
 */
function beside(
  summary: BehavioralSummary,
  responses: readonly Transition[],
  handled: readonly Transition[],
): Transition[] {
  const throws = summary.transitions.some((t) => t.output.type === "throw");
  const onThrow = throws ? handled : [];
  if (responses.length === 0 && onThrow.length === 0) {
    return summary.transitions;
  }
  return withDistinctIds([...responses, ...summary.transitions, ...onThrow]);
}

/**
 * What each wrapper responds with instead of handing the request on. A
 * pass-through is left out: the unit's own outcomes already say what
 * happens once the request gets through, and what the wrapper did on
 * the way is in the summary the chain points at.
 */
function respondedInstead(wrappers: readonly ResolvedWrapper[]): Transition[] {
  return wrappers.flatMap((wrapper) =>
    wrapper.reference.onThrow === true
      ? []
      : attribute(
          wrapper.summary.transitions.filter(
            (t) => t.output.type !== "delegate",
          ),
          wrapper.reference,
        ),
  );
}

/** What the wrappers the framework calls with a throw respond with. */
function handledThrows(wrappers: readonly ResolvedWrapper[]): Transition[] {
  return wrappers.flatMap((wrapper) =>
    wrapper.reference.onThrow === true
      ? attribute(wrapper.summary.transitions, wrapper.reference)
      : [],
  );
}

/**
 * The unit's gaps with the declared-contract comparison redone over the
 * composed transitions. The comparison first ran over the handler's own
 * body, before anything around it was read, so a 401 the contract
 * declares and the middleware produces was reported as never produced.
 * The earlier gaps are the ones the same comparison gives for the
 * uncomposed transitions, so they can be taken out without parsing.
 *
 * An error handler's outcomes count as produced whether or not a path
 * through the handler was seen to throw, since anything the handler
 * calls can throw at runtime and the error handler responds for it.
 */
function withContractStatusGaps(
  summary: BehavioralSummary,
  composed: readonly Transition[],
  handled: readonly Transition[],
): Gap[] {
  const contract = readHttpMetadata(summary)?.declaredContract;
  const binding = summary.identity.boundaryBinding;
  if (
    contract === undefined ||
    (binding !== null && !exchangesHttpResponses(binding))
  ) {
    return summary.gaps;
  }
  const declared = {
    framework: contract.framework ?? "declared",
    responses: contract.responses,
  };
  const stale = new Set(
    contractStatusGaps(declared, summary.transitions).map(gapKey),
  );
  const gaps = [
    ...summary.gaps.filter((gap) => !stale.has(gapKey(gap))),
    ...contractStatusGaps(declared, [...composed, ...handled]),
  ];
  const unchanged =
    gaps.length === summary.gaps.length &&
    gaps.every((gap, i) => gapKey(gap) === gapKey(summary.gaps[i] as Gap));
  return unchanged ? summary.gaps : gaps;
}

function gapKey(gap: Gap): string {
  return `${gap.type}|${gap.description}`;
}

/**
 * Whether this registration reaches this unit. A wrapper registered
 * with a pattern runs only for the boundaries inside it, and a unit
 * whose own boundary cannot be shown to be one of them is left out
 * rather than assumed in.
 */
function coversUnit(
  reference: WrapperReference,
  summary: BehavioralSummary,
): boolean {
  if (reference.scope === undefined) {
    return true;
  }
  const binding = summary.identity.boundaryBinding;
  return binding !== null && withinScope(binding, reference.scope);
}

/** Say which wrapper produced each of these outcomes. */
function attribute(
  transitions: readonly Transition[],
  reference: WrapperReference,
): Transition[] {
  return transitions.map((transition) => ({
    ...transition,
    metadata: withWrapperMetadata(transition.metadata, { from: reference }),
  }));
}

/**
 * The same transitions with any repeated id made unique, since a reader
 * keying on one would otherwise lose all but the last. Two wrappers of
 * the same name in different files is what gets here.
 */
function withDistinctIds(transitions: readonly Transition[]): Transition[] {
  const seen = new Map<string, number>();
  return transitions.map((transition) => {
    const taken = seen.get(transition.id);
    seen.set(transition.id, (taken ?? 0) + 1);
    return taken === undefined
      ? transition
      : { ...transition, id: `${transition.id}#${taken + 1}` };
  });
}
