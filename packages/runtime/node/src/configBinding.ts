/**
 * The boundary binding on this pack's runtime-config reads, and the
 * shape of a read nothing supplies a value for.
 *
 * Which deployment runs a piece of code is not something the code says,
 * so a recognizer standing at a read leaves the deployment off unless a
 * run configured one. The pairing pass takes the deployment from the
 * provider side, the template or task definition that declares the
 * variables, so nothing downstream needs a guess here.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { BoundaryBinding, Effect } from "@suss/behavioral-ir";

/** What a run can say about the deployment its reads belong to. */
export interface DeploymentOptions {
  /**
   * The kind of deployment the config reads belong to. Left off unless
   * a run configured one, since the code never says.
   */
  deploymentTarget?: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  /**
   * The deployed instance the reads belong to. Left off unless a run
   * configured one; the pairing pass scopes reads by the provider's
   * own `metadata.codeScope` rather than by this.
   */
  instanceName?: string;
}

const RECOGNITION = "@suss/runtime-node";

/** The binding on a runtime-config read this pack found. */
export function configBinding(where: DeploymentOptions): BoundaryBinding {
  return runtimeConfigBinding({ recognition: RECOGNITION, ...where });
}

/**
 * A read of the runtime itself: the working directory, the platform,
 * the module's own location. Recorded so a unit's dependency on the
 * runtime is in its summary, with no deployment on the binding, and
 * under a class the runtime-config pairing pass leaves alone.
 */
export function opaqueRuntimeRead(callee: string): Effect {
  return {
    type: "interaction",
    binding: configBinding({}),
    callee,
    interaction: { class: "metadata-read", name: callee },
  };
}
