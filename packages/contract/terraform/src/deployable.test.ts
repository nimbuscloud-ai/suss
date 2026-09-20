// What the reader says about something a configuration deploys: the
// environment the process starts with, where each variable came from,
// and which resource a variable pointing at one resolves to.

import { describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { terraformToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { TerraformPack } from "./pack.js";

/** The reader knows no provider, so every test states one here. */
const AWS: TerraformPack = {
  name: "test-aws",
  provider: "aws",
  resources: [
    {
      resource: "aws_lambda_function",
      providerVersions: ">=4 <7",
      boundary: {
        kind: "deployable",
        deploymentTarget: "lambda",
        runtimeAttribute: "runtime",
        env: [{ style: "map", attribute: "environment.variables" }],
        code: {
          handler: { attribute: "handler", spelling: "module.export" },
        },
      },
    },
    {
      resource: "aws_ecs_task_definition",
      providerVersions: ">=4 <7",
      boundary: {
        kind: "deployable",
        deploymentTarget: "ecs-task",
        containers: {
          blocks: ["container_definitions"],
          nameAttribute: "name",
        },
        env: [
          {
            style: "entries",
            block: "environment",
            nameAttribute: "name",
            valueAttribute: "value",
          },
          {
            style: "entries",
            block: "secrets",
            nameAttribute: "name",
            secretAttribute: "valueFrom",
          },
        ],
        code: { imageAttribute: "image" },
      },
    },
    {
      resource: "aws_dynamodb_table",
      providerVersions: ">=4 <7",
      boundary: {
        kind: "storage",
        storageSystem: "aws.dynamodb",
        nameAttribute: "name",
        fieldSet: "partial",
      },
    },
    // A provider that writes a bare exported name and its variables as
    // repeated blocks, which is what Cloud Run and Cloud Functions do.
    {
      resource: "example_service",
      providerVersions: ">=4 <7",
      boundary: {
        kind: "deployable",
        deploymentTarget: "container",
        env: [
          {
            style: "entries",
            block: "env",
            nameAttribute: "name",
            valueAttribute: "value",
          },
        ],
        code: { handler: { attribute: "entry_point", spelling: "name" } },
        platformEnvVars: ["PORT"],
      },
    },
  ],
};

const PACKS = { packs: [AWS] };

const FUNCTION = `
resource "aws_dynamodb_table" "orders" {
  name = "\${local.environment}-orders-v1"
}

resource "aws_lambda_function" "confirm" {
  function_name = "\${local.environment}-confirm"
  handler       = "src/handlers/confirm.handler"
  runtime       = "nodejs20.x"

  environment {
    variables = {
      ORDERS_TABLE = aws_dynamodb_table.orders.name
      LOG_LEVEL    = "info"
      API_BASE     = "https://\${local.environment}.example.com"
    }
  }
}
`;

const TASK = `
resource "aws_ssm_parameter" "db_password" {
  name = "/db/password"
}

resource "aws_ecs_task_definition" "api" {
  family = "api"

  container_definitions = jsonencode([
    {
      name  = "web"
      image = "example/web:3"
      environment = [
        { name = "PORT", value = "8080" }
      ]
      secrets = [
        { name = "DB_PASSWORD", valueFrom = aws_ssm_parameter.db_password.name }
      ]
    },
    {
      name  = "sidecar"
      image = "example/logs:1"
      environment = [
        { name = "LOG_SINK", value = "stdout" }
      ]
    }
  ])
}
`;

function deployables(summaries: BehavioralSummary[]): BehavioralSummary[] {
  return summaries.filter(
    (summary) =>
      summary.identity.boundaryBinding?.semantics.name === "runtime-config",
  );
}

describe("a function a configuration deploys", () => {
  const [unit] = deployables(terraformToSummaries(FUNCTION, "main.tf", PACKS));
  const contract = readRuntimeContractMetadata(unit as BehavioralSummary);

  it("is one deployable unit, keyed by the resource label", () => {
    expect((unit as BehavioralSummary).identity.deployableUnit).toEqual({
      deploymentTarget: "lambda",
      instanceName: "confirm",
    });
  });

  it("lists what the configuration declares beside what Lambda injects", () => {
    expect(contract?.envVars).toContain("ORDERS_TABLE");
    expect(contract?.envVars).toContain("AWS_LAMBDA_FUNCTION_NAME");
    expect(contract?.envVarSources?.ORDERS_TABLE).toBe("template");
    expect(contract?.envVarSources?.AWS_LAMBDA_FUNCTION_NAME).toBe("platform");
  });

  it("resolves a variable set to another resource to that resource", () => {
    expect(contract?.envVarTargets?.ORDERS_TABLE).toEqual({
      kind: "ref",
      logicalId: "orders",
    });
  });

  it("records a written value, with deploy-time text left as a hole", () => {
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
    expect(contract?.envVarValues?.API_BASE).toBe(
      "https://{local.environment}.example.com",
    );
  });

  it("reads the variable set to a resource as what that resource states", () => {
    expect(contract?.envVarValues?.ORDERS_TABLE).toBe(
      "{local.environment}-orders-v1",
    );
  });

  it("says which file the handler is in, and what the handler was", () => {
    expect(contract?.entryPoint).toBe("src/handlers/confirm.handler");
    expect((unit as BehavioralSummary).metadata?.codeScope).toEqual({
      kind: "unknown",
      entry: "src/handlers/confirm",
    });
  });

  it("records the language runtime the configuration states", () => {
    expect(contract?.runtime).toBe("nodejs20.x");
  });
});

describe("a task definition that runs two containers", () => {
  const units = deployables(terraformToSummaries(TASK, "main.tf", PACKS));

  it("is one unit per container, named under the task", () => {
    expect(units.map((unit) => unit.identity.deployableUnit)).toEqual([
      { deploymentTarget: "ecs-task", instanceName: "api/web" },
      { deploymentTarget: "ecs-task", instanceName: "api/sidecar" },
    ]);
  });

  it("reads the environment out of the JSON the attribute is written in", () => {
    const web = readRuntimeContractMetadata(units[0] as BehavioralSummary);
    expect(web?.envVars).toContain("PORT");
    expect(web?.envVarValues?.PORT).toBe("8080");
    expect(web?.image).toBe("example/web:3");
  });

  it("gives each container only its own variables", () => {
    const sidecar = readRuntimeContractMetadata(units[1] as BehavioralSummary);
    expect(sidecar?.envVars).toContain("LOG_SINK");
    expect(sidecar?.envVars).not.toContain("PORT");
  });

  it("records which resource supplies a secret and never its value", () => {
    const web = readRuntimeContractMetadata(units[0] as BehavioralSummary);
    expect(web?.envVars).toContain("DB_PASSWORD");
    expect(web?.envVarTargets?.DB_PASSWORD).toEqual({
      kind: "ref",
      logicalId: "db_password",
    });
    expect(web?.envVarValues?.DB_PASSWORD).toBeUndefined();
  });

  it("puts the variables ECS injects on every container", () => {
    const web = readRuntimeContractMetadata(units[0] as BehavioralSummary);
    expect(web?.envVarSources?.ECS_CONTAINER_METADATA_URI).toBe("platform");
  });
});

const RAW_JSON = `
resource "aws_ecs_task_definition" "api" {
  family                = "api"
  container_definitions = "[{\\"name\\":\\"web\\",\\"image\\":\\"example/web:3\\",\\"environment\\":[{\\"name\\":\\"PORT\\",\\"value\\":\\"8080\\"}]}]"
}
`;

const UNREADABLE_JSON = `
resource "aws_ecs_task_definition" "api" {
  family                = "api"
  container_definitions = file("containers.json")
}
`;

describe("container definitions written some other way", () => {
  it("reads a JSON string the same as a jsonencode call", () => {
    const [unit] = deployables(
      terraformToSummaries(RAW_JSON, "main.tf", PACKS),
    );
    const contract = readRuntimeContractMetadata(unit as BehavioralSummary);
    expect((unit as BehavioralSummary).identity.deployableUnit).toEqual({
      deploymentTarget: "ecs-task",
      instanceName: "api/web",
    });
    expect(contract?.envVarValues?.PORT).toBe("8080");
  });

  it("declares nothing for a value only the apply can read", () => {
    expect(
      deployables(terraformToSummaries(UNREADABLE_JSON, "main.tf", PACKS)),
    ).toHaveLength(0);
  });
});

const NO_ENVIRONMENT = `
resource "aws_lambda_function" "bare" {
  function_name = "bare"
  handler       = "index.handler"
}
`;

const BARE_NAME = `
resource "example_service" "thumbnails" {
  entry_point = "makeThumbnail"

  env {
    name  = "LOG_LEVEL"
    value = "info"
  }
  env {
    value = "nobody asked for this"
  }
  env {
    name  = "STAGE"
    value = "\${local.environment}"
  }
}
`;

describe("a deployable whose provider writes its variables as blocks", () => {
  const [unit] = deployables(terraformToSummaries(BARE_NAME, "main.tf", PACKS));
  const contract = readRuntimeContractMetadata(unit as BehavioralSummary);

  it("records a bare entry point without claiming which file it is in", () => {
    expect(contract?.entryPoint).toBe("makeThumbnail");
    expect((unit as BehavioralSummary).metadata?.codeScope).toEqual({
      kind: "unknown",
    });
  });

  it("takes the platform list the entry states over the target's", () => {
    expect(contract?.envVarSources?.PORT).toBe("platform");
    expect(contract?.envVars).not.toContain("AWS_REGION");
  });

  it("skips an entry that says what it is set to but not what it is called", () => {
    expect(contract?.envVars).toEqual(["LOG_LEVEL", "PORT", "STAGE"]);
  });

  it("points a variable at no resource when the reference is not one", () => {
    expect(contract?.envVarValues?.STAGE).toBe("{local.environment}");
    expect(contract?.envVarTargets).toBeUndefined();
  });
});

const SUPPLIED_BY_VARIABLE = `
resource "aws_lambda_function" "confirm" {
  function_name = "confirm"
  handler       = "\${var.handler}"
  runtime       = "\${var.runtime}"
}

resource "aws_ecs_task_definition" "api" {
  family = "api"

  container_definitions = jsonencode([
    { name = "web", image = var.image }
  ])
}
`;

describe("a deployable whose image, runtime or handler a variable supplies", () => {
  const units = deployables(
    terraformToSummaries(SUPPLIED_BY_VARIABLE, "main.tf", PACKS),
  );
  const unitNamed = (instanceName: string) =>
    units.find(
      (unit) => unit.identity.deployableUnit?.instanceName === instanceName,
    ) as BehavioralSummary;

  it("spells the hole the way every other unsettled value is spelled", () => {
    const lambda = readRuntimeContractMetadata(unitNamed("confirm"));
    expect(lambda?.runtime).toBe("{var.runtime}");
    expect(lambda?.entryPoint).toBe("{var.handler}");
  });

  it("claims no file for a handler nothing settles", () => {
    expect(unitNamed("confirm").metadata?.codeScope).toEqual({
      kind: "unknown",
    });
  });

  it("spells an image inside a jsonencode the same way", () => {
    const task = readRuntimeContractMetadata(unitNamed("api/web"));
    expect(task?.image).toBe("{var.image}");
  });
});

describe("a function that declares no environment", () => {
  it("still declares a contract, of the variables the platform injects", () => {
    const [unit] = deployables(
      terraformToSummaries(NO_ENVIRONMENT, "main.tf", PACKS),
    );
    const contract = readRuntimeContractMetadata(unit as BehavioralSummary);
    expect(contract?.envVars).toContain("AWS_REGION");
    expect(contract?.envVarValues).toBeUndefined();
  });
});
