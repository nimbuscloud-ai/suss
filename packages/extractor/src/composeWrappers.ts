/**
 * composeWrappers.ts: what a unit does once the code registered around
 * it is folded in.
 *
 * A wrapper is a meta-function: it takes a unit and returns a unit. Its
 * summary already says what it does, because the call to its
 * continuation comes through as a `delegate` transition, so one
 * application is the wrapper's short circuits plus its pass-throughs
 * times the wrapped unit's transitions, and a stack is repeated
 * application. The package README works the example through and says
 * what composition does not read.
 */

import {
  readWrapperMetadata,
  withinScope,
  withWrapperMetadata,
} from "@suss/behavioral-ir";

import { MAX_PATHS } from "./paths/enumeratePaths.js";

import type {
  BehavioralSummary,
  Gap,
  Transition,
  WrapperReference,
} from "@suss/behavioral-ir";

/** A wrapper's reference on the wrapped unit, beside the summary it points at. */
interface ResolvedWrapper {
  reference: WrapperReference;
  summary: BehavioralSummary;
}

/** The transitions of one composition step, and whether the budget cut it short. */
interface Composition {
  transitions: Transition[];
  degraded: boolean;
}

const BUDGET_GAP: Gap = {
  type: "unreadOutcome",
  conditions: [],
  consequence: "unknown",
  description: `Composing the wrappers registered around this unit would have gone past the path budget of ${MAX_PATHS}, so what each of them produces is reported beside this unit's own outcomes rather than under the conditions that reach it`,
};

/**
 * Every summary, with the ones that record wrappers replaced by their
 * composition. A summary with no wrappers, and one whose wrappers this
 * run has no summaries for, comes back untouched.
 */
export function composeWrappers(
  summaries: readonly BehavioralSummary[],
): BehavioralSummary[] {
  const byKey = new Map<string, BehavioralSummary>();
  for (const summary of summaries) {
    const key = summaryKey(summary.location.file, summary.identity.name);
    if (!byKey.has(key)) {
      byKey.set(key, summary);
    }
  }

  return summaries.map((summary) => composeOne(summary, byKey));
}

function summaryKey(file: string, name: string): string {
  return `${file}::${name}`;
}

function composeOne(
  summary: BehavioralSummary,
  byKey: ReadonlyMap<string, BehavioralSummary>,
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
    const found = byKey.get(summaryKey(reference.file, reference.name));
    return found === undefined ? [] : [{ reference, summary: found }];
  });
  if (wrappers.length === 0) {
    return narrowed;
  }

  let composition: Composition = {
    transitions: summary.transitions,
    degraded: false,
  };
  // The first registration is the outermost wrapper, so the fold runs
  // from the innermost outwards. An error handler goes on last: it
  // covers what the middleware inside it threw as well.
  for (const wrapper of [...wrappers].reverse()) {
    if (wrapper.reference.onThrow === true) {
      continue;
    }
    composition = merge(composition, applyWrapper(wrapper, composition));
  }
  for (const wrapper of wrappers) {
    if (wrapper.reference.onThrow !== true) {
      continue;
    }
    composition = merge(composition, applyThrowWrapper(wrapper, composition));
  }

  if (composition.transitions === summary.transitions) {
    return narrowed;
  }

  return {
    ...narrowed,
    transitions: withDistinctIds(composition.transitions),
    gaps: composition.degraded ? [...summary.gaps, BUDGET_GAP] : summary.gaps,
  };
}

/** One step's result, keeping the note that an earlier step degraded. */
function merge(before: Composition, step: Composition): Composition {
  return {
    transitions: step.transitions,
    degraded: before.degraded || step.degraded,
  };
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

/**
 * The wrapped unit's transitions with one middleware folded around
 * them: a path that responded before reaching the continuation is an
 * outcome by itself, and each path that reached it gets one composed
 * transition per outcome of the wrapped unit.
 *
 * A wrapper with no `delegate` transition never showed where control
 * passes on, so its outcomes are reported beside the wrapped unit's
 * rather than around them.
 */
function applyWrapper(
  wrapper: ResolvedWrapper,
  inner: Composition,
): Composition {
  const shortCircuits = attribute(
    wrapper.summary.transitions.filter((t) => t.output.type !== "delegate"),
    wrapper.reference,
  );
  const passThroughs = wrapper.summary.transitions.filter(
    (t) => t.output.type === "delegate",
  );

  if (
    passThroughs.length === 0 ||
    shortCircuits.length + passThroughs.length * inner.transitions.length >
      MAX_PATHS
  ) {
    return {
      transitions: [...shortCircuits, ...inner.transitions],
      degraded: passThroughs.length > 0,
    };
  }

  const continued = passThroughs.flatMap((passThrough) =>
    inner.transitions.map((transition) => splice(passThrough, transition)),
  );
  return { transitions: [...shortCircuits, ...continued], degraded: false };
}

/**
 * The same, for a wrapper the framework calls with what the wrapped
 * unit threw. It applies to the paths that ended by throwing, and its
 * own response is what the caller sees instead of the throw.
 */
function applyThrowWrapper(
  wrapper: ResolvedWrapper,
  inner: Composition,
): Composition {
  const thrown = inner.transitions.filter((t) => t.output.type === "throw");
  if (thrown.length === 0) {
    return inner;
  }
  const rest = inner.transitions.filter((t) => t.output.type !== "throw");
  const handled = wrapper.summary.transitions;

  if (rest.length + thrown.length * handled.length > MAX_PATHS) {
    return {
      transitions: [
        ...inner.transitions,
        ...attribute(handled, wrapper.reference),
      ],
      degraded: true,
    };
  }

  const composed = thrown.flatMap((transition) =>
    attribute(
      handled.map((handler) => splice(transition, handler)),
      wrapper.reference,
    ),
  );
  return { transitions: [...rest, ...composed], degraded: false };
}

/**
 * One path through the wrapper joined to one path through what it
 * wraps. The conditions are what both required, in the order they were
 * tested, and the outcome is the inner one's, since the outer path
 * handed control over before producing any of its own.
 */
function splice(outer: Transition, inner: Transition): Transition {
  return {
    ...inner,
    id: `${inner.id}:via:${outer.id}`,
    conditions: [...outer.conditions, ...inner.conditions],
    effects: [...outer.effects, ...inner.effects],
    isDefault: outer.isDefault && inner.isDefault,
  };
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
