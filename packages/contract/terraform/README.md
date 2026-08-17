# @suss/contract-terraform

Reads the storage a Terraform configuration declares, so code can be checked against it.

## What this package is

A contract reader. It walks `.tf` files for `aws_dynamodb_table` resources and describes each one as a boundary, the same way `@suss/contract-cloudformation` describes a table a template declares.

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

## What it will not tell you

- **Only DynamoDB tables.** An RDS instance, an S3 bucket, or an SQS queue declared in the same configuration is skipped.
- **A resource built with `for_each` or `count`** states one block for many tables, and this reads the block as written rather than working out what it expands to.
- **A name a variable supplies whole**, `name = var.table_name`, has no fixed text to pair on, so it records nothing rather than guessing.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the summaries it produces and `hcl2-parser` for reading HCL. The storage pass in `@suss/checker` pairs what code touches against what this declares.

## A way in that copies part of an item

A DynamoDB index does not carry the whole item. `projection_type = "INCLUDE"` copies the attributes it lists, `KEYS_ONLY` copies none, and both copy the index's keys and the table's. A reader asking that index for anything else gets nothing back for it, and the store raises no error, so the caller sees an item with fields missing and nothing says why.

So an index like that declares every field it will ever have, and its contract says `exhaustive` where the table's says `partial`. A pack states which attributes carry that, under `serves`, and a store without the idea leaves it out.
