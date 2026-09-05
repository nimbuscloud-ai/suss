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
import { groundBinding, pairingKey } from "@suss/ir-core";

import type { BehavioralSummary, BoundaryBinding } from "@suss/behavioral-ir";

/** A boundary as the deployment fills it in, and the bucket it pairs in. */
export interface GroundedBucket {
  readonly key: string;
  readonly binding: BoundaryBinding;
}

/**
 * Key every boundary, with deploy-time names filled in. Which protocol
 * has such a name, and what to put in, is the protocol's own business.
 * The grounded binding comes back with the key, since a bucket that
 * spans other buckets is compared against them by its binding.
 */
export function groundedKeys(
  summaries: BehavioralSummary[],
): (
  summary: BehavioralSummary,
  binding: BoundaryBinding,
) => GroundedBucket | null {
  const deployment = deploymentOf(summaries);

  return (summary, binding) => {
    const grounded = groundBinding(binding, deployment(summary));
    const key = pairingKey(grounded);
    return key === null ? null : { key, binding: grounded };
  };
}
