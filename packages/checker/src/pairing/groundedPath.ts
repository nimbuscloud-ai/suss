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
 * Nothing here changes what the summary records. The code still says
 * `{API_BASE}/orders`, and a report still shows that. What changes is
 * which bucket the boundary pairs in.
 */

import { deploymentOf } from "@suss/behavioral-ir";
import { groundedPairingKey } from "@suss/ir-core";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

/**
 * Key every boundary, with deploy-time names filled in. Which protocol
 * has such a name, and what to put in, is the protocol's own business.
 */
export function groundedKeys(
  summaries: BehavioralSummary[],
): (summary: BehavioralSummary, binding: BoundaryBinding) => string | null {
  const deployment = deploymentOf(summaries);

  return (summary, binding) => groundedPairingKey(binding, deployment(summary));
}
