/**
 * groundedPath.ts: a consumer path whose base URL the deployment fills
 * in, resolved to the path it reaches.
 *
 * An app that forwards to another service writes the call as
 * `fetch(`${process.env.API_BASE}/orders`)`. The path suss records is
 * `{API_BASE}/orders`, and the service that serves it says `/orders`.
 * Both sides are in the run, they describe one boundary, and nothing
 * pairs them.
 *
 * The source alone cannot settle it, which is why the adapter leaves
 * the hole in. `API_BASE` could be `http://backend.internal`, and then
 * the path is `/orders`. It could equally be `/api/v2`, and then the
 * path is `/api/v2/orders`. Only the deployment says which, so this
 * puts the deployed value in and reads the path back out.
 *
 * Nothing here changes what the summary records. The code still says
 * `{API_BASE}/orders`, and a report still shows that. What changes is
 * which bucket the consumer pairs in.
 */

import { pathAfterOrigin, referenceFromName, restBinding } from "@suss/ir-core";

import { deployedValues } from "../runtime-config/deployedValues.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

/** A path that opens with a hole, and the variable that fills it. */
const OPENING_HOLE = /^\{([^{}]+)\}(.*)$/;

/**
 * Rewrite a REST consumer's path with its base URL filled in.
 *
 * Returns the binding unchanged for anything else: a provider, a path
 * with no opening hole, a variable no runtime in this run sets, or a
 * variable two runtimes disagree about, since picking one of two
 * answers would be a guess.
 */
export function groundRestPaths(
  summaries: BehavioralSummary[],
): (summary: BehavioralSummary, binding: BoundaryBinding) => BoundaryBinding {
  const setTo = deployedValues(summaries);

  return (summary, binding) => {
    const semantics = binding.semantics;
    if (semantics.name !== "rest") {
      return binding;
    }
    if (semantics.path === null) {
      return binding;
    }
    const opening = OPENING_HOLE.exec(semantics.path);
    if (opening === null) {
      return binding;
    }
    const [, label, rest] = opening;
    const variable = variableOf(label);
    if (variable === null) {
      return binding;
    }

    const values = new Set(
      setTo(summary, variable).map((found) => found.value),
    );
    if (values.size !== 1) {
      return binding;
    }

    const [base] = [...values];
    const grounded = pathAfterOrigin(`${base}${rest}`);
    return restBinding({
      transport: binding.transport,
      recognition: binding.recognition,
      method: semantics.method,
      path: grounded === "" ? "/" : grounded,
      ...(semantics.declaredResponses !== undefined
        ? { declaredResponses: semantics.declaredResponses }
        : {}),
    });
  };
}

/**
 * The variable a hole's label asks about.
 *
 * A pack writes the label the way the source spells the read, so
 * `{API_BASE}` and `{env.API_BASE}` ask about the same variable.
 */
function variableOf(label: string): string | null {
  const reference = referenceFromName(`{${label}}`);
  if (reference === null) {
    return null;
  }
  const parts = [reference.root, ...reference.fields];
  const last = parts[parts.length - 1];
  return last ?? null;
}
