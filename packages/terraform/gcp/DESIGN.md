# Which provider versions the Google entries describe

The reference for `@suss/terraform-gcp`: the provider releases each entry was written against, and the pages they came from. The [README](./README.md) says what the pack reads and why.

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

The store names are the OpenTelemetry [`db.system.name`](https://opentelemetry.io/docs/specs/semconv/attributes-registry/db/) values, so a summary from a code pack and one from here spell the same store the same way.

## What a version range would be for

The Google provider renames blocks between majors, so two entries for one resource type, each with its own range, is how a rename is covered. Nothing here needs that yet: the attributes these entries read, a bucket's `name`, a table's `schema` and `dataset_id`, an instance's `database_version`, a topic's `name`, are spelled the same way in v4, v5 and v6. The Cloud Run and Cloud Functions blocks are where the v4-to-v5 rename bites, and no entry reads those.
