# What each Google entry decided

The reference for `@suss/terraform-gcp`: the provider releases each entry was written against, the pages they came from, and why each entry reads what it reads. The [README](./README.md) says what the pack covers.

Every entry was written against `>=4 <8`. A configuration states its own pin under `required_providers`, the reader hands that pin to the pack, and an entry outside it is not read. A configuration that pins nothing is read by every entry, since nothing said otherwise.

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

The store names are the OpenTelemetry [`db.system.name`](https://opentelemetry.io/docs/specs/semconv/attributes-registry/db/) values, so a summary from a code pack and one from here spell the same store the same way.

## What a version range would be for

The Google provider renames blocks between majors, so two entries for one resource type, each with its own range, is how a rename is covered. Nothing here needs that yet: the attributes these entries read, a bucket's `name`, a table's `schema` and `dataset_id`, an instance's `database_version`, a topic's `name`, are spelled the same way in v4, v5 and v6.

Cloud Run was the place to expect one, and the upgrade guides say it did not happen. Going to v5 removed `liveness_probe.tcp_socket` and retyped `volumes.cloud_sql_instance.instances`; going to v6 added `deletion_protection` and retyped `containers.env` from a list to a set, which changes how state is addressed rather than how the block is written. A container still writes `env { name = ... }` in all three majors, so one entry covers them.

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
