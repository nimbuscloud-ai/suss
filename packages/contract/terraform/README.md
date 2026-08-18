# @suss/contract-terraform

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

## A way in that copies part of an item

A DynamoDB index does not carry the whole item. `projection_type = "INCLUDE"` copies the attributes it lists, `KEYS_ONLY` copies none, and both copy the index's keys and the table's. A reader asking that index for anything else gets nothing back for it, and the store raises no error, so the caller sees an item with fields missing and nothing says why.

So an index like that declares every field it will ever have, and its contract says `exhaustive` where the table's says `partial`. A pack states which attributes carry that, under `serves`, and a store without the idea leaves it out.

## A resource that reads what another one declares

Some resources refer to another resource by the string the deployment gives it. An alert refers to a metric that way, and a metric declares itself:

```hcl
resource "signals_counter" "refusals" {
  name = "${var.environment}-refusals"

  shape {
    value_type = "SPREAD"
  }
}

resource "signals_watch" "refusals_climbing" {
  rules {
    over_threshold {
      selector = "signal.id=\"signals.example/counters/${var.environment}-refusals\" AND region=\"west\""
      limit    = 5
    }
  }
}
```

An entry with `kind: "metric"` says which attribute is the name and how the deployed identity is spelled around it, as `metricTypeTemplate`, so the reader can build the string the other side spells. An entry with `kind: "metric-reading"` says which blocks one reading is written inside, which attribute is the selector, and which key inside that selector is the metric. Each reading becomes its own consumer summary, since one resource usually states several, each about a different metric.

The selector is a small query language rather than a name, so `parseFilterQuery` reads it: comparisons joined by `AND` and `OR`, with parentheses, `NOT`, quoted or bare values, and terms written next to each other for AND. A key may quote one of its own segments, `metric.label."response_code_class"`, and that comes back as one key with the quotes off. A call may stand where a comparison would, which is how Cloud Monitoring writes an SLO burn-rate condition, and `filterCalls` gives those back. The parser is exported, so a pack that has to read the same string for something else does not write a second one. A selector it cannot read leaves the reading with no metric on it, which pairs with nothing.

Both kinds also say what the resource's own words mean in suss's terms, so the checker never learns a provider's vocabulary. A pack writes `values: { attribute: "shape.value_type", means: { SPREAD: "spread", SCALAR: "number" } }`, the reader takes the value at that attribute, dotted paths stepping into nested blocks, looks it up in the table, and writes the answer to `metricContract` on the summary. `accumulates` works the same way. A value the table does not list says nothing, the same as an attribute the configuration never set.

A reading translates two things the same way. `comparesTo: { attribute: "limit", whenSet: "number" }` says the reading compares the series against a single number when it states a limit at all, since a threshold is a number by being written down. `reducesTo` maps an aligner or reducer to what it leaves behind. Both land on the summary under `metricReading`, along with the setting and the values that would reduce the series, so a finding can name the fix without the checker knowing which provider it came from.

Comparing the two sides is `checkMetric` in `@suss/checker`, and it runs off summaries alone. No pack is loaded at check time.

## A reference to a resource in the same configuration

The side that reads a metric often spells the name through a Terraform reference rather than by copying the string:

```hcl
resource "signals_counter" "refused" {
  name = "edp-sweep-refused"
}

resource "signals_watch" "refused_sustained" {
  rules {
    over_threshold {
      selector = "signal.id=\"signals.example/counters/${signals_counter.refused.name}\""
    }
  }
}
```

Both resources deploy the same string, and the configuration already says what it is, so the reference resolves to `signals.example/counters/edp-sweep-refused` on both summaries and the two pair. Left as the hole `{signals_counter.refused.name}`, the two sides of one configuration spell the same metric differently and pair with nothing.

Only `<resource_type>.<label>.<attribute>` resolves, and only when that resource writes the attribute as a literal string. An attribute the provider fills in at apply time, an `id` or an `arn` or a `self_link`, is not written anywhere in the file, so nothing is found and the hole stays. `var.` and `local.` stay holes as well: a variable's default is not what production runs with, and a name built from a stage prefix has to go on pairing with whatever stage the code that meets it was written for.

A reference whose attribute is itself built from another reference is followed four hops, and then the hole stays. Two resources that refer to each other leave the value exactly as it was written.

The scope is every file being read together, so a reference finds a resource another file in the module states, the way Terraform reads a module.

## A name a locals block states

A configuration that writes `local.table_name = "orders-v1"` and refers to it from every resource has stated that name as plainly as a resource would, so a reference to it resolves. One built from a variable, `"${var.environment}-orders-v1"`, expands to a value that still has a variable in it, which becomes a hole again, so a name built from a stage prefix reads the way it always did.
