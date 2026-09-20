# @suss/contract-terraform

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Reads the boundaries a Terraform configuration declares, so code and other resources can be checked against them.

## What this package is

A contract reader. It walks `.tf` files and describes what it finds as boundaries, the same way `@suss/contract-cloudformation` describes what a template declares. It knows no provider: a pack says that `aws_dynamodb_table` is a store and that `google_logging_metric` is a metric, and this matches on what the pack says.

```bash
suss contract --from terraform infra/terraform/dynamodb -o tables.json
```

The path may be one file or the directory a module lives in, since a module states its resources across several files.

## What it reads

```hcl
resource "aws_dynamodb_table" "orders" {
  name      = "${local.environment}-orders-v1"
  hash_key  = "order_id"
  range_key = "placed_at"

  attribute {
    name = "order_id"
    type = "S"
  }

  global_secondary_index {
    name     = "by-customer-v1"
    hash_key = "customer_id"
  }
}
```

The resource label is the container, since that is what the rest of the configuration refers to. `name` is what the table is called once deployed, and it goes on the contract as the physical name.

That name is usually built at deploy time, and Terraform interpolates the same way CloudFormation does, so `"${local.environment}-orders-v1"` is recorded as the pattern `{local.environment}-orders-v1`. Code that builds the same name from its own variable records `{stage}-orders-v1`, and the two pair on the fixed text. This is what lets a service written in TypeScript meet a table declared in HCL.

Each secondary index becomes its own boundary, because a query through an index keys on that index's fields. `hash_key` and `range_key` say what identifies an item, partition key first, and the `attribute` blocks give each key its type.

A table declares its keys and lets every other attribute vary, so the contract says `fieldSet: "partial"` and the checker never calls an ordinary attribute unknown.

## A structure written as JSON

Several providers take a structure as a string rather than as blocks: a BigQuery table's schema, an ECS task's container definitions, an IAM policy document. Terraform gives an author two ways to write one, and both mean the same thing once deployed:

```hcl
schema = jsonencode([
  { name = "order_id", type = "STRING", mode = "REQUIRED" },
])

schema = <<EOF
[{ "name": "order_id", "type": "STRING", "mode": "REQUIRED" }]
EOF
```

`jsonAttributeValue` reads both, and a pack asks for one through `fieldsFromJson` on a storage entry, saying which attribute the JSON is at and which keys of an entry give the field its name, its type, and whether it is always set. A schema written this way is every field the item has, so the contract comes out `exhaustive`. One a file or a variable supplies is not written down anywhere the reader can see, so nothing is recorded rather than guessed.

A deployable steps into such an attribute rather than reading fields out of it. An ECS task writes its containers as `container_definitions = jsonencode([...])`, and a pack puts that attribute where it would put a block, so each container is read the same way a Cloud Run container written as blocks is.

## A block written once and deployed many times

A module rarely writes a container's variables out one block at a time. It writes one block and says what to iterate over:

```hcl
locals {
  service_env = { DB_NAME = var.db_name, LOG_LEVEL = "info" }
}

resource "google_cloud_run_v2_service" "api" {
  template {
    containers {
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
```

The reader settles `for_each` where the configuration already says what is in it: a map literal, a `locals` entry, a `variable` block's `default`, or a `merge` of those. Each key becomes one block, with `env.key`, `env.value` and `env.value.<field>` filled in, and the block that comes out is read exactly as a hand-written one would be. So this container declares `DB_NAME`, `LOG_LEVEL` and `SERVICE_ROLE`, with `DB_NAME` set to the pattern `{var.db_name}` and `SERVICE_ROLE` to the text `api`. A module that renames the iterator with `iterator = item` is read the same way.

ECS takes its containers as JSON rather than as blocks, so the same environment is written `environment = [for k, v in local.worker_env : { name = k, value = v }]`, and that expands the same way.

A `for_each` nothing settles, one a data source supplies, leaves the container with the variables the platform injects and nothing else. A `variable` default is read for this and for nothing else: a default says what a deployment would get if it passed nothing, so a `${var.stage}` in a name keeps its hole.

## Several entries for one resource type

A pack states more than one entry for a resource type when the provider spells it differently across versions, and again when one attribute decides what the resource is. `aws_db_instance` is a PostgreSQL store or a MySQL one depending on its `engine`, and `google_sql_database_instance` on its `database_version`, so each has an entry per engine and a gate that picks between them. A gate matches whole values through `equals`, or the start of a value through `startsWith`, which is what Cloud SQL needs: `database_version` states an engine and a release together, `POSTGRES_15` and `MYSQL_8_0_31`, and the releases change every quarter.
## What a deployable declares

A resource that deploys something becomes a runtime-config boundary, the same one `@suss/contract-cloudformation` writes for a Lambda in a template:

```hcl
resource "aws_lambda_function" "confirm" {
  function_name = "${local.environment}-confirm"
  handler       = "src/handlers/confirm.handler"

  environment {
    variables = {
      ORDERS_TABLE = aws_dynamodb_table.orders.name
      LOG_LEVEL    = "info"
    }
  }
}
```

The contract lists every variable the process starts with, the ones the configuration sets and the ones the platform adds, and says which is which. `LOG_LEVEL` is recorded as the text it is set to. `ORDERS_TABLE` is set to another resource, so the contract records both what that resource states its name to be and which resource it was, and code that reads `process.env.ORDERS_TABLE` to address a table reaches the table through either.

The unit is the resource label, `confirm`, rather than the name it deploys under. The label is what the rest of the configuration refers to it as, the way a logical id is in CloudFormation, so a variable pointing at the resource and the resource's own contract spell it the same way.

One resource deploys several processes where the provider says so. An ECS task definition is one contract per container, and each container gets only its own variables.

Every unsettled value in a contract is spelled the same way. An `image = var.image`, a `runtime` and a handler a variable supplies all come out as the pattern `{var.image}` rather than as the raw `${var.image}`, so nothing downstream has to know which field it is reading. A handler with a hole in it says nothing about which file the code is in, since splitting it at its last dot would pick a module nobody deploys.

A configuration says which handler runs and never which directory the deployed artifact was built from. So the handler is all the checker has to go on: where it matches a module in the run, that module's imports are the code the unit runs, and where it matches nothing, the unit is reported as one whose code could not be placed rather than being given the repository.


## What it will not tell you

- **Only what a loaded pack describes.** A resource no entry covers, an IAM policy or a subnet, is skipped.
- **A resource built with `for_each` or `count`** states one `resource` block for many tables, and this reads the block as written rather than working out what it expands to. A `dynamic` block inside a resource is expanded, since that one decides what a single deployed process is given.
- **A name a variable supplies whole**, `name = var.table_name`, has no fixed text to pair on, so it records nothing rather than guessing.
- **What a secret contains.** A variable a secret supplies records which resource supplies it and nothing else, since no configuration writes the contents down.
- **Which source directory a deployable was built from.** Terraform builds the artifact outside the configuration, so a `filename` is a zip nothing in the run can open and a `source_dir` belongs to a data source this does not follow.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the summaries it produces and `hcl2-parser` for reading HCL. The storage pass in `@suss/checker` pairs what code touches against what this declares.

## More

- [How it resolves a reference](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
