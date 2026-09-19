// What the deployable entries say, read through the reader they are
// written for. Each resource is written the way the provider docs show
// it, and once more with a name built from interpolation.

import { describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";
import { terraformToSummaries } from "@suss/contract-terraform";

import { awsTerraform } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";

const PACKS = { packs: [awsTerraform()] };

const CONFIGURATION = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

resource "aws_sqs_queue" "jobs" {
  name = "\${local.environment}-jobs"
}

resource "aws_lambda_function" "confirm" {
  function_name = "\${local.environment}-confirm"
  role          = aws_iam_role.lambda.arn
  handler       = "src/handlers/confirm.handler"
  runtime       = "nodejs20.x"
  filename      = "build/confirm.zip"

  environment {
    variables = {
      JOBS_QUEUE = aws_sqs_queue.jobs.name
      LOG_LEVEL  = "info"
    }
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "\${local.environment}-api"
  requires_compatibilities = ["FARGATE"]

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = "example/web:3"
      essential = true
      environment = [
        { name = "PORT", value = "8080" },
        { name = "JOBS_QUEUE", value = aws_sqs_queue.jobs.name }
      ]
      secrets = [
        { name = "DB_PASSWORD", valueFrom = aws_ssm_parameter.db_password.arn }
      ]
    }
  ])
}

resource "aws_ssm_parameter" "db_password" {
  name = "/\${local.environment}/db/password"
  type = "SecureString"
}
`;

const SUMMARIES = terraformToSummaries(CONFIGURATION, "main.tf", PACKS);

function unit(instanceName: string): BehavioralSummary {
  const found = SUMMARIES.find(
    (summary) => summary.identity.deployableUnit?.instanceName === instanceName,
  );
  return found as BehavioralSummary;
}

describe("the Lambda entry", () => {
  it("deploys one unit, keyed by the resource label", () => {
    expect(unit("confirm").identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "confirm",
    });
  });

  it("declares the variables the function sets and the ones Lambda adds", () => {
    const contract = readRuntimeContractMetadata(unit("confirm"));
    expect(contract?.envVarSources?.JOBS_QUEUE).toBe("template");
    expect(contract?.envVarSources?.AWS_LAMBDA_FUNCTION_NAME).toBe("platform");
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
  });

  it("points a variable set to a queue at that queue", () => {
    expect(
      readRuntimeContractMetadata(unit("confirm"))?.envVarTargets?.JOBS_QUEUE,
    ).toEqual({ kind: "ref", logicalId: "jobs" });
  });

  it("reads the handler as the module the runtime enters", () => {
    expect(readRuntimeContractMetadata(unit("confirm"))?.entryPoint).toBe(
      "src/handlers/confirm.handler",
    );
    expect(unit("confirm").metadata?.codeScope).toEqual({
      kind: "unknown",
      entry: "src/handlers/confirm",
    });
  });
});

describe("the ECS task definition entry", () => {
  it("deploys one unit per container, named under the task", () => {
    expect(unit("api/web").identity.deployableUnit).toEqual({
      deploymentTarget: "ecs-task",
      instanceName: "api/web",
    });
  });

  it("reads the container's environment out of the JSON it is written in", () => {
    const contract = readRuntimeContractMetadata(unit("api/web"));
    expect(contract?.envVarValues?.PORT).toBe("8080");
    expect(contract?.envVarValues?.JOBS_QUEUE).toBe("{local.environment}-jobs");
    expect(contract?.image).toBe("example/web:3");
  });

  it("points a secret at the parameter that supplies it, with no value", () => {
    const contract = readRuntimeContractMetadata(unit("api/web"));
    expect(contract?.envVarTargets?.DB_PASSWORD).toEqual({
      kind: "ref",
      logicalId: "db_password",
    });
    expect(contract?.envVarValues?.DB_PASSWORD).toBeUndefined();
  });

  it("adds the variables the ECS agent injects", () => {
    expect(
      readRuntimeContractMetadata(unit("api/web"))?.envVarSources
        ?.ECS_CONTAINER_METADATA_URI_V4,
    ).toBe("platform");
  });
});

const PINNED_TO_V3 = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 3.0"
    }
  }
}

resource "aws_lambda_function" "confirm" {
  function_name = "confirm"
  handler       = "index.handler"
}
`;

describe("a configuration pinned outside the entry's range", () => {
  it("is not read by an entry written for a later provider", () => {
    expect(terraformToSummaries(PINNED_TO_V3, "main.tf", PACKS)).toHaveLength(
      0,
    );
  });
});
