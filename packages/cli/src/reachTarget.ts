/**
 * Where a reach question ends, worked out from what the user typed.
 *
 * The call facts and the reach rules live in `@suss/checker`, so any
 * caller can ask a reach question. Turning a spelling into target
 * functions goes through the same resolver `--at` uses, which is why it
 * stays with the commands.
 */

import {
  BOUNDARY_ROLE,
  boundaryKey,
  summaryIdentifier,
} from "@suss/behavioral-ir";
import {
  reachTargetOfTouches,
  reachTargetOfUnits,
  representativeUnit,
  writtenFunctionOf,
} from "@suss/checker";

import { resolveTarget } from "./target.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { CallFacts, FunctionKey, ReachTarget } from "@suss/checker";
import type { ResolvedTarget, TargetKind } from "./target.js";

export type SpelledFunctions =
  | {
      found: true;
      target: ReachTarget;
      /** The subject's label in the answer. */
      label: string;
      /** What the spelling matched: a file, a unit, a boundary and so on, or `name` for a bare function name. */
      matched: TargetKind | "name";
      /** The units the spelling picked out, empty for a boundary. */
      units: ReadonlyArray<BehavioralSummary>;
      /**
       * Summaries read from a spec that declare the boundary the picked
       * code serves, as a schema file declares a resolver's field. The
       * name matched them too, and they were left out of the target.
       */
      alsoDeclaredBy?: ReadonlyArray<BehavioralSummary>;
    }
  | { found: false; headline: string };

/**
 * The functions a spelling matches, and the exports they provide. A
 * boundary spelling matches the export itself, so a caller bound to it
 * counts even when no summary provides it. A bare name that matches
 * several functions is rejected, and the headline lists them.
 */
export function functionsSpelled(
  spec: string,
  summaries: ReadonlyArray<BehavioralSummary>,
  facts: CallFacts,
): SpelledFunctions {
  const resolution = resolveTarget(spec, summaries);
  if (resolution.matched && resolution.target.kind === "boundary") {
    return {
      found: true,
      target: reachTargetOf(resolution.target),
      label: resolution.target.touches[0]?.touched.label ?? spec,
      matched: "boundary",
      units: [],
    };
  }

  const units = resolution.matched
    ? resolution.target.summaries
    : summaries.filter(
        (summary) =>
          summary.identity.name === spec ||
          summary.identity.name.endsWith(`.${spec}`),
      );
  if (units.length === 0) {
    return {
      found: false,
      headline: `No summary here is ${spec}. Spell the unit as a file, a summary id, or its function name.`,
    };
  }

  const byName = !resolution.matched || resolution.target.kind === "summary";
  const declared = byName ? codeBehindSpecs(units) : null;
  const picked = declared?.code ?? units;
  const written = writtenFunctions(picked);
  const writtenSet = new Set(written);
  // A call into a copy of one of these is a call into it too.
  const copies = summaries.filter(
    (summary) =>
      summary.receiverConstruction !== undefined &&
      writtenSet.has(writtenFunctionOf(summary)),
  );
  const target = reachTargetOfUnits([...new Set([...picked, ...copies])]);
  if (byName && written.length > 1) {
    const candidates = written.map((fn) =>
      summaryIdentifier(representativeUnit(facts, fn)),
    );
    return {
      found: false,
      headline: `${spec} could mean ${written.length} functions here: ${candidates.join(", ")}. Ask about one of them.`,
    };
  }

  return {
    found: true,
    target,
    label:
      written.length === 1
        ? summaryIdentifier(representativeUnit(facts, written[0]))
        : spec,
    matched: resolution.matched ? resolution.target.kind : "name",
    units: picked,
    ...(declared === null ? {} : { alsoDeclaredBy: declared.specs }),
  };
}

/**
 * The code among units a name matched, when the rest were read from a
 * spec that declares the boundary the code serves, as a schema file
 * declares the field a resolver serves. Null unless the code is one
 * function and every unit provides the same boundary.
 */
function codeBehindSpecs(units: ReadonlyArray<BehavioralSummary>): {
  code: BehavioralSummary[];
  specs: BehavioralSummary[];
} | null {
  const specs = units.filter(readFromSpec);
  const code = units.filter((unit) => !readFromSpec(unit));
  if (
    specs.length === 0 ||
    code.length === 0 ||
    writtenFunctions(code).length !== 1
  ) {
    return null;
  }
  const keys = new Set(units.map(providedKey));
  return keys.size === 1 && !keys.has(null) ? { code, specs } : null;
}

/** Contract readers mark what they read from a spec as derived, and no adapter does. */
function readFromSpec(unit: BehavioralSummary): boolean {
  return unit.confidence.source === "derived";
}

function providedKey(unit: BehavioralSummary): string | null {
  const binding = unit.identity.boundaryBinding;
  return binding === null || BOUNDARY_ROLE[unit.kind] !== "provider"
    ? null
    : boundaryKey(binding);
}

/**
 * The functions as written that these units are summaries of. A copy of
 * a method for one construction of its receiver is the method itself
 * here, so a name that matches a method and its copies is not ambiguous.
 * Every copy has an original, which the call facts key the same way.
 */
function writtenFunctions(
  units: ReadonlyArray<BehavioralSummary>,
): FunctionKey[] {
  return [...new Set(units.map(writtenFunctionOf))];
}

/**
 * Where a reach question ends. A function reaches a boundary by touching
 * it or by calling into the unit that serves it, and reaches a unit by
 * calling it. A caller bound to a function-call boundary is linked by
 * that binding. Any other unit that touches the boundary counts as at it.
 */
export function reachTargetOf(target: ResolvedTarget): ReachTarget {
  if (target.kind !== "boundary") {
    return reachTargetOfUnits(target.summaries);
  }
  return reachTargetOfTouches(target.touches);
}
