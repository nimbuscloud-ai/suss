# How the Terraform reader reads a configuration

The reference for `@suss/contract-terraform`: the references it follows and the ones it leaves as written, the blocks it expands, the module calls it walks into, and how a deployable unit is placed. The [README](./README.md) says what the package is for.

## A way in that copies part of an item

A DynamoDB index does not contain the whole item. `projection_type = "INCLUDE"` copies the attributes it lists, `KEYS_ONLY` copies none, and both copy the index's keys and the table's. A reader asking that index for anything else gets nothing back for it, and the store raises no error, so the caller sees an item with fields missing and nothing says why.

So an index like that declares every field it will ever have, and its contract says `exhaustive` where the table's says `partial`. A pack states which attributes have that, under `serves`, and a store without the idea leaves it out.

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

An entry with `kind: "metric"` says how the deployed identity is spelled, as a `metricTypeTemplate` whose `{...}` holes are attribute paths on the resource, so the reader can build the string the other side spells. A hole the resource leaves unset makes the whole identity unknown, since half a name pairs with the wrong metric as readily as with the right one.

An entry with `kind: "metric-reading"` says which blocks one reading is written inside, and how that reading spells the metric it is about. Two providers do that differently and both are covered. Cloud Monitoring states a selector, so the entry gives the attribute and the key inside it, `{ from: "query", attribute: "filter", key: "metric.type" }`. CloudWatch writes the namespace and the name in attributes of the alarm, so the entry gives a template instead, `{ from: "attributes", template: "{namespace}/{metric_name}" }`. Each reading becomes its own consumer summary, since one resource usually states several, each about a different metric.

The selector is a small query language rather than a name, so `parseFilterQuery` reads it: comparisons joined by `AND` and `OR`, with parentheses, `NOT`, quoted or bare values, and terms written next to each other for AND. A key may quote one of its own segments, `metric.label."response_code_class"`, and that comes back as one key with the quotes off. A call may stand where a comparison would, which is how Cloud Monitoring writes an SLO burn-rate condition, and `filterCalls` gives those back. The parser is exported, so a pack that has to read the same string for something else does not write a second one. A selector it cannot read leaves the reading with no metric on it, which pairs with nothing.

Both kinds also say what the resource's own words mean in suss's terms, so the checker never learns a provider's vocabulary. A pack writes `values: { attribute: "shape.value_type", means: { SPREAD: "histogram", SCALAR: "number" } }`, the reader takes the value at that attribute, dotted paths stepping into nested blocks, looks it up in the table, and writes the answer to `metricContract` on the summary. `accumulates` works the same way. A value the table does not list says nothing, the same as an attribute the configuration never set.

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

Only `<resource_type>.<label>.<attribute>` resolves, and only when that resource writes the attribute as a literal string. An attribute the provider fills in at apply time, an `id` or an `arn` or a `self_link`, is not written anywhere in the file, so nothing is found and the hole stays. A `var.` at the root stays a hole: a variable's default is not what production runs with, and a name built from a stage prefix has to go on pairing with whatever stage the code that meets it was written for.

A reference whose attribute is itself built from another reference is followed four hops, and then the hole stays. Two resources that refer to each other leave the value exactly as it was written.

The scope is every file being read together, so a reference finds a resource another file in the module states, the way Terraform reads a module.

## A name a locals block states

A configuration that writes `local.table_name = "orders-v1"` and refers to it from every resource has stated that name as plainly as a resource would, so a reference to it resolves. One built from a variable, `"${var.environment}-orders-v1"`, expands to a value that still has a variable in it, which becomes a hole again, so a name built from a stage prefix reads the way it always did.

## A module call this reader follows

Plenty of configurations declare no resources at all at the root. They call a module per service, and every table and function is inside the child:

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

A `source` that says which directory beside this one, `./` or `../`, is followed, and that directory's `.tf` files are read as a module of their own. Everything the child declares gets `module.orders.` in front of its summary name and its deployable unit, so calling one module twice gives two sets of boundaries rather than one set that collides. A directory that would call itself back is read once.

A `source` pointing at a registry, a git repository or an S3 bucket is code the repository does not contain, so it is skipped and nothing is said about what is inside. An argument built from another module's output does not resolve either, since the arguments of every call are settled before any child is read.

## A variable a module call passed in

Each module gets a scope of its own, since a child's `local.stage` is the child's and says nothing about the root's. The two are joined in the two places Terraform joins them.

Going down, `var.table_name` inside a child resolves to the literal the calling `module` block passed in, so a module called twice with two table names declares two tables and each one pairs with the code that addresses it. An argument built at deploy time is a hole with another name on it, so the child keeps its own hole rather than taking the parent's. A configuration read at its root has nothing to pass its variables in, and `${var.stage}` there stays a hole as it always has.

A map argument crosses whole, which is how a module usually takes the environment it hands its container: the root writes `env = { ORDERS_TABLE = example_table.orders.name }`, the child writes `for_each = var.env`, and the keys of the passed map are what the expansion writes. Each entry is read in the module that wrote it, so the reference above comes out as the table's own name, and an entry the parent could not settle crosses as written and becomes a hole in the child like any other value. What the call passed wins over the `variable` block's own `default`, which fills only a gap the call left.

Going up, `module.orders.table_name` resolves through the child's `output` block, and only when the value settles inside the child. An output that still has a hole in it is left out, so the parent reads `{module.orders.table_name}` and pairs on nothing rather than on half a name.

A `variable` block's own `default` resolves nowhere. It says what a deployment would get if it passed nothing, which is a guess about production. The one reader of it is a `for_each`, where it decides how many blocks the module writes rather than what any of them says.

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

`for_each` settles where the configuration already says what is in it: a map literal, a `locals` entry, a `variable` block's `default`, an argument a `module` call passed in, or a `merge` of those. Each key becomes one block, with `env.key`, `env.value` and `env.value.<field>` filled in, and the block that comes out is read exactly as a hand-written one would be. So this container declares `DB_NAME`, `LOG_LEVEL` and `SERVICE_ROLE`, with `DB_NAME` set to the pattern `{var.db_name}` and `SERVICE_ROLE` to the text `api`. A module that renames the iterator with `iterator = item` is read the same way.

ECS takes its containers as JSON rather than as blocks, so the same environment is written `environment = [for k, v in local.worker_env : { name = k, value = v }]`, and that expands the same way.

A `for_each` nothing settles, one a data source supplies, leaves the container with the variables the platform injects and nothing else. A `merge` missing one of its parts states fewer keys than the deployment will, which is worse than stating none, so it settles nothing either. An expanded block that still has its iterator in it, where the content reaches deeper into an entry than the map goes, is left out for the same reason.

## Which code a deployable unit runs

A configuration says which handler runs and never which directory the deployed artifact was built from. Where the handler matches a module in the run, that module's imports are the code the unit runs. Where it matches nothing, the unit is reported as one whose code could not be placed rather than being given the repository.

A container deployable states no handler at all, since its image was built somewhere else, so the caller says where the code is:

```bash
suss contract --from terraform infra/ --code-scope api/web=services/api
```

`codeScopes` on the read options does the same thing in the library. The name on the left is the unit's instance name, the one the summary states: `confirm` for a Lambda resource labelled `confirm`, `api/web` for the `web` container of a task definition labelled `api`, and `module.orders.writer` for a resource read through a `module` block. What goes on the summary is `codeScope: { kind: "codeUri", path }`, the same thing a CloudFormation template's own `CodeUri` produces.

Pointing two units at one directory makes that directory decide nothing. A file in it that states no unit of its own is contested between them, so it pairs with neither and the check says why. Give each unit the narrowest directory that contains only its code.
