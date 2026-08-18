/**
 * A deployable unit's runtime configuration channel as a boundary.
 *
 * The provider side declares env vars and their values on a unit. The
 * env var names are fields on that unit's contract, so the channel
 * itself is the boundary, not any one variable. Runtime config is
 * paired by its own dedicated pass, so this protocol has no identity
 * key.
 */

import { z } from "zod";

import { DeployableUnitSchema } from "../deployableUnit.js";
import { defineBoundarySemantics } from "./definition.js";

/**
 * The pairing key is `(deploymentTarget, instanceName)`, which is
 * exactly a deployable unit, so the two fields come from
 * `DeployableUnitSchema` instead of being written out a second time.
 */
export const RuntimeConfigSemanticsSchema = DeployableUnitSchema.extend({
  name: z.literal("runtime-config"),
});

export type RuntimeConfigSemantics = z.infer<
  typeof RuntimeConfigSemanticsSchema
>;

export const runtimeConfigSemantics = defineBoundarySemantics({
  name: "runtime-config",
  schema: RuntimeConfigSemanticsSchema,
  // service.name and cloud.resource_id name the same deployable, but
  // instanceName is the deployment template's logical id, which is
  // neither of those strings.
  semconv: {},
  behavior: {
    /** A process reads its config at startup, and nothing replies. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey: () => null,
  },
});
