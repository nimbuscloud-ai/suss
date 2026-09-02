/**
 * What a storage access reaches when the unit it lives in was told.
 *
 * A storage layer takes the bucket as an argument, so its access says
 * `{location.bucket}`, which says which value to go and ask about. The
 * callers are in the same run, and each call already records which
 * summary it reaches and what it passed, so the answer is a join rather
 * than another walk over source.
 *
 * The other half is `{SOME_TABLE}`, a variable the deployment sets
 * rather than an argument anybody passes, and the runtime that runs the
 * code is where that answer comes from. The pairing pass classifies
 * the container through the one boundary-name parser and hands the
 * reference over, so nothing here reads the string again.
 */

import {
  deployedValues,
  namePatternFromSub,
  parameterNamed,
  summaryIdentifier,
  variableAsked,
} from "@suss/behavioral-ir";

import type { BehavioralSummary, Effect, Reference } from "@suss/behavioral-ir";

/** What a caller passed, in the shape the extractor records arguments. */
type Argument =
  | { kind: "string"; value: string }
  | { kind: "template"; sourceText: string }
  | { kind: "object"; fields: Record<string, unknown> }
  | { kind: string; [key: string]: unknown }
  | null;

/** A name a reference reaches, and the summary that supplied it. */
export interface GroundedName {
  name: string;
  /**
   * The runtime whose configuration sets the variable, or the caller
   * that passed the value.
   */
  source: BehavioralSummary;
  /** Which of the two the source is. */
  role: "runtime" | "caller";
}

export interface Grounding {
  /**
   * The names an access reaches, for an access whose container says
   * only where to look. Empty when nobody calls the unit, when every
   * caller passes something nobody can settle, or when the reference
   * itself is null because a part of it was missing.
   */
  namesFor(summary: BehavioralSummary, reference: Reference | null): string[];
  /** The same names, each with the summary that supplied it. */
  groundedNamesFor(
    summary: BehavioralSummary,
    reference: Reference | null,
  ): GroundedName[];
  /**
   * What would ground a reference: the variable whose deployed value
   * settles it, or null when a caller's argument would.
   */
  variableFor(
    summary: BehavioralSummary,
    reference: Reference | null,
  ): string | null;
}

/** One call a summary received, and who made it. */
interface ReceivedCall {
  caller: BehavioralSummary;
  args: Argument[];
}

/**
 * Ground every reference in this set of summaries, against its callers
 * and against the configuration of the runtime that runs it.
 */
export function groundReferences(summaries: BehavioralSummary[]): Grounding {
  const configured = configuredNames(summaries);
  const callsInto = new Map<string, ReceivedCall[]>();
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        const call = invocationInto(effect);
        if (call === null) {
          continue;
        }
        const found = callsInto.get(call.summary) ?? [];
        found.push({ caller: summary, args: call.args });
        callsInto.set(call.summary, found);
      }
    }
  }

  const groundedNamesFor = (
    summary: BehavioralSummary,
    reference: Reference | null,
  ): GroundedName[] => {
    if (reference === null) {
      return [];
    }
    const found: GroundedName[] = [];
    const seen = new Set<string>();
    for (const grounded of [
      ...configured(summary, reference),
      ...callerNames(summary, reference, callsInto),
    ]) {
      const key = `${grounded.name}\u0000${summaryIdentifier(grounded.source)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      found.push(grounded);
    }
    return found;
  };

  return {
    groundedNamesFor,
    namesFor(summary, reference) {
      return [
        ...new Set(
          groundedNamesFor(summary, reference).map((grounded) => grounded.name),
        ),
      ];
    },
    variableFor(summary, reference) {
      if (reference === null) {
        return null;
      }
      return variableAsked(summary, reference);
    },
  };
}

/** The names a reference reaches through whoever called the unit. */
function callerNames(
  summary: BehavioralSummary,
  reference: Reference,
  callsInto: ReadonlyMap<string, ReceivedCall[]>,
): GroundedName[] {
  const id = summary.identity.id;
  if (id === undefined) {
    return [];
  }
  const parameter = parameterNamed(summary, reference.root);
  if (parameter === null) {
    return [];
  }
  const names: GroundedName[] = [];
  for (const call of callsInto.get(id) ?? []) {
    const passed = valueAt(
      call.args[parameter.position] ?? null,
      reference.fields,
    );
    const name = passed === null ? null : nameOf(passed);
    if (name !== null) {
      names.push({ name, source: call.caller, role: "caller" });
    }
  }
  return names;
}

/**
 * What a variable is set to, for the runtimes that run a given summary.
 *
 * The same code deployed twice reads two values, and both count, so a
 * Worker sharing a module between staging and production pairs against
 * each store it addresses.
 */
function configuredNames(
  summaries: BehavioralSummary[],
): (summary: BehavioralSummary, reference: Reference) => GroundedName[] {
  const setTo = deployedValues(summaries);

  return (summary, reference) => {
    const variable = variableAsked(summary, reference);
    if (variable === null) {
      return [];
    }
    return setTo(summary, variable).map((found) => ({
      name: found.value,
      source: found.source,
      role: "runtime" as const,
    }));
  };
}

/** The call this effect is, when it says which summary it reaches. */
function invocationInto(
  effect: Effect,
): { summary: string; args: Argument[] } | null {
  if (effect.type !== "invocation" || effect.summary === undefined) {
    return null;
  }
  return { summary: effect.summary, args: effect.args as Argument[] };
}

/** The part of an argument a reference's fields point at. */
function valueAt(argument: Argument, fields: string[]): Argument {
  let found = argument;
  for (const field of fields) {
    if (found === null || found.kind !== "object") {
      return null;
    }
    found = ((found.fields as Record<string, Argument>) ?? {})[field] ?? null;
  }
  return found;
}

/**
 * The name an argument states. A template states a pattern, the same
 * way a name built from a stage prefix does anywhere else. An argument
 * that names another value says where to look again rather than what
 * the name is, and grounding that is somebody else's call site.
 */
function nameOf(argument: Argument): string | null {
  if (argument === null) {
    return null;
  }
  if (argument.kind === "string" && typeof argument.value === "string") {
    return argument.value;
  }
  if (argument.kind === "template" && typeof argument.sourceText === "string") {
    return namePatternFromSub(argument.sourceText.replace(/^`|`$/g, ""));
  }
  return null;
}
