// runtimeConfig.ts: a deployable unit's runtime configuration channel
// as a boundary.
//
// The provider side declares env vars and their values on a unit; env
// var names are FIELDS on its contract, so the channel itself is the
// boundary. Runtime config pairs through its own dedicated pass, so
// this protocol has no identity key.

import { z } from "zod";

import { DeployableUnitSchema } from "../deployableUnit.js";
import { defineBoundarySemantics } from "./definition.js";

/**
 * Pairing key: `(deploymentTarget, instanceName)`, which is exactly a
 * deployable unit, so the two fields come from `DeployableUnitSchema`
 * rather than being spelled a second time.
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
  behavior: {
    /** A process reads its config at startup; nothing answers it. */
    exchangesHttpResponses: false,
    reportsUnpairedItself: false,
    identityKey: () => null,
  },
});
