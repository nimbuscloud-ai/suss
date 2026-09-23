# @suss/contract-terraform

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package reads the boundaries a Terraform configuration declares, so code and other resources can be checked against them.

## What this package is

A contract reader. It walks `.tf` files and records what it finds as boundaries, the same way `@suss/contract-cloudformation` records what a template declares. It has no provider knowledge of its own. A pack declares that `aws_dynamodb_table` is a store and that `google_logging_metric` is a metric, and this reader matches on those declarations.

```bash
suss contract --from terraform infra/terraform/dynamodb -o tables.json
```

The path can be one file or the directory a module is in, since a module declares its resources across several files. A root module that only calls child modules is read too, as described below.

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

The resource label is the container, since the rest of the configuration refers to the resource by its label. `name` is what the table is called once deployed, and it goes on the contract as the physical name.

That name is usually built at deploy time. Terraform interpolates the same way CloudFormation does, so `"${local.environment}-orders-v1"` is recorded as the pattern `{local.environment}-orders-v1`. Code that builds the same name from its own variable records `{stage}-orders-v1`, and the two pair on the fixed text. That is how a service written in TypeScript pairs with a table declared in HCL.

Each secondary index becomes its own boundary, because a query through an index keys on that index's fields. `hash_key` and `range_key` give what identifies an item, partition key first, and the `attribute` blocks give each key its type.

A table declares its keys and lets every other attribute vary, so the contract has `fieldSet: "partial"`, and the checker never reports an ordinary attribute as unknown.

## A structure written as JSON

Several providers take a structure as a string instead of as blocks. Examples are a BigQuery table's schema and an ECS task's container definitions. Terraform lets an author write one in two ways, and both mean the same thing once deployed:

```hcl
schema = jsonencode([
  { name = "order_id", type = "STRING", mode = "REQUIRED" },
])

schema = <<EOF
[{ "name": "order_id", "type": "STRING", "mode": "REQUIRED" }]
EOF
```

`jsonAttributeValue` reads both. A pack asks for it through `fieldsFromJson` on a storage entry, giving the attribute the JSON is in, and the keys in each entry that give the field its name, its type, and whether it is always set. A schema written this way lists every field the item has, so the contract comes out `exhaustive`. A schema supplied by a file or a variable is not written anywhere the reader can see, so the reader records nothing and does not guess.

For a deployable, the reader goes into such an attribute and reads blocks from it, where a store would have fields read out of it. An ECS task writes its containers as `container_definitions = jsonencode([...])`, and a pack treats that attribute the way it would treat a block. So each container is read the same way as a Cloud Run container written as blocks.

## A block written once and deployed many times

A module rarely writes a container's variables one block at a time. It writes one `dynamic "env"` block over a map, or, in an ECS task's JSON, a `for` expression over the same map. The reader expands both wherever the configuration already gives the contents of that map, so the container declares the variables the deployment will give it, instead of none. [How a repeated block is expanded](./DESIGN.md#a-block-written-once-and-deployed-many-times) covers which forms can be settled and which stay holes.

## A root module that calls child modules

Many configurations declare no resources at the root. They call one module per service, and every table and function is inside the child. When a `source` points at a directory next to this one, the reader follows it and reads that directory as a module of its own. Everything the child declares gets `module.orders.` in front of its summary name and its deployable unit. [A module call this reader follows](./DESIGN.md#a-module-call-this-reader-follows) covers what passes between a call and the module it calls.

## Several entries for one resource type

A pack declares more than one entry for a resource type when the provider spells it differently across versions. A resource whose engine is chosen by one of its attributes does not need a second entry. A storage entry's `storageSystem` is either a word, or an attribute plus a table of what each of its values means. So `aws_db_instance` reads its `engine`, and `google_sql_database_instance` reads its `database_version`. A table matches whole values by default, or the start of a value with `matches: "prefix"`. Cloud SQL needs the prefix form, because `database_version` gives an engine and a release together, as in `POSTGRES_15` and `MYSQL_8_0_31`, and the releases change every quarter.

If the pack does not list a value, or the configuration builds the value at deploy time, the store gets no engine. The resource is still read, since the instance is deployed and has a name, and the summary records a gap saying which attribute was not settled. `appliesWhen` covers a different case: a resource that is not what the entry describes at all. A Firestore database in Datastore mode uses a different API, so that entry checks `type` and skips the resource entirely.

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

The contract lists every variable the process starts with, both the ones the configuration sets and the ones the platform adds, and marks which is which. `LOG_LEVEL` is recorded as the text it is set to. `ORDERS_TABLE` is set from another resource, so the contract records both the name that resource declares and which resource it was. Code that reads `process.env.ORDERS_TABLE` to address a table reaches the table through either.

The unit is the resource label, `confirm`, whatever name the function deploys under. The rest of the configuration refers to the resource by its label, the way CloudFormation uses a logical id, so a variable that points at the resource and the resource's own contract both use the same name.

One resource deploys several processes when the provider works that way. An ECS task definition produces one contract per container, and each container gets only its own variables.

Every value that cannot be settled is written the same way in a contract. An `image = var.image`, a `runtime`, and a handler supplied by a variable all come out as a pattern such as `{var.image}`, without the `$` of the raw `${var.image}`, so nothing later has to know which field it is reading. A handler with a hole in it does not show which file the code is in, since splitting it at its last dot would pick a module nobody deploys.

A configuration gives the handler that runs, but never the directory the deployed artifact was built from, so the handler is all the checker has to go on. A container deployable has no handler at all, since its image was built elsewhere. In that case the caller gives the location of the code with `--code-scope api/web=services/api`, or `codeScopes` in the read options. [Which code a deployable unit runs](./DESIGN.md#which-code-a-deployable-unit-runs) covers what that records, and what happens when two units point at one directory.

## What it will not tell you

- **Anything no loaded pack describes.** A resource that no entry covers, such as an IAM policy or a subnet, is skipped.
- **A resource built with `for_each` or `count`** has one `resource` block for many tables, and the reader reads the block as written without working out what it expands to. A `dynamic` block inside a resource is expanded, since it decides what a single deployed process is given.
- **A name that comes entirely from a variable**, such as `name = var.table_name`, has no fixed text to pair on, so the reader records nothing instead of guessing.
- **What a secret contains.** For a variable a secret supplies, the reader records which resource supplies it and nothing more, since no configuration writes the contents down.
- **Which source directory a deployable was built from.** Terraform builds the artifact outside the configuration. A `filename` is a zip nothing in the run can open, and a `source_dir` belongs to a data source the reader does not follow. `--code-scope` is how the caller supplies what the configuration never states.

## Where it fits in suss

The package depends on `@suss/behavioral-ir` for the summaries it produces, and on `hcl2-parser` for reading HCL. The storage pass in `@suss/checker` pairs what code touches with what this reader declares.

## More

- [How it reads a configuration](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
