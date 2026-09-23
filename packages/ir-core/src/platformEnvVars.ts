/**
 * The variables a deployment platform puts in a process's environment
 * whatever its configuration says.
 *
 * Code reads them and no template declares them, so without this list
 * every deployment would be reported for failing to supply
 * `AWS_REGION`. A CloudFormation template and a Terraform configuration
 * can describe the same Lambda, and both use this one list so they
 * agree on which variables are present. A platform whose vendor
 * documents a different set per product, such as Cloud Run with its
 * `K_SERVICE`, lists its variables in the pack that describes it.
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
