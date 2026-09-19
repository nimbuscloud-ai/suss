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

## Several entries for one resource type

A pack states more than one entry for a resource type when the provider spells it differently across versions, and again when one attribute decides what the resource is. `aws_db_instance` is a PostgreSQL store or a MySQL one depending on its `engine`, and `google_sql_database_instance` on its `database_version`, so each has an entry per engine and a gate that picks between them. A gate matches whole values through `equals`, or the start of a value through `startsWith`, which is what Cloud SQL needs: `database_version` states an engine and a release together, `POSTGRES_15` and `MYSQL_8_0_31`, and the releases change every quarter.

## What it will not tell you

- **Only what a loaded pack describes.** A resource no entry covers, an IAM policy or a subnet, is skipped.
- **A resource built with `for_each` or `count`** states one block for many tables, and this reads the block as written rather than working out what it expands to.
- **A name a variable supplies whole**, `name = var.table_name`, has no fixed text to pair on, so it records nothing rather than guessing.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the summaries it produces and `hcl2-parser` for reading HCL. The storage pass in `@suss/checker` pairs what code touches against what this declares.

## More

- [How it resolves a reference](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
