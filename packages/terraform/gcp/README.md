# @suss/terraform-gcp

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Says what Google Cloud's Terraform provider declares, for `@suss/contract-terraform` to read.

## What this package is

A pack, and nothing but entries. Each one says what a resource is, and what its own words mean in the terms suss compares boundaries in.

```ts
import { terraformFileToSummaries } from "@suss/contract-terraform";
import { googleTerraform } from "@suss/terraform-gcp";

const summaries = terraformFileToSummaries("infra/terraform/monitoring", {
  packs: [googleTerraform()],
});
```

`suss contract --from terraform <path>` loads the entries for you. Nothing here runs at check time: the summaries contain what a metric measures and what a reading needs, and `checkMetric` in `@suss/checker` compares them, so `suss check --dir` over a folder of summaries reports the pair below with no pack loaded.

## What it reads today

| Resource | Becomes |
| --- | --- |
| `google_storage_bucket` | a store whose objects have no fields to compare against, under the name code passes to `bucket()` |
| `google_redis_instance` | a Redis store with no container to pair on; see below |
| `google_bigquery_dataset` | a BigQuery store; the dataset is a namespace rather than something a query addresses |
| `google_bigquery_table` | a BigQuery table in that dataset, with every column its `schema` states |
| `google_sql_database_instance` | a PostgreSQL or MySQL store, whichever its `database_version` picks |
| `google_spanner_database` | a Spanner store with no container to pair on |
| `google_firestore_database` | a Firestore store, when its `type` is `FIRESTORE_NATIVE` |
| `google_bigtable_table` | a Bigtable table, under the id code passes to `table()` |
| `google_pubsub_topic` | a channel |
| `google_pubsub_subscription` | a channel of its own, since a subscriber asks for the subscription |
| `google_logging_metric` | a metric, identified by the type Cloud Monitoring gives it, `logging.googleapis.com/user/<name>` |
| `google_monitoring_alert_policy` | one consumer of a metric per `condition_threshold`, identified by the `metric.type` its filter states |
| `google_cloud_run_v2_service` | a deployable per container, with that container's variables, secrets and image |
| `google_cloud_run_v2_job` | the same, with the containers one template deeper |
| `google_cloudfunctions2_function` | a deployable, with `service_config`'s variables and secrets and the entry point it calls |

Everything else a configuration declares is skipped.

A bucket pairs by name: `@suss/framework-gcs` records the bucket an access reaches, and the `name` attribute is the same string, so `suss check` compares the two sides. A Memorystore instance does not: code addresses Redis by key namespace, no attribute of the instance declares one, and a match on the instance's own name would be a coincidence, so the summary declares the store with no container name and the storage check claims no access for it. The `@suss/terraform-aws` README walks through the same decision for ElastiCache. Spanner, Firestore and Cloud SQL are the same case: the tables or collections are inside the database, and nothing on the resource lists them.

## A BigQuery table states its columns

A query against a table is a read of named columns, so the table is the one Google resource here with a field contract:

```hcl
resource "google_bigquery_dataset" "analytics" {
  dataset_id = "analytics"
  location   = "US"
}

resource "google_bigquery_table" "orders" {
  dataset_id = google_bigquery_dataset.analytics.dataset_id
  table_id   = "orders"

  schema = jsonencode([
    { name = "order_id", type = "STRING", mode = "REQUIRED" },
    { name = "placed_at", type = "TIMESTAMP", mode = "NULLABLE" },
  ])
}
```

A table is always addressed through its dataset, so two tables called `orders` in two datasets are two containers, and the dataset goes on the boundary as its namespace. The reference to the dataset resource resolves, so the table lands under `analytics` whether the configuration writes the string or points at the resource that states it.

A schema written in the configuration is every column the table has, so the contract says `exhaustive` and the checker can call a column it does not declare unknown. `mode` says whether a column is always set: `REQUIRED` and `REPEATED` are, and everything else is nullable, which is what BigQuery does with a mode nobody wrote. A schema a file or a variable supplies is not written down anywhere the reader can see, so the table records no columns and says `none` rather than guessing.

Both spellings of the schema are read, the literal above and a heredoc of JSON, because `jsonencode` over an HCL value and a JSON string end up the same once deployed.

## What Pub/Sub pairs with

Nothing yet: no code pack records a publish or a subscribe on Pub/Sub, so a topic and a subscription show up as declared channels nothing paired with. They are separate channels on purpose. A publisher asks for the topic and a subscriber asks for the subscription, so those are the two strings code spells, and pairing them with each other would report the wrong side.

## What a deployable entry says

A Cloud Run container writes each variable as its own `env` block, with either a `value` or a `value_source.secret_key_ref`. A variable whose value refers to another resource records that resource, so code reading it to address a bucket reaches the bucket. A variable a secret supplies records the secret and no value, because the configuration does not contain one.

A service's containers are under `template`, a job's under `template.template`, and the entries say so. A function's variables are a map under `service_config.environment_variables`, with each secret one `secret_environment_variables` block.

Each entry states what its own product puts in the environment, because the deployment target does not say: a service gets `PORT`, `K_SERVICE`, `K_REVISION` and `K_CONFIGURATION`, a job gets `CLOUD_RUN_JOB` and the four `CLOUD_RUN_TASK_*` variables instead, and a function gets `FUNCTION_TARGET` and `FUNCTION_SIGNATURE_TYPE` on top of a service's. The lists come from [the Cloud Run container runtime contract](https://cloud.google.com/run/docs/container-contract#services-env-vars), [the jobs contract](https://cloud.google.com/run/docs/container-contract#jobs-env-vars) and [Cloud Run functions' configured environment variables](https://cloud.google.com/functions/docs/configuring/env-var).

A second-generation function is deployed as a Cloud Run service, so its entry uses the same deployment target a service does.

A container states no handler, so what says which code it runs is its image, recorded as the configuration writes it. An image built elsewhere means the unit has no code in this repository, and the unit is reported as one whose code could not be placed.

## The pair the provider refuses

A log-based metric can declare that each measurement is a histogram of buckets:

```hcl
resource "google_logging_metric" "sweep_refused" {
  name = "sweep-refused"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
  }
}
```

An alert policy refers to it through a filter string, and compares it to a number:

```hcl
condition_threshold {
  filter          = "metric.type=\"logging.googleapis.com/user/sweep-refused\" AND resource.type=\"cloud_run_revision\""
  comparison      = "COMPARISON_GT"
  threshold_value = 5
}
```

Both blocks are well formed, `terraform validate` and `terraform plan` both pass, and the apply fails minutes in: a distribution has no single value to compare, and Cloud Monitoring wants an aligner such as `ALIGN_PERCENTILE_95` to reduce each window to one number first.

The entries say that `value_type = "DISTRIBUTION"` means the measurements are a histogram, that a `threshold_value` means the condition compares against a single number, and that the four percentile aligners are the ones that reduce a window to a number. `checkMetric` puts those together and reports the pair as a `boundaryShapeMismatch` at error severity, naming `aggregations.per_series_aligner` and the four values that would fix it.

A condition that states one of the percentile aligners is left alone, as is a condition on a metric declared as `INT64` or `DOUBLE`.

## What it will not tell you

- **A condition about a metric nothing in the run declares** says nothing. Most alerts watch metrics the platform publishes, and a metric declared in a module this run did not read looks the same from here. The pairing pass reports a boundary with one side missing.
- **A condition that states no `metric.type`** leaves the condition with no metric type on it, so it pairs with nothing rather than pairing with the wrong thing. An SLO burn-rate condition is written as a call rather than a comparison, and it is about an objective rather than a metric, so it lands here.
- **A metric the platform publishes**, `run.googleapis.com/request_latencies` and everything like it, states its value type in Google's documentation rather than in any configuration. Judging a condition on one of those needs a catalog this does not ship.
- **A `BOOL`, `STRING`, or `MONEY` metric** is left out of the value-type table, because none of suss's words describe one, and a metric this pack says nothing about is compared against nothing.
- **`for_each` and `count`** state one block for many resources, and the reader takes the block as written.
- **`google_sql_database`**, the named database inside a Cloud SQL instance, states no engine of its own. Which store it is lives on the instance its `instance` attribute points at, and an entry has no way to read an attribute through a reference to another resource, so the database goes unread and the instance is what declares the store.
- **`google_monitoring_uptime_check_config`** is a probe rather than a reading: it makes its own requests on a schedule and publishes a result, so it never reads a metric type back and `checkMetric` has nothing to compare. It would fit a kind for a synthetic check, which suss does not have.
- **A Spanner database's `ddl`** statements state the tables, and reading SQL out of a Terraform attribute is a job for the SQL readers rather than for this pack.
- **A Firestore database in Datastore mode** speaks a different API from the Firestore one, so the entry's gate turns it down rather than reading it as something it may not be.

## How the identity is built

Cloud Monitoring puts every metric a project defines for itself under `logging.googleapis.com/user/`, and the alert spells that whole string, so the whole string is the identity the two sides share. A name built at deploy time keeps its hole: `name = "${var.environment}-refusals"` becomes `logging.googleapis.com/user/{var.environment}-refusals`, and a filter that interpolates the same variable is spelled the same way.

## Where it fits in suss

Depends on `@suss/contract-terraform` for the shape of an entry and on `@suss/behavioral-ir` for the words a translation table is allowed to use. The reader knows nothing about Google, and neither does the checker: Google's vocabulary starts and stops in the entries here.

## More

- [Which provider versions the entries describe](./DESIGN.md), and the pages they came from
