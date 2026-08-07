// deployableUnit.ts: one thing that gets deployed and runs on its
// own: a Lambda function, an ECS task's container, a plain container,
// a k8s deployment.

import { z } from "zod";

/**
 * `instanceName` is the stable identifier the deployment medium uses:
 * the CFN logical resource id for Lambda and ECS, the deployment name
 * for k8s, the container name for a plain container.
 */
export const DeployableUnitSchema = z.object({
  deploymentTarget: z.enum([
    "lambda",
    "ecs-task",
    "container",
    "k8s-deployment",
  ]),
  // An empty name would agree with every other empty name, so a unit
  // that names nothing has to leave the field off instead.
  instanceName: z.string().min(1),
});

export type DeployableUnit = z.infer<typeof DeployableUnitSchema>;

/**
 * The `instanceName` an ECS task's container carries: the task
 * definition's own logical id and the container name CFN's
 * `ContainerDefinitions[*].Name` declares, composed the one way every
 * writer of an ECS `DeployableUnit` and every reader matching a
 * routing edge against one has to agree on.
 */
export function ecsContainerInstanceName(
  taskDefinitionLogicalId: string,
  containerName: string,
): string {
  return `${taskDefinitionLogicalId}/${containerName}`;
}
