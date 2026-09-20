// A block a module writes once and deploys many times: a `dynamic`
// around a container's environment, and the `for` expression that does
// the same thing inside a JSON attribute.

import { describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { terraformToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { TerraformPack } from "./pack.js";

/** The reader knows no provider, so every test states one here. */
const PROVIDER: TerraformPack = {
  name: "test-provider",
  provider: "example",
  resources: [
    {
      resource: "example_service",
      providerVersions: ">=1 <9",
      boundary: {
        kind: "deployable",
        deploymentTarget: "container",
        containers: {
          blocks: ["template", "containers"],
          nameAttribute: "name",
        },
        env: [
          {
            style: "entries",
            block: "env",
            nameAttribute: "name",
            valueAttribute: "value",
            secretAttribute: "value_source.secret_key_ref.secret",
          },
        ],
        code: { imageAttribute: "image" },
        platformEnvVars: ["PORT"],
      },
    },
    {
      resource: "example_task",
      providerVersions: ">=1 <9",
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
        ],
        code: { imageAttribute: "image" },
        platformEnvVars: [],
      },
    },
    {
      resource: "example_parameter",
      providerVersions: ">=1 <9",
      boundary: {
        kind: "storage",
        storageSystem: "example.parameters",
        nameAttribute: "name",
        fieldSet: "none",
      },
    },
  ],
};

const PACKS = { packs: [PROVIDER] };

function contractOf(source: string) {
  const [unit] = terraformToSummaries(source, "main.tf", PACKS).filter(
    (summary) =>
      summary.identity.boundaryBinding?.semantics.name === "runtime-config",
  );
  return readRuntimeContractMetadata(unit as BehavioralSummary);
}

const MERGED = `
variable "db_name" {
  type = string
}

locals {
  service_env = {
    DB_NAME   = "\${var.db_name}"
    LOG_LEVEL = "info"
  }
}

resource "example_service" "api" {
  template {
    containers {
      image = "example/api:7"
      dynamic "env" {
        for_each = merge(local.service_env, { SERVICE_ROLE = "api" })
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}
`;

describe("a dynamic block over a merge of maps", () => {
  const contract = contractOf(MERGED);

  it("declares one variable per key the merge states", () => {
    expect(contract?.envVars).toEqual([
      "DB_NAME",
      "LOG_LEVEL",
      "PORT",
      "SERVICE_ROLE",
    ]);
  });

  it("records what each key is set to", () => {
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
    expect(contract?.envVarValues?.SERVICE_ROLE).toBe("api");
  });

  it("leaves a value the deployment supplies as the hole it was", () => {
    expect(contract?.envVarValues?.DB_NAME).toBe("{var.db_name}");
  });
});

const FROM_DEFAULT = `
variable "service_env" {
  type = map(string)
  default = {
    LOG_LEVEL = "debug"
  }
}

resource "example_service" "api" {
  template {
    containers {
      image = "example/api:7"
      dynamic "env" {
        for_each = var.service_env
        iterator = item
        content {
          name  = item.key
          value = item.value
        }
      }
    }
  }
}
`;

describe("a dynamic block whose iterator the module renames", () => {
  const contract = contractOf(FROM_DEFAULT);

  it("takes the keys a variable's default states", () => {
    expect(contract?.envVars).toContain("LOG_LEVEL");
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("debug");
  });
});

const OBJECT_ENTRIES = `
locals {
  where = "west"
  declared = {
    logging = { name = "LOG_LEVEL", value = "warn" }
    region  = { name = "REGION", value = "\${local.where}" }
    stray   = "not an entry"
  }
}

resource "example_service" "api" {
  template {
    containers {
      image = "example/api:7"
      dynamic "env" {
        for_each = local.declared
        content {
          name  = env.value.name
          value = env.value.value
        }
      }
    }
  }
}
`;

describe("a dynamic block over a map of objects", () => {
  const contract = contractOf(OBJECT_ENTRIES);

  it("reads the name and the value out of each entry", () => {
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("warn");
  });

  it("resolves a reference an entry states the same as any other", () => {
    expect(contract?.envVarValues?.REGION).toBe("west");
  });

  it("skips an entry that is not the object the content reads", () => {
    expect(contract?.envVars).toEqual(["LOG_LEVEL", "PORT", "REGION"]);
  });
});

const SECRET_ENTRIES = `
resource "example_parameter" "db_password" {
  name = "/db/password"
}

resource "example_service" "api" {
  template {
    containers {
      image = "example/api:7"
      dynamic "env" {
        for_each = { DB_PASSWORD = "\${example_parameter.db_password.name}" }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret = env.value
            }
          }
        }
      }
    }
  }
}
`;

describe("a dynamic block whose content nests further blocks", () => {
  const contract = contractOf(SECRET_ENTRIES);

  it("fills the iterator in wherever the content writes it", () => {
    expect(contract?.envVars).toContain("DB_PASSWORD");
    expect(contract?.envVarTargets?.DB_PASSWORD).toEqual({
      kind: "ref",
      logicalId: "db_password",
    });
  });
});

const UNSETTLED = `
resource "example_service" "api" {
  template {
    containers {
      image = "example/api:7"
      dynamic "env" {
        for_each = data.example_config.current.entries
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}
`;

describe("a dynamic block whose for_each nothing settles", () => {
  const contract = contractOf(UNSETTLED);

  it("declares the platform's variables and claims no others", () => {
    expect(contract?.envVars).toEqual(["PORT"]);
    expect(contract?.envVarValues).toBeUndefined();
  });
});

const FOR_EXPRESSION = `
locals {
  worker_env = {
    QUEUE_NAME = "orders"
    LOG_LEVEL  = "info"
  }
}

resource "example_task" "worker" {
  container_definitions = jsonencode([
    {
      name        = "worker"
      image       = "example/worker:2"
      environment = [for k, v in local.worker_env : { name = k, value = v }]
    }
  ])
}
`;

describe("a container whose environment is built by a for expression", () => {
  const contract = contractOf(FOR_EXPRESSION);

  it("declares one variable per key the collection states", () => {
    expect(contract?.envVars).toEqual(["LOG_LEVEL", "QUEUE_NAME"]);
  });

  it("records what each one is set to", () => {
    expect(contract?.envVarValues?.QUEUE_NAME).toBe("orders");
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
  });
});
