/**
 * A deployed unit that other code invokes by name: a Lambda function, a
 * Cloud Function, a state machine.
 *
 * Both sides can write the platform the unit runs on and the name the
 * platform gives it. That pair is a deployable unit, so the two fields
 * come from `DeployableUnitSchema`. A unit's runtime config channel
 * uses the same pair, because one deployed unit has both boundaries.
 *
 * An ARN is one way to write the name, and it does not identify the
 * unit. It has an account and a region in it, so a dev ARN and a prod
 * ARN for one function differ byte for byte.
 */

import { z } from "zod";

import { namesNothing, referenceFromName } from "../boundaryName.js";
import { DeployableUnitSchema } from "../deployableUnit.js";
import { unitIdentityKey } from "../identityKeys.js";
import { defineBoundarySemantics } from "./definition.js";

import type { Reference } from "../boundaryName.js";

/**
 * `instanceName` is nullable here and required on the unit itself,
 * because only the provider always knows the name. A call that picks
 * its callee at run time still happened. Recording it with a null name
 * keeps the call without pairing it against every unit.
 */
export const UnitInvocationSemanticsSchema = DeployableUnitSchema.extend({
  name: z.literal("unit-invocation"),
  instanceName: DeployableUnitSchema.shape.instanceName.nullable(),
});

export type UnitInvocationSemantics = z.infer<
  typeof UnitInvocationSemanticsSchema
>;

/** The reference for a callee the source gives only as a variable. */
function calleeReference(semantics: UnitInvocationSemantics): Reference | null {
  return semantics.instanceName === null
    ? null
    : referenceFromName(semantics.instanceName);
}

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
    leavesTheProcess: true,
    /**
     * A unit nothing in the run invokes is the ordinary case, since
     * most services are reached from a stack suss never read. So an
     * uninvoked unit stays in the generic unmatched list rather than
     * being reported as a problem here.
     */
    reportsUnpairedItself: false,
    /**
     * A callee the source gives only as a variable has no name until the
     * deployment fills it in. It gets no key, since a key built from the
     * variable would pair only with itself.
     */
    identityKey(semantics) {
      if (
        semantics.instanceName === null ||
        namesNothing(semantics.instanceName)
      ) {
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
    /**
     * A call that reads its callee's name from the environment reaches
     * whichever resource the template wires that variable to. The name
     * is grounded to the logical id and not the deployed name, because
     * the invoked unit's own summary is keyed by the logical id.
     */
    groundName(semantics, deployment) {
      const reference = calleeReference(semantics);
      if (reference === null) {
        return null;
      }
      const logicalId = deployment.pointsAt(reference);
      return logicalId === null
        ? null
        : { ...semantics, instanceName: logicalId };
    },
    nameReference: calleeReference,
  },
});
