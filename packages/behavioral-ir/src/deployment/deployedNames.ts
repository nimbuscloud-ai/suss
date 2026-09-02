/**
 * deployedNames.ts: the one place a boundary name with a hole in it
 * gets filled in.
 *
 * `deployedValues` and `deployedRefs` next door know half of it each,
 * and this puts a `Deployment` in front of them so a protocol can ask
 * without knowing which half it is. Everything that reads a name for
 * somebody to see comes through here: the pairing pass, the drafter
 * that writes an intent document, and the intent checker that reads
 * one back.
 *
 * The rule for which variable a reference asks about is here too. It
 * used to be written twice, and the two spellings could disagree.
 */

import { deployedRefs } from "./deployedRefs.js";
import { deployedValues } from "./deployedValues.js";
import { deploymentScope } from "./deploymentScope.js";

import type { Deployment, Reference } from "@suss/ir-core";
import type { BehavioralSummary } from "../index.js";

/** What a pack calls the argument a runtime's configuration arrives in. */
const CONFIG_ROLE = "config";

/**
 * Ask what each unit's deployment fills its variables in with.
 *
 * Built once for a set of summaries and asked per unit, because two
 * services in one repository can both set `API_BASE` and only the unit
 * in question says which value applies.
 */
export function deploymentOf(
  summaries: BehavioralSummary[],
): (code: BehavioralSummary) => Deployment {
  // One placement for both channels: walking the module graph twice
  // for one result is the kind of cost a caller cannot see.
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
 * The variable a reference asks about, or null when what settles it is
 * an argument a caller passes.
 *
 * One bare name is a variable: that is how a pack spells a
 * `process.env` read. A path is one only when it goes through the
 * argument a pack calls the configuration, because what fills that
 * argument is the runtime rather than any call site in the run.
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

/** The parameter of this unit a reference starts at, if it takes one. */
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
