/**
 * Where a boundary name with a hole in it gets filled in.
 *
 * `deployedValues` handles a variable set to a string, and
 * `deployedRefs` handles one set to a resource. `deploymentOf` puts a
 * `Deployment` in front of both, so a protocol can look a reference up
 * without knowing which kind it is. The pairing pass, the drafter that
 * writes an intent document and the intent checker that reads one back
 * all go through here.
 *
 * The rule for which variable a reference points at, `variableAsked`,
 * is defined here once so no two callers can disagree about it.
 */

import { deployedRefs } from "./deployedRefs.js";
import { deployedValues } from "./deployedValues.js";
import { deploymentScope } from "./deploymentScope.js";

import type { Deployment, Reference } from "@suss/ir-core";
import type { BehavioralSummary } from "../index.js";

/** The role a pack gives the parameter a runtime's configuration is passed in. */
const CONFIG_ROLE = "config";

/**
 * A `Deployment` for each unit, built once for a set of summaries.
 *
 * Lookups are per unit because two services in one repository can both
 * set `API_BASE`, and only the unit shows which value applies.
 */
export function deploymentOf(
  summaries: BehavioralSummary[],
): (code: BehavioralSummary) => Deployment {
  // Both lookups share one placement, so the module graph is walked once.
  const scope = deploymentScope(summaries);
  const setTo = deployedValues(summaries, scope);
  const pointsAt = deployedRefs(summaries, scope);

  return (code) => {
    const variableFor = (reference: Reference): string | null =>
      variableAsked(code, reference);
    const ask = (
      reference: Reference,
      of: (variable: string) => string | null,
    ): string | null => {
      const variable = variableFor(reference);
      return variable === null ? null : of(variable);
    };
    return {
      variableFor,
      setTo: (reference) =>
        ask(reference, (variable) => {
          const values = new Set(
            setTo(code, variable).map((found) => found.value),
          );
          return values.size === 1 ? ([...values][0] ?? null) : null;
        }),
      pointsAt: (reference) =>
        ask(reference, (variable) => pointsAt(code, variable)),
    };
  };
}

/**
 * The variable a reference points at, or null when an argument a caller
 * passes settles it.
 *
 * A bare name is a variable, since that is how a pack writes a
 * `process.env` read. A path is a variable only when it starts at the
 * parameter a pack marks as the configuration, because the runtime
 * fills that argument and no call site in the run does.
 */
export function variableAsked(
  summary: BehavioralSummary,
  reference: Reference,
): string | null {
  if (reference.fields.length === 0) {
    return reference.root;
  }
  const parameter = parameterNamed(summary, reference.root);
  return parameter?.role === CONFIG_ROLE ? reference.fields.join(".") : null;
}

/** The unit's parameter with this name, or null when it has none. */
export function parameterNamed(
  summary: BehavioralSummary,
  name: string,
): { position: number; role: string | null } | null {
  for (const input of summary.inputs) {
    if (input.type === "parameter" && input.name === name) {
      return { position: input.position, role: input.role };
    }
  }

  return null;
}
