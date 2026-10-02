/**
 * Folds the code registered around a unit, such as middleware, into what
 * the unit does.
 *
 * A wrapper is a meta-function: it takes a unit and returns a unit. The
 * call to its continuation comes through as a `delegate` transition, so
 * a path that ends before that call is a response the caller gets
 * instead of the unit's own, and a path that reaches it hands the
 * request on without responding. The responses are added beside the
 * unit's own outcomes. The pass-throughs are dropped, because the unit's
 * outcomes already say what happens on them. This package's DESIGN.md
 * works through an example and lists what composition does not read.
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

  const responses = settledUncaught(respondedInstead(wrappers), wrappers);
  const unitOwn = settledUncaught(summary.transitions, wrappers);
  const own = [...responses, ...unitOwn];
  const handled = handledThrows(wrappers, thrownBy(own));
  const transitions = beside(summary, unitOwn, responses, handled);
  if (!keepGaps) {
    return transitions === summary.transitions
      ? narrowed
      : { ...narrowed, transitions };
  }
  const gaps = withContractStatusGaps(
    summary,
    own,
    everyHandlerOutcome(wrappers),
  );
  if (transitions === summary.transitions && gaps === summary.gaps) {
    return narrowed;
  }
  return { ...narrowed, transitions, gaps };
}

/**
 * The unit's own outcomes with the wrappers' beside them, outermost
 * first. An error handler runs only where a path ends by throwing, in
 * the unit or in a wrapper in front of it.
 */
function beside(
  summary: BehavioralSummary,
  unitOwn: Transition[],
  responses: readonly Transition[],
  handled: readonly Transition[],
): Transition[] {
  if (
    responses.length === 0 &&
    handled.length === 0 &&
    unitOwn === summary.transitions
  ) {
    return summary.transitions;
  }
  return withDistinctIds([...responses, ...unitOwn, ...handled]);
}

/**
 * The transitions with each throw the framework responds to by itself,
 * such as a missing record Rails sends as 404, turned into that response
 * where no error handler on the route catches it. Where a handler only
 * may catch it, the throw and the response both stay. The same array
 * comes back when nothing changed.
 */
function settledUncaught(
  transitions: Transition[],
  wrappers: readonly ResolvedWrapper[],
): Transition[] {
  const handlers = wrappers.filter(
    (wrapper) => wrapper.reference.onThrow === true,
  );
  let changed = false;
  const settled = transitions.flatMap((transition): Transition[] => {
    const { output } = transition;
    if (output.type !== "throw" || output.statusWhenUncaught === undefined) {
      return [transition];
    }

    const caught = caughtOnRoute(handlers, output);
    if (caught === "sure") {
      return [transition];
    }

    changed = true;
    const response: Transition = {
      ...transition,
      output: {
        type: "response",
        statusCode: { type: "literal", value: output.statusWhenUncaught },
        body: null,
        headers: {},
      },
    };
    return caught === "uncertain" ? [transition, response] : [response];
  });
  return changed ? settled : transitions;
}

/** Whether one of the route's error handlers surely catches the throw, may catch it, or cannot. */
function caughtOnRoute(
  handlers: readonly ResolvedWrapper[],
  thrown: Thrown,
): Catch | "no" {
  if (handlers.some((handler) => handler.reference.catches === undefined)) {
    return "sure";
  }
  const matches = handlers.map((handler) =>
    catchMatch(handler.reference, thrown),
  );
  if (matches.includes("yes")) {
    return "sure";
  }
  return matches.includes("maybe") ? "uncertain" : "no";
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

type Thrown = Extract<Transition["output"], { type: "throw" }>;

function thrownBy(transitions: readonly Transition[]): Thrown[] {
  return transitions.flatMap((t) =>
    t.output.type === "throw" ? [t.output] : [],
  );
}

/** Every outcome of every wrapper the framework calls with a throw. */
function everyHandlerOutcome(
  wrappers: readonly ResolvedWrapper[],
): Transition[] {
  return wrappers.flatMap((wrapper) =>
    wrapper.reference.onThrow === true
      ? attribute(wrapper.summary.transitions, wrapper.reference)
      : [],
  );
}

/**
 * What the error handlers that catch one of these throws respond with.
 * A handler that lists no classes catches any throw. One that may catch
 * a throw, and may not, has each outcome marked as such.
 */
function handledThrows(
  wrappers: readonly ResolvedWrapper[],
  thrown: readonly Thrown[],
): Transition[] {
  const caught = catchesAny(wrappers, thrown);
  return wrappers.flatMap((wrapper) => {
    const how = caught.get(wrapper);
    return how === undefined
      ? []
      : attribute(
          wrapper.summary.transitions,
          wrapper.reference,
          how === "uncertain",
        );
  });
}

type Catch = "sure" | "uncertain";

function catchesAny(
  wrappers: readonly ResolvedWrapper[],
  thrown: readonly Thrown[],
): Map<ResolvedWrapper, Catch> {
  const caught = new Map<ResolvedWrapper, Catch>();
  if (thrown.length === 0) {
    return caught;
  }

  const handlers = wrappers.filter(
    (wrapper) => wrapper.reference.onThrow === true,
  );
  for (const handler of handlers) {
    if (handler.reference.catches === undefined) {
      caught.set(handler, "sure");
    }
  }

  const listing = handlers.filter(
    (handler) => handler.reference.catches !== undefined,
  );
  for (const one of thrown) {
    for (const [handler, how] of catchersOf(listing, one)) {
      if (caught.get(handler) !== "sure") {
        caught.set(handler, how);
      }
    }
  }
  return caught;
}

/**
 * The handlers that may catch one throw, tried in the order they are
 * listed. The first that surely catches it ends the search, and is
 * itself uncertain when a handler tried before it may catch the throw.
 */
function catchersOf(
  handlers: readonly ResolvedWrapper[],
  thrown: Thrown,
): Array<[ResolvedWrapper, Catch]> {
  const found: Array<[ResolvedWrapper, Catch]> = [];
  for (const handler of handlers) {
    const match = catchMatch(handler.reference, thrown);
    if (match === "yes") {
      found.push([handler, found.length === 0 ? "sure" : "uncertain"]);
      return found;
    }

    if (match === "maybe") {
      found.push([handler, "uncertain"]);
    }
  }
  return found;
}

/** Whether a handler registered for some classes catches this throw. */
function catchMatch(
  reference: WrapperReference,
  thrown: Thrown,
): "yes" | "maybe" | "no" {
  const ancestors = thrown.exceptionAncestors;
  if (thrown.exceptionType === null || ancestors === undefined) {
    return "maybe";
  }
  const classes = new Set([thrown.exceptionType, ...ancestors]);
  if ((reference.catches ?? []).some((name) => classes.has(name))) {
    return "yes";
  }
  const unread =
    thrown.ancestryIncomplete === true &&
    reference.mayCatchUnreadClasses === true;
  return unread || reference.mayCatchAny === true ? "maybe" : "no";
}

/**
 * The unit's gaps with the declared-contract comparison redone over the
 * composed transitions. The first comparison ran over the handler's own
 * body before anything around it was read, so a 401 that the contract
 * declares and the middleware produces shows up there as never produced.
 * Running the same comparison over the uncomposed transitions gives those
 * earlier gaps back, so they can be removed without parsing descriptions.
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

/** Marks each outcome with the wrapper that produced it. */
function attribute(
  transitions: readonly Transition[],
  reference: WrapperReference,
  catchUncertain = false,
): Transition[] {
  return transitions.map((transition) => ({
    ...transition,
    metadata: withWrapperMetadata(transition.metadata, {
      from: reference,
      ...(catchUncertain ? { catchUncertain } : {}),
    }),
  }));
}

/**
 * The same transitions with any repeated id made unique, since a reader
 * keying on one would otherwise lose all but the last. Ids repeat when
 * two wrappers in different files share a name.
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
