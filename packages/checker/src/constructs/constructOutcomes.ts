/**
 * What a construct touches and how it can fail, read from its own
 * summaries.
 *
 * The kind a construct prints is the class of effect it has, never a
 * word taken from its name. A pack's summary of a function reads its
 * paths, where the summary reach built has one path, so the outcomes
 * come from the pack's summary whenever there is one.
 */

import { BOUNDARY_ROLE } from "@suss/behavioral-ir";

import { functionOf } from "../calls/callFacts.js";

import type {
  BehavioralSummary,
  Predicate,
  TypeShape,
} from "@suss/behavioral-ir";
import type { CallFacts } from "../calls/callFacts.js";

/** The class of boundary a construct touches, or `wrapper` for one that adds outcomes to the units it wraps. */
export interface EffectClass {
  class:
    | "service-call"
    | "storage-access"
    | "message-send"
    | "config-read"
    | "wrapper";
  /** The packs or recognizers that read it, as the summaries record them. */
  recognition: string[];
  /** Set when the construct touches it only through functions it calls. */
  throughHelpers?: true;
}

export type UsageOutcome =
  | { kind: "throws"; type: string | null }
  | { kind: "returnsNothing" }
  | { kind: "responds"; status: number; conditions: Predicate[] };

type TouchedClass = Exclude<EffectClass["class"], "wrapper">;

/** The class of a unit's own binding, for a unit bound to a boundary it calls. */
const OWN_BINDING_CLASS: Record<string, TouchedClass | undefined> = {
  rest: "service-call",
  graphql: "service-call",
  storage: "storage-access",
  "message-bus": "message-send",
  "runtime-config": "config-read",
};

const INTERACTION_CLASS: Record<string, TouchedClass | undefined> = {
  "service-call": "service-call",
  "storage-access": "storage-access",
  "message-send": "message-send",
  "config-read": "config-read",
};

const CLASS_ORDER: readonly EffectClass["class"][] = [
  "wrapper",
  "service-call",
  "storage-access",
  "message-send",
  "config-read",
];

export function effectClassesOf(
  units: readonly BehavioralSummary[],
  facts: CallFacts,
): EffectClass[] {
  const own = classesTouchedBy(units);
  const reached = classesTouchedBy(
    [...facts.reachedFrom(units.map(functionOf)).keys()].flatMap(
      (fn) => facts.units.get(fn) ?? [],
    ),
  );
  const found = new Map<EffectClass["class"], EffectClass>();
  if (units.some(addsOutcomes)) {
    found.set("wrapper", { class: "wrapper", recognition: [] });
  }
  for (const [name, recognition] of own) {
    found.set(name, { class: name, recognition: [...recognition].sort() });
  }
  for (const [name, recognition] of reached) {
    if (!found.has(name)) {
      found.set(name, {
        class: name,
        recognition: [...recognition].sort(),
        throughHelpers: true,
      });
    }
  }
  return CLASS_ORDER.flatMap((name) => {
    const one = found.get(name);
    return one === undefined ? [] : [one];
  });
}

function classesTouchedBy(
  units: readonly BehavioralSummary[],
): Map<TouchedClass, Set<string>> {
  const found = new Map<TouchedClass, Set<string>>();
  const note = (name: TouchedClass | undefined, recognition: string) => {
    if (name === undefined) {
      return;
    }
    const set = found.get(name) ?? new Set<string>();
    set.add(recognition);
    found.set(name, set);
  };
  for (const unit of units) {
    const binding = unit.identity.boundaryBinding;
    if (binding !== null && BOUNDARY_ROLE[unit.kind] === "consumer") {
      note(OWN_BINDING_CLASS[binding.semantics.name], binding.recognition);
    }
    for (const transition of unit.transitions) {
      for (const effect of transition.effects) {
        if (effect.type === "interaction") {
          note(
            INTERACTION_CLASS[effect.interaction.class],
            effect.binding.recognition,
          );
        }
      }
    }
  }
  return found;
}

/** A filter, middleware or dependency that sends the response itself on some path, instead of the unit it wraps. */
function addsOutcomes(unit: BehavioralSummary): boolean {
  return (
    unit.kind === "middleware" &&
    unit.transitions.some((transition) => transition.output.type === "response")
  );
}

/** The ways the construct can fail, from the pack's summary when there is one. */
export function constructOutcomes(
  units: readonly BehavioralSummary[],
): UsageOutcome[] {
  const recognized = units.filter((unit) => unit.kind !== "library");
  const read = recognized.length > 0 ? recognized : units;
  const seen = new Set<string>();
  const outcomes: UsageOutcome[] = [];
  for (const unit of read) {
    for (const transition of unit.transitions) {
      const outcome = failureOf(transition);
      if (outcome === null) {
        continue;
      }
      const key = JSON.stringify(outcome);
      if (!seen.has(key)) {
        seen.add(key);
        outcomes.push(outcome);
      }
    }
  }
  return outcomes;
}

function failureOf(
  transition: BehavioralSummary["transitions"][number],
): UsageOutcome | null {
  const output = transition.output;
  if (output.type === "throw") {
    return { kind: "throws", type: output.exceptionType };
  }
  if (output.type === "return") {
    return returnsNothing(output.value) ? { kind: "returnsNothing" } : null;
  }
  if (output.type !== "response" || output.statusCode?.type !== "literal") {
    return null;
  }
  const status = Number(output.statusCode.value);
  return status >= 300
    ? { kind: "responds", status, conditions: transition.conditions }
    : null;
}

/** A return the source writes as nil, None or null, which a caller has to check for. */
function returnsNothing(value: TypeShape | null): boolean {
  if (value === null) {
    return false;
  }
  return (
    value.type === "null" || (value.type === "literal" && value.value === null)
  );
}
