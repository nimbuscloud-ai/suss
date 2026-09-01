/**
 * A deployed unit as something other code can invoke by name: a Lambda
 * function, a Cloud Function, a state machine.
 *
 * What both sides can spell is the platform the unit runs on and the
 * name that platform knows it by, which is exactly a deployable unit,
 * so the two fields come from `DeployableUnitSchema` rather than being
 * written out again. A unit's runtime config channel is the same pair,
 * and that is the point: one deployed thing, two boundaries on it.
 *
 * An ARN is a spelling of the name rather than the identity. It has an
 * account and a region in it, so a dev ARN and a prod ARN name one
 * function while differing byte for byte.
 */

import { z } from "zod";

import { DeployableUnitSchema } from "../deployableUnit.js";
import { unitIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

/**
 * `instanceName` is nullable here and required on the unit itself,
 * because only the provider always knows the name. A call that works
 * its callee out at run time still happened, and recording it with no
 * name says so without pairing it against everything.
 */
export const UnitInvocationSemanticsSchema = DeployableUnitSchema.extend({
  name: z.literal("unit-invocation"),
  instanceName: DeployableUnitSchema.shape.instanceName.nullable(),
});

export type UnitInvocationSemantics = z.infer<
  typeof UnitInvocationSemanticsSchema
>;

export const unitInvocationSemantics = defineBoundarySemantics({
  name: "unit-invocation",
  schema: UnitInvocationSemanticsSchema,
  // faas.name is the deployed function's own name and instanceName is
  // the deployment template's logical id, which is a different string.
  // Runtime config leaves the pair off for the same reason.
  semconv: {},
  behavior: {
    /**
     * A synchronous invoke gives back whatever the handler returned,
     * which is a value rather than a status and a body. A handler's
     * return only becomes an HTTP response under a proxy integration,
     * and that route gets a REST binding instead of this one.
     */
    exchangesHttpResponses: false,
    /**
     * A unit nothing in the run invokes is the ordinary case, since
     * most services are reached from a stack suss never read. So an
     * uninvoked unit stays in the generic unmatched list rather than
     * being reported as a problem here.
     */
    reportsUnpairedItself: false,
    identityKey(semantics) {
      if (semantics.instanceName === null) {
        return null;
      }
      return unitIdentityKey(
        semantics.deploymentTarget,
        semantics.instanceName,
      );
    },
    displayLabel(semantics) {
      if (semantics.instanceName === null) {
        return `unit:${semantics.deploymentTarget} (named at runtime)`;
      }
      return unitIdentityKey(
        semantics.deploymentTarget,
        semantics.instanceName,
      );
    },
  },
});
