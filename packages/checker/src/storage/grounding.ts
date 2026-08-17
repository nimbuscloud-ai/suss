/**
 * What a storage access reaches when the unit it lives in was told.
 *
 * A storage layer takes the bucket as an argument, so its access says
 * `{location.bucket}`, which says which value to go and ask about. The
 * callers are in the same run, and each call already records which
 * summary it reaches and what it passed, so the answer is a join rather
 * than another walk over source. The README beside this file says what
 * a grounded access pairs as.
 */

import { namePatternFromSub, namesNothing } from "@suss/behavioral-ir";

import type { BehavioralSummary, Effect } from "@suss/behavioral-ir";

/** What a caller passed, in the shape the extractor records arguments. */
type Argument =
  | { kind: "string"; value: string }
  | { kind: "template"; sourceText: string }
  | { kind: "object"; fields: Record<string, unknown> }
  | { kind: string; [key: string]: unknown }
  | null;

export interface Grounding {
  /**
   * The names an access reaches, for an access whose container says
   * only where to look. Empty when nobody calls the unit, or when every
   * caller passes something nobody can settle.
   */
  namesFor(summary: BehavioralSummary, container: string): string[];
}

/** Ground every reference in this set of summaries against its callers. */
export function groundReferences(summaries: BehavioralSummary[]): Grounding {
  const callsInto = new Map<string, Argument[][]>();
  for (const summary of summaries) {
    for (const transition of summary.transitions) {
      for (const effect of transition.effects) {
        const call = invocationInto(effect);
        if (call === null) {
          continue;
        }
        const found = callsInto.get(call.summary) ?? [];
        found.push(call.args);
        callsInto.set(call.summary, found);
      }
    }
  }

  return {
    namesFor(summary, container) {
      const path = referencePath(container);
      const id = summary.identity.id;
      if (path === null || id === undefined) {
        return [];
      }
      const position = inputPosition(summary, path[0] as string);
      if (position === null) {
        return [];
      }
      const names = new Set<string>();
      for (const args of callsInto.get(id) ?? []) {
        const passed = valueAt(args[position] ?? null, path.slice(1));
        const name = passed === null ? null : nameOf(passed);
        if (name !== null) {
          names.add(name);
        }
      }
      return [...names];
    },
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

/**
 * The value a reference asks about, as the parameter it starts at and
 * the fields after it. A container that states a name rather than a
 * reference asks about nothing.
 */
function referencePath(container: string): string[] | null {
  if (!namesNothing(container)) {
    return null;
  }
  const inside = container.slice(1, -1);
  return inside === "" ? null : inside.split(".");
}

/** Which argument fills the parameter a reference starts at. */
function inputPosition(
  summary: BehavioralSummary,
  name: string,
): number | null {
  for (const input of summary.inputs) {
    if (input.type === "parameter" && input.name === name) {
      return input.position;
    }
  }
  return null;
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
