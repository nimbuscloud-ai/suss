/**
 * The boundary binding for this pack's runtime-config reads.
 *
 * The code does not show which deployment runs it, so a read leaves the
 * deployment off unless the run configured one. The pairing pass takes
 * the deployment from the provider side, which is the template or task
 * definition that declares the variables.
 */

import { runtimeConfigBinding } from "@suss/behavioral-ir";

import type { BoundaryBinding } from "@suss/behavioral-ir";

/** What a run can say about the deployment its reads belong to. */
export interface DeploymentOptions {
  /**
   * The kind of deployment the config reads belong to. Left off unless
   * a run configured one, since the code does not show it.
   */
  deploymentTarget?: "lambda" | "ecs-task" | "container" | "k8s-deployment";
  /**
   * The deployed instance the reads belong to. Left off unless a run
   * configured one. Pairing scopes reads by the provider's
   * `metadata.codeScope`, and does not use this field.
   */
  instanceName?: string;
}

/** The name this pack's effects are recognized under. */
export const RECOGNITION = "@suss/runtime-node";

/** The binding on a runtime-config read this pack found. */
export function configBinding(where: DeploymentOptions): BoundaryBinding {
  return runtimeConfigBinding({ recognition: RECOGNITION, ...where });
}
