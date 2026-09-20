// A root module that calls child modules, and what the reader says
// about the resources inside them.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readRuntimeContractMetadata } from "@suss/behavioral-ir";

import { terraformFileToSummaries } from "./index.js";

import type { BehavioralSummary } from "@suss/behavioral-ir";
import type { TerraformPack } from "./pack.js";

/** The reader knows no provider, so every test states one here. */
const PROVIDER: TerraformPack = {
  name: "test-provider",
  provider: "example",
  resources: [
    {
      resource: "example_table",
      providerVersions: ">=1 <9",
      boundary: {
        kind: "storage",
        storageSystem: "example.tables",
        nameAttribute: "name",
        fieldSet: "partial",
      },
    },
    {
      resource: "example_function",
      providerVersions: ">=1 <9",
      boundary: {
        kind: "deployable",
        deploymentTarget: "lambda",
        env: [{ style: "map", attribute: "environment.variables" }],
        platformEnvVars: [],
      },
    },
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
          },
        ],
        platformEnvVars: ["PORT"],
      },
    },
  ],
};

const PACKS = { packs: [PROVIDER] };

/** A root module and the child module directories it calls. */
function moduleTree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suss-tf-module-"));
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  return root;
}

const CHILD = `
variable "table_name" {
  type = string
}

variable "stage" {
  type = string
}

resource "example_table" "orders" {
  name = "\${var.stage}-\${var.table_name}"
}

resource "example_function" "writer" {
  environment {
    variables = {
      ORDERS_TABLE = example_table.orders.name
      STAGE        = "\${var.stage}"
    }
  }
}

output "table_name" {
  value = example_table.orders.name
}
`;

const ROOT = `
locals {
  stage = "prod"
}

module "orders" {
  source     = "./modules/store"
  stage      = local.stage
  table_name = "orders-v1"
}

module "invoices" {
  source     = "./modules/store"
  stage      = local.stage
  table_name = "invoices-v1"
}

resource "example_function" "reporter" {
  environment {
    variables = {
      ORDERS_TABLE = module.orders.table_name
    }
  }
}
`;

const tree = moduleTree({ "main.tf": ROOT, "modules/store/main.tf": CHILD });
const summaries = terraformFileToSummaries(tree, PACKS);

function named(name: string): BehavioralSummary {
  return summaries.find(
    (summary) => summary.identity.name === name,
  ) as BehavioralSummary;
}

describe("a root module that only calls child modules", () => {
  it("reads the resources the children declare", () => {
    expect(summaries.map((summary) => summary.identity.name).sort()).toEqual([
      "example_function.reporter",
      "module.invoices.example_function.writer",
      "module.invoices.example_table.orders",
      "module.orders.example_function.writer",
      "module.orders.example_table.orders",
    ]);
  });

  it("keeps two calls of one module apart by their deployable unit", () => {
    expect(
      named("module.orders.example_function.writer").identity.deployableUnit,
    ).toEqual({
      deploymentTarget: "lambda",
      instanceName: "module.orders.writer",
    });
  });

  it("resolves a variable to the literal the call passed in", () => {
    const orders = named("module.orders.example_table.orders");
    expect(orders.metadata?.storageContract).toMatchObject({
      physicalTable: "prod-orders-v1",
    });
    expect(
      named("module.invoices.example_table.orders").metadata?.storageContract,
    ).toMatchObject({ physicalTable: "prod-invoices-v1" });
  });

  it("points a variable at the resource inside the module that states it", () => {
    const contract = readRuntimeContractMetadata(
      named("module.orders.example_function.writer"),
    );
    expect(contract?.envVarValues?.ORDERS_TABLE).toBe("prod-orders-v1");
    expect(contract?.envVarTargets?.ORDERS_TABLE).toEqual({
      kind: "ref",
      logicalId: "module.orders.orders",
    });
    expect(contract?.envVarValues?.STAGE).toBe("prod");
  });

  it("reads a child's output back in the module that called it", () => {
    const contract = readRuntimeContractMetadata(
      named("example_function.reporter"),
    );
    expect(contract?.envVarValues?.ORDERS_TABLE).toBe("prod-orders-v1");
  });
});

const ENV_MAP_ROOT = `
resource "example_table" "orders" {
  name = "orders-v1"
}

module "svc" {
  source = "./modules/svc"
  env = {
    ORDERS_TABLE = example_table.orders.name
    LOG_LEVEL    = "info"
    REGION       = "\${var.region}"
  }
}
`;

const ENV_MAP_CHILD = `
variable "env" {
  type    = map(string)
  default = {}
}

resource "example_service" "api" {
  template {
    containers {
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}
`;

describe("a module call that passes the environment in as a map", () => {
  const root = moduleTree({
    "main.tf": ENV_MAP_ROOT,
    "modules/svc/main.tf": ENV_MAP_CHILD,
  });
  const contract = readRuntimeContractMetadata(
    terraformFileToSummaries(root, PACKS).find(
      (summary) => summary.identity.name === "module.svc.example_service.api",
    ) as BehavioralSummary,
  );

  it("expands the map the call passed rather than the child's default", () => {
    expect(contract?.envVars).toEqual([
      "LOG_LEVEL",
      "ORDERS_TABLE",
      "PORT",
      "REGION",
    ]);
  });

  it("reads a reference in the map in the module that wrote it", () => {
    expect(contract?.envVarValues?.ORDERS_TABLE).toBe("orders-v1");
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
  });

  it("leaves an entry the parent could not settle as the hole it was", () => {
    expect(contract?.envVarValues?.REGION).toBe("{var.region}");
  });
});

const NON_STRING_PARTS = `
module "svc" {
  source = "./modules/svc"
  env = {
    LOG_LEVEL = "info"
    REPLICAS  = 3
  }
}
`;

const NON_STRING_CHILD = `
variable "env" {
  type    = map(string)
  default = {}
}

output "endpoints" {
  value = { primary = "west" }
}

resource "example_service" "api" {
  template {
    containers {
      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}
`;

const READS_OUTPUT = `
module "svc" {
  source = "./modules/svc"
}

resource "example_function" "reporter" {
  environment {
    variables = {
      ENDPOINT = module.svc.endpoints
    }
  }
}
`;

describe("a map argument with an entry that is not text", () => {
  it("declares the entries that are, and claims nothing for the rest", () => {
    const root = moduleTree({
      "main.tf": NON_STRING_PARTS,
      "modules/svc/main.tf": NON_STRING_CHILD,
    });
    const contract = readRuntimeContractMetadata(
      terraformFileToSummaries(root, PACKS).find(
        (summary) => summary.identity.name === "module.svc.example_service.api",
      ) as BehavioralSummary,
    );
    expect(contract?.envVars).toEqual(["LOG_LEVEL", "PORT"]);
    expect(contract?.envVarValues?.LOG_LEVEL).toBe("info");
  });
});

describe("a child output that is not one string", () => {
  it("leaves the parent's reference to it a hole", () => {
    const root = moduleTree({
      "main.tf": READS_OUTPUT,
      "modules/svc/main.tf": NON_STRING_CHILD,
    });
    const contract = readRuntimeContractMetadata(
      terraformFileToSummaries(root, PACKS).find(
        (summary) => summary.identity.name === "example_function.reporter",
      ) as BehavioralSummary,
    );
    expect(contract?.envVarValues?.ENDPOINT).toBe("{module.svc.endpoints}");
  });
});

const REMOTE = `
module "queue" {
  source  = "example-org/queue/example"
  version = "1.2.0"
}

resource "example_table" "orders" {
  name = "orders-v1"
}
`;

describe("a module the repository does not contain", () => {
  it("reads what it can and says nothing about the rest", () => {
    const root = moduleTree({ "main.tf": REMOTE });
    expect(
      terraformFileToSummaries(root, PACKS).map(
        (summary) => summary.identity.name,
      ),
    ).toEqual(["example_table.orders"]);
  });
});

const UNPASSED = `
variable "stage" {
  type = string
}

module "store" {
  source = "./modules/store"
  stage  = var.stage
}
`;

const SIMPLE_CHILD = `
variable "stage" {
  type = string
}

resource "example_table" "orders" {
  name = "\${var.stage}-orders"
}
`;

describe("a module call whose argument the root cannot settle", () => {
  it("leaves the child's variable as the hole it was", () => {
    const root = moduleTree({
      "main.tf": UNPASSED,
      "modules/store/main.tf": SIMPLE_CHILD,
    });
    const [table] = terraformFileToSummaries(root, PACKS);
    expect(
      (table as BehavioralSummary).metadata?.storageContract,
    ).toMatchObject({ physicalTable: "{var.stage}-orders" });
  });
});

const SELF_CALLING = `
module "again" {
  source = "./"
}

resource "example_table" "orders" {
  name = "orders-v1"
}
`;

describe("a module that calls the directory it is in", () => {
  it("reads it once and stops", () => {
    const root = moduleTree({ "main.tf": SELF_CALLING });
    expect(
      terraformFileToSummaries(root, PACKS).map(
        (summary) => summary.identity.name,
      ),
    ).toEqual(["example_table.orders"]);
  });
});
