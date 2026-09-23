# How the Terraform reader reads a configuration

`@suss/contract-terraform` follows some references and leaves others as written. It expands repeated blocks, walks into module calls, and works out which code a deployable unit runs. The [README](./README.md) explains what the package is for.

## An index that copies part of an item

A DynamoDB index does not contain the whole item. `projection_type = "INCLUDE"` copies the attributes it lists, and `KEYS_ONLY` copies none. Both copy the index's keys and the table's. If a reader asks that index for any other attribute, it gets nothing back and the store raises no error, so the caller sees an item with fields missing and no explanation.

So an index like that declares every field it will ever have, and its contract says `exhaustive` where the table's says `partial`. A pack lists which attributes control this, under `serves`. A store without this concept leaves it out.

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

An entry with `kind: "metric"` gives the pattern of the deployed identity as a `metricTypeTemplate`, whose `{...}` holes are attribute paths on the resource. The reader uses it to build the same string the other side writes. If the resource leaves one of those attributes unset, the whole identity is unknown, since half a name is as likely to pair with the wrong metric as with the right one.

An entry with `kind: "metric-reading"` lists the blocks that one reading is written inside, and how that reading refers to the metric it is about. Two providers do this differently, and both are covered. Cloud Monitoring writes a selector, so the entry gives the attribute and the key inside it, `{ from: "query", attribute: "filter", key: "metric.type" }`. CloudWatch writes the namespace and the name as attributes of the alarm, so the entry gives a template instead, `{ from: "attributes", template: "{namespace}/{metric_name}" }`. Each reading becomes its own consumer summary, since one resource usually has several, each about a different metric.

The selector is written in a small query language, so `parseFilterQuery` reads it. It handles comparisons joined by `AND` and `OR`, parentheses, `NOT`, quoted or bare values, and terms written next to each other, which mean AND. A key can quote one of its own segments, as in `metric.label."response_code_class"`, and that comes back as one key with the quotes removed. A call can stand where a comparison would, which is how Cloud Monitoring writes an SLO burn-rate condition, and `filterCalls` returns those. The parser is exported, so a pack that has to read the same string for another reason does not need its own. If the parser cannot read a selector, the reading has no metric on it and does not pair with anything.

Both kinds of entry also translate the resource's own terms into suss's, so the checker never needs to know a provider's vocabulary. A pack writes `values: { attribute: "shape.value_type", means: { SPREAD: "histogram", SCALAR: "number" } }`. The reader takes the value at that attribute, with dotted paths going into nested blocks, looks it up in the table, and writes the result to `metricContract` on the summary. `accumulates` works the same way. A value the table does not list records nothing, the same as an attribute the configuration never set.

A reading translates two more things the same way. `comparesTo: { attribute: "limit", whenSet: "number" }` means the reading compares the series against a single number whenever it sets a limit, since a threshold that is written down is a number. `reducesTo` maps an aligner or reducer to what it leaves behind. Both end up on the summary under `metricReading`, along with the setting and the values that would reduce the series. So a finding can suggest the fix without the checker knowing which provider the resource came from.

`checkMetric` in `@suss/checker` compares the two sides, using only the summaries. No pack is loaded at check time.

## A reference to a resource in the same configuration

The side that reads a metric often refers to the name through a Terraform reference instead of copying the string:

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

Both resources deploy the same string, and the configuration already states it, so the reference resolves to `signals.example/counters/edp-sweep-refused` on both summaries and the two pair. If the reference were left as the hole `{signals_counter.refused.name}`, the two sides of one configuration would write the same metric differently and would not pair.

Only `<resource_type>.<label>.<attribute>` resolves, and only when that resource sets the attribute to a literal string. An attribute the provider fills in at apply time, such as an `id`, an `arn` or a `self_link`, is not written in the file, so the reader finds nothing and the hole stays. A `var.` at the root also stays a hole. A variable's default is not what production runs with, and a name built from a stage prefix has to keep pairing with whatever stage the matching code was written for.

When a reference's attribute is itself built from another reference, the reader follows up to four hops, and then leaves the hole. Two resources that refer to each other keep the value exactly as written.

The scope is every file read together, so a reference can find a resource declared in another file of the module, the same way Terraform reads a module.

## A name a locals block states

A configuration that writes `local.table_name = "orders-v1"` and refers to it from every resource has stated that name as directly as a resource would, so a reference to it resolves. A local built from a variable, such as `"${var.environment}-orders-v1"`, expands to a value that still contains a variable, which becomes a hole again. So a name built from a stage prefix is read the same way as before.

## A module call this reader follows

Many configurations declare no resources at the root. They call one module per service, and every table and function is inside the child:

```hcl
locals {
  stage = "prod"
}

module "orders" {
  source     = "./modules/store"
  stage      = local.stage
  table_name = "orders-v1"
}
```

When a `source` points at a directory next to this one, with `./` or `../`, the reader follows it and reads that directory's `.tf` files as a module of their own. Everything the child declares gets `module.orders.` in front of its summary name and its deployable unit, so calling one module twice gives two sets of boundaries, and they do not collide. A directory that would call itself back is read once.

A `source` that points at a registry, a git repository or an S3 bucket is code outside the repository, so the reader skips it and records nothing about its contents. An argument built from another module's output does not resolve either, since the arguments of every call are settled before any child is read.

## A variable a module call passed in

Each module gets its own scope, since a child's `local.stage` belongs to the child and has nothing to do with the root's. The two scopes are joined in the two places Terraform joins them.

Going down, `var.table_name` inside a child resolves to the literal that the calling `module` block passed in. So a module called twice with two table names declares two tables, and each one pairs with the code that addresses it. An argument built at deploy time is a hole under another name, so the child keeps its own hole instead of taking the parent's. A configuration read at its root has nothing to pass its variables in, and `${var.stage}` there stays a hole, as before.

A map argument is passed whole, which is how a module usually receives the environment it gives its container. The root writes `env = { ORDERS_TABLE = example_table.orders.name }`, the child writes `for_each = var.env`, and the expansion uses the keys of the passed map. Each entry is read in the module that wrote it, so the reference above comes out as the table's own name. An entry the parent could not settle is passed as written, and becomes a hole in the child like any other value. What the call passed wins over the `variable` block's own `default`, which only fills a value the call left out.

Going up, `module.orders.table_name` resolves through the child's `output` block, but only when the value settles inside the child. An output that still has a hole in it is left out, so the parent reads `{module.orders.table_name}` and does not pair on half a name.

A `variable` block's own `default` is not used to resolve anything. It is what a deployment gets if it passes nothing, which is a guess about production. The one place it is read is a `for_each`, where it decides how many blocks the module writes, and not what any of them contains.

## A block written once and deployed many times

A module rarely writes a container's variables one block at a time. It writes one block and gives what to iterate over:

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

A `for_each` settles when the configuration already gives its contents: a map literal, a `locals` entry, a `variable` block's `default`, an argument a `module` call passed in, or a `merge` of those. Each key becomes one block, with `env.key`, `env.value` and `env.value.<field>` filled in, and the resulting block is read exactly as if it were written by hand. So this container declares `DB_NAME`, `LOG_LEVEL` and `SERVICE_ROLE`, with `DB_NAME` set to the pattern `{var.db_name}` and `SERVICE_ROLE` set to the text `api`. A module that renames the iterator with `iterator = item` is read the same way.

ECS takes its containers as JSON instead of blocks, so the same environment is written `environment = [for k, v in local.worker_env : { name = k, value = v }]`, and that expands the same way.

A `for_each` that cannot be settled, such as one a data source supplies, leaves the container with only the variables the platform injects. A `merge` with one of its parts missing would list fewer keys than the deployment will have, which is worse than listing none, so it does not settle either. An expanded block that still contains its iterator, because the content reaches deeper into an entry than the map goes, is left out for the same reason.

## Which code a deployable unit runs

A configuration gives the handler that runs, but never the directory the deployed artifact was built from. When the handler matches a module in the run, that module's imports are the code the unit runs. When it matches nothing, the unit is reported as one whose code could not be placed, and it is not given the whole repository.

A container deployable has no handler at all, since its image was built elsewhere, so the caller gives the location of the code:

```bash
suss contract --from terraform infra/ --code-scope api/web=services/api
```

`codeScopes` in the read options does the same thing in the library. The name on the left is the unit's instance name, as the summary records it: `confirm` for a Lambda resource labelled `confirm`, `api/web` for the `web` container of a task definition labelled `api`, and `module.orders.writer` for a resource read through a `module` block. The summary gets `codeScope: { kind: "codeUri", path }`, the same value a CloudFormation template's own `CodeUri` produces.

If two units point at one directory, that directory no longer decides anything. A file in it that does not declare a unit of its own is contested between them, so it pairs with neither, and the check explains why. Give each unit the narrowest directory that contains only its own code.
