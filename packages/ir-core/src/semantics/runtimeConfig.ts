/**
 * A deployable unit's runtime configuration channel as a boundary.
 *
 * The provider side declares environment variables and their values on
 * a unit. Each variable name is a field on that unit's contract, so the
 * boundary is the whole channel. A dedicated pass pairs runtime config,
 * so this protocol has no identity key.
 */

import { z } from "zod";

import { DeployableUnitSchema } from "../deployableUnit.js";
import { defineBoundarySemantics } from "./definition.js";

/**
 * The dedicated pass pairs on `(deploymentTarget, instanceName)`, which
 * is a deployable unit, so the two fields come from
 * `DeployableUnitSchema`.
 *
 * A provider sets both. The reading side is code, and code does not say
 * which deployment will run it, so a recognizer at a read leaves both
 * out and does not guess. The pairing pass takes the deployment from
 * the provider.
 */
export const RuntimeConfigSemanticsSchema = DeployableUnitSchema.partial({
  deploymentTarget: true,
  instanceName: true,
}).extend({
  name: z.literal("runtime-config"),
});

export type RuntimeConfigSemantics = z.infer<
  typeof RuntimeConfigSemanticsSchema
>;

export const runtimeConfigSemantics = defineBoundarySemantics({
  name: "runtime-config",
  schema: RuntimeConfigSemanticsSchema,
  // service.name and cloud.resource_id identify the same deployable, but
  // instanceName is the template's logical id, a different string from
  // both.
  semconv: {},
  behavior: {
    /** A process reads its config at startup, and nothing replies. */
    exchangesHttpResponses: false,
    // Whoever deploys the process puts the value there, so the value
    // comes from outside the code.
    leavesTheProcess: true,
    reportsUnpairedItself: false,
    identityKey: () => null,
  },
});
