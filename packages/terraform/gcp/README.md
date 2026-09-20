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
| `google_sql_database_instance` | a PostgreSQL, MySQL or SQL Server store, whichever its `database_version` picks; a version a variable supplies leaves the store with no engine on it |
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

A bucket pairs by name: `@suss/framework-gcs` records the bucket an access reaches, and the `name` attribute is the same string, so `suss check` compares the two sides. A Memorystore instance does not: code addresses Redis by key namespace, no attribute of the instance declares one, and a match on the instance's own name would be a coincidence, so the summary declares the store with no container name and the storage check claims no access for it. The `@suss/terraform-aws` DESIGN walks through the same decision for ElastiCache. Spanner, Firestore and Cloud SQL are the same case: the tables or collections are inside the database, and nothing on the resource lists them.

A BigQuery table is the one resource here with a field contract, since a query against it reads named columns. A Cloud Run service, a job and a function each declare the environment their containers start with. A Pub/Sub topic and subscription pair with nothing yet, because no code pack records a publish or a subscribe. [What each entry decided](./DESIGN.md) says how each of those is read.

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

- [What each entry decided](./DESIGN.md), the provider versions it was written against, and the pages it came from
