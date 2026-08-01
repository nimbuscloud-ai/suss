// deployableUnit.ts: deciding when two summaries that each name a
// deployable unit belong to the same one.
//
// A subject on a bus is not always enough to say who talks to whom.
// Five Lambdas subscribe to `post.created` and five handlers handle
// it, so the subject alone puts twenty-five pairs in one bucket where
// only five name the same Lambda. Both sides do know their Lambda, so
// the pairing asks them.
//
// The rule is the one `busesAgree` already uses for the bus that
// carries a channel: two sides that both name a unit have to name the
// same one, and a side that cannot know its unit still pairs. A pack
// reading a template knows which Lambda a subscription belongs to; a
// pack reading a queue resource has no Lambda to name, and must not
// be shut out for it.

import type { z } from "zod";
import type { DeployableUnitSchema } from "./schemas.js";

export type DeployableUnit = z.infer<typeof DeployableUnitSchema>;

/**
 * Whether two deployable units agree. They agree when they name the
 * same target and instance, and when either side names nothing.
 */
export function deployableUnitsAgree(
  a: DeployableUnit | undefined,
  b: DeployableUnit | undefined,
): boolean {
  if (a === undefined || b === undefined) {
    return true;
  }
  return (
    a.deploymentTarget === b.deploymentTarget &&
    a.instanceName === b.instanceName
  );
}
