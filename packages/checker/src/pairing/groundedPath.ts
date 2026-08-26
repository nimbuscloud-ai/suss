/**
 * groundedPath.ts: what a boundary is called once the deployment has
 * filled its part in.
 *
 * An app that forwards to another service writes the call as
 * `fetch(`${process.env.API_BASE}/orders`)`. The path suss records is
 * `{API_BASE}/orders`, and the service that serves it says `/orders`.
 * Both sides are in the run, they describe one boundary, and nothing
 * pairs them.
 *
 * Which protocol has such a name, and what to put in, is the protocol's
 * own business. This works out what the deployment sets for the unit in
 * question and hands that over.
 *
 * Nothing here changes what the summary records. The code still says
 * `{API_BASE}/orders`, and a report still shows that. What changes is
 * which bucket the boundary pairs in.
 */

import { groundedPairingKey } from "@suss/ir-core";

import { deployedValues } from "../runtime-config/deployedValues.js";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

/**
 * Key every boundary, with deploy-time names filled in.
 *
 * Two runtimes setting one variable to different values leaves the
 * boundary as it is. Picking one of two answers would be a guess, and
 * an unpaired boundary says less than a wrong pair.
 */
export function groundedKeys(
  summaries: BehavioralSummary[],
): (summary: BehavioralSummary, binding: BoundaryBinding) => string | null {
  const setTo = deployedValues(summaries);

  return (summary, binding) =>
    groundedPairingKey(binding, (variable) => {
      const values = new Set(
        setTo(summary, variable).map((found) => found.value),
      );
      return values.size === 1 ? ([...values][0] ?? null) : null;
    });
}
