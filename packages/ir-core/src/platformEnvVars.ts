/**
 * The variables a deployment medium puts in a process's environment
 * whatever its configuration says.
 *
 * Code reads them and nothing declares them, so a reader that left them
 * out would accuse every deployment of failing to supply `AWS_REGION`.
 * Two readers describe the same Lambda, a CloudFormation template and a
 * Terraform configuration, and a variable one of them knew about and
 * the other did not would be an error in one and not the other, so the
 * list is stated once here. A medium whose vendor documents a different
 * set per product, Cloud Run's `K_SERVICE` against a plain container's
 * nothing, states its own list in the pack that describes it.
 */

import type { DeployableUnit } from "./deployableUnit.js";

/**
 * Sourced from each platform's own documentation:
 *
 *   Lambda: https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html
 *           "Reserved environment variables"
 *   ECS:    https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_metadata.html
 *           plus the AWS_DEFAULT_REGION the Fargate runtime sets.
 */
export const PLATFORM_INJECTED_ENV_VARS: Record<
  DeployableUnit["deploymentTarget"],
  ReadonlyArray<string>
> = {
  lambda: [
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_LAMBDA_FUNCTION_NAME",
    "AWS_LAMBDA_FUNCTION_VERSION",
    "AWS_LAMBDA_FUNCTION_MEMORY_SIZE",
    "AWS_LAMBDA_LOG_GROUP_NAME",
    "AWS_LAMBDA_LOG_STREAM_NAME",
    "AWS_LAMBDA_RUNTIME_API",
    "AWS_EXECUTION_ENV",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "LAMBDA_TASK_ROOT",
    "LAMBDA_RUNTIME_DIR",
    "_HANDLER",
    "_X_AMZN_TRACE_ID",
    "TZ",
  ],
  "ecs-task": [
    "AWS_DEFAULT_REGION",
    "AWS_REGION",
    "ECS_CONTAINER_METADATA_URI",
    "ECS_CONTAINER_METADATA_URI_V4",
    "ECS_AGENT_URI",
  ],
  // Which variables a container gets depends on what runs it, and the
  // bare target says nothing about that, so the pack for the product
  // states them.
  container: [],
  "k8s-deployment": [
    "KUBERNETES_SERVICE_HOST",
    "KUBERNETES_SERVICE_PORT",
    "KUBERNETES_PORT",
    "HOSTNAME",
  ],
  // A Worker reads its configuration off the argument every trigger
  // takes, and Cloudflare puts nothing of its own on it.
  worker: [],
};
