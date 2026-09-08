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

## What it will not tell you

- **Only what a loaded pack describes.** A resource no entry covers, an IAM policy or a subnet, is skipped.
- **A resource built with `for_each` or `count`** states one block for many tables, and this reads the block as written rather than working out what it expands to.
- **A name a variable supplies whole**, `name = var.table_name`, has no fixed text to pair on, so it records nothing rather than guessing.

## Where it fits in suss

Depends on `@suss/behavioral-ir` for the summaries it produces and `hcl2-parser` for reading HCL. The storage pass in `@suss/checker` pairs what code touches against what this declares.

## More

- [How it resolves a reference](./DESIGN.md)
- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
