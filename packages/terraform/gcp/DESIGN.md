# Why each Google entry reads what it reads

This covers the provider releases each entry in `@suss/terraform-gcp` was written against, the pages each came from, and why each entry reads what it reads. The [README](./README.md) lists what the pack covers.

Every entry was written against `>=4 <8`. A configuration states its own pin under `required_providers`, and the reader passes that pin to the pack. An entry outside the pin is not used. A configuration with no pin is read by every entry, since nothing rules any of them out.

```hcl
terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
```

The entries come from these pages of the provider's own documentation:

- [`google_storage_bucket`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/storage_bucket), [`google_redis_instance`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/redis_instance)
- [`google_bigquery_dataset`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/bigquery_dataset), [`google_bigquery_table`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/bigquery_table)
- [`google_sql_database_instance`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/sql_database_instance), and [the `database_version` list](https://cloud.google.com/sql/docs/db-versions) its prefixes come from
- [`google_spanner_database`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/spanner_database), [`google_firestore_database`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/firestore_database), [`google_bigtable_table`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/bigtable_table)
- [`google_pubsub_topic`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/pubsub_topic), [`google_pubsub_subscription`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/pubsub_subscription)
- [`google_logging_metric`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/logging_metric), [`google_monitoring_alert_policy`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/monitoring_alert_policy)
- [`google_cloud_run_v2_service`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_service), [`google_cloud_run_v2_job`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_job), [`google_cloudfunctions2_function`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloudfunctions2_function)

The store names are the OpenTelemetry [`db.system.name`](https://opentelemetry.io/docs/specs/semconv/attributes-registry/db/) values, so a summary from a code pack and one from here use the same name for the same store.

## What a version range would be for

The Google provider renames blocks between major versions. Two entries for one resource type, each with its own range, is how a rename would be covered. Nothing here needs that yet. The attributes these entries read, such as a bucket's `name`, a table's `schema` and `dataset_id`, an instance's `database_version` and a topic's `name`, are spelled the same way in v4, v5 and v6.

Cloud Run was where a rename seemed most likely, and the upgrade guides show it did not happen. The move to v5 removed `liveness_probe.tcp_socket` and changed the type of `volumes.cloud_sql_instance.instances`. The move to v6 added `deletion_protection`, and changed `containers.env` from a list to a set, which affects how state is addressed but not how the block is written. A container still writes `env { name = ... }` in all three major versions, so one entry covers them.

## A BigQuery table states its columns

A query against a table reads named columns, so the table is the only Google resource here with a field contract:

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

A table is always addressed through its dataset, so two tables called `orders` in two datasets are two containers, and the dataset goes on the boundary as its namespace. The reference to the dataset resource resolves, so the table ends up under `analytics` whether the configuration writes the string or points at the resource that declares it.

A schema written in the configuration lists every column the table has, so the contract says `exhaustive` and the checker can report a column it does not declare as unknown. `mode` says whether a column is always set. `REQUIRED` and `REPEATED` are, and everything else is nullable, which is also what BigQuery does when no mode is given. A schema supplied by a file or a variable is not written anywhere the reader can see, so the table records no columns and says `none`, and the reader does not guess.

Both ways of writing the schema are read, the literal above and a heredoc of JSON, because `jsonencode` over an HCL value and a JSON string end up the same once deployed.

## What Pub/Sub pairs with

Nothing yet. No code pack records a publish or a subscribe on Pub/Sub, so a topic and a subscription show up as declared channels that nothing paired with. They are separate channels on purpose. A publisher asks for the topic and a subscriber asks for the subscription, so those are the two strings code uses, and pairing them with each other would report the wrong side.

## Deployable entries

A Cloud Run container writes each variable as its own `env` block, with either a `value` or a `value_source.secret_key_ref`. When a variable's value refers to another resource, that resource is recorded, so code that reads the variable to address a bucket reaches the bucket. For a variable a secret supplies, the reader records the secret and no value, because the configuration does not contain one.

A service's containers are under `template`, and a job's are under `template.template`, and the entries point at those. A function's variables are a map under `service_config.environment_variables`, and each secret is one `secret_environment_variables` block.

Each entry lists what its own product adds to the environment, because the deployment target does not. A service gets `PORT`, `K_SERVICE`, `K_REVISION` and `K_CONFIGURATION`. A job gets `CLOUD_RUN_JOB` and the four `CLOUD_RUN_TASK_*` variables instead. A function gets `FUNCTION_TARGET` and `FUNCTION_SIGNATURE_TYPE` on top of a service's. The lists come from [the Cloud Run container runtime contract](https://cloud.google.com/run/docs/container-contract#services-env-vars), [the jobs contract](https://cloud.google.com/run/docs/container-contract#jobs-env-vars) and [Cloud Run functions' configured environment variables](https://cloud.google.com/functions/docs/configuring/env-var).

A second-generation function is deployed as a Cloud Run service, so its entry uses the same deployment target as a service.

A container has no handler, so its image is what shows which code it runs, and the image is recorded as the configuration writes it. An image built elsewhere means the unit has no code in this repository, and the unit is reported as one whose code could not be placed.
