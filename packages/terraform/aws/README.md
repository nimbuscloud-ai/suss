# @suss/terraform-aws

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Says what AWS's Terraform provider declares, for `@suss/contract-terraform` to read.

## What this package is

A pack, and nothing but data. The reader walks HCL and knows nothing about any provider; this says that `aws_dynamodb_table` is a store keyed by `hash_key` and `range_key`, that `aws_sqs_queue` is a channel, and which provider versions each of those statements is about.

```ts
import { terraformFileToSummaries } from "@suss/contract-terraform";
import { awsTerraform } from "@suss/terraform-aws";

terraformFileToSummaries("infra/terraform/dynamodb", { packs: [awsTerraform()] });
```

`suss contract --from terraform <path>` loads it for you.

## What it reads today

| Resource | Becomes |
| --- | --- |
| `aws_dynamodb_table` | a store, keyed by `hash_key` and `range_key`, with each `global_secondary_index` and `local_secondary_index` as its own way in |
| `aws_s3_bucket` | a store whose objects have no fields to compare against |
| `aws_elasticache_cluster` | a Redis store, when `engine` is `redis` or `valkey`; a Memcached cluster is skipped |
| `aws_elasticache_replication_group` | a Redis store |
| `aws_rds_cluster` | a PostgreSQL or MySQL store, whichever its `engine` picks |
| `aws_db_instance` | the same, and `mariadb` counts as MySQL |
| `aws_sqs_queue` | a channel |
| `aws_sns_topic` | a channel |
| `aws_cloudwatch_event_bus` | a channel |
| `aws_kinesis_stream` | a channel |
| `aws_kinesis_firehose_delivery_stream` | a channel |
| `aws_cloudwatch_log_metric_filter` | a metric, identified by its namespace and its name together |
| `aws_cloudwatch_metric_alarm` | one consumer of that metric, identified the same way |
| `aws_lambda_function` | a deployable, with the variables it sets and the handler it calls |
| `aws_ecs_task_definition` | a deployable per container, with that container's variables, secrets and image |

Everything else a configuration declares, a security group, a subnet, an IAM policy, is how the deployment is wired rather than something a caller addresses, so nothing reads it.

## Why a database instance pairs with nothing

`aws_rds_cluster` and `aws_db_instance` declare that a PostgreSQL or a MySQL store exists, and no more. Code addresses tables inside the database, and no attribute of either resource lists one, so the same reasoning as for ElastiCache applies: the summary declares the store with no container name, and the storage check claims no access for it. What you get is visibility, a store the run saw, and the tables keep pairing between an ORM schema and the code that queries it.

The `engine` attribute decides which store the resource is, so the pack states one entry per engine and the gate picks between them. An engine outside those lists, `oracle-ee` or `sqlserver-ex`, is a store suss has no word for, so the resource goes unread rather than read as something it may not be.

## What Kinesis pairs with

Nothing yet. A stream and a delivery stream each become a channel, and no code pack records a send to either, so they show up as declared channels nothing paired with. They stay separate buses because the two are different APIs: a producer puts records on a stream and consumers read from it, while a delivery stream has no reader at all, it writes into a destination. Giving them one bus name would let a stream and a delivery stream called the same thing pair with each other.

## What an alarm and a metric filter share

CloudWatch identifies a metric by its namespace and its name together, and both sides of the pair write both:

```hcl
resource "aws_cloudwatch_log_metric_filter" "refusals" {
  name           = "refusals"
  log_group_name = "/aws/lambda/orders"
  pattern        = "{ $.outcome = \"refused\" }"

  metric_transformation {
    name      = "Refusals"
    namespace = "OrderService"
    value     = "1"
  }
}

resource "aws_cloudwatch_metric_alarm" "refusals_climbing" {
  alarm_name          = "refusals-climbing"
  namespace           = "OrderService"
  metric_name         = "Refusals"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 5
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
}
```

Both become `OrderService/Refusals`, so `suss check` reports an alarm on a metric nothing publishes, and a metric nothing watches.

The shape check `checkMetric` runs never fires here, and cannot: a metric filter only ever publishes a number, and an alarm only ever compares against one, so the two sides never disagree about shape. The pair is worth recording so the missing-side report can name it, rather than for a shape finding. An alarm that states `extended_statistic` rather than `statistic` does not record a reduction, because a percentile is written as `pNN.NN` and no fixed table can list those.

## What the AWS entries leave out

- **`aws_s3_bucket_versioning` and `aws_s3_bucket_lifecycle_configuration`**, and the rest of the v4 split resources, say how a bucket is administered rather than what a caller can address, so nothing reads them. The bucket itself is the boundary.
- **`aws_rds_cluster_instance`** is a compute node of the cluster `aws_rds_cluster` already declares, so reading it would count one store twice.
- **`aws_mq_broker`** runs ActiveMQ or RabbitMQ, and suss has no bus word for either, nor any pack that records a send to one. A bus value nothing produces would pair with nothing and say nothing.
- **An alarm written as `metric_query` blocks** states its metric inside a block while its threshold stays on the resource, and the entry reads one reading at a time, so only the direct form is read.
- **`filename` and `s3_key` on a function.** Both point at a deployed artifact rather than at source, so neither says where the code is, and the handler is what places the unit.

## What a deployable entry says

A function's variables are one map, `environment.variables`, and the entry says so. A task definition's are per container, inside `container_definitions`, which the provider takes as JSON; the reader reads what is inside a `jsonencode` call, so a task written the way the docs show it is read.

Both entries take the variables AWS injects on its own from the list every suss reader of an AWS deployment uses, so `AWS_REGION` is never reported as a variable nothing supplies. The lists come from [Lambda's reserved environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html) and [the ECS task metadata endpoint](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_metadata.html).

A container's `secrets` entry says which parameter or secret supplies a variable, and that resource is recorded. What the secret contains is not in the configuration, so nothing is recorded for the value.

## Why a Redis cluster pairs with nothing

Code addresses Redis by key namespace: `@suss/framework-redis` reads `session:{id}` and records the container `session`. A cluster declares no namespaces; its `cluster_id` is a deployment name, and code never spells it. The two sides share no name either can state, so the entry says so: the summary declares the store exists, with no container name, and the storage check claims no access for it. A pair between a cluster called `session` and the `session` namespace would be a coincidence between a deployment name and a key prefix, so the entry refuses it rather than reporting it.

What you get from the entry is visibility: `suss contract --from terraform` shows the cluster, and `suss check` reports it as a declared store nothing paired with. Namespace-level pairing stays between the code's own readers and writers of the same keys.

## Why every entry states a version range

The provider moves things between releases. Version 4 split a bucket's settings into resources of their own, so `aws_s3_bucket_server_side_encryption_configuration` is a separate resource in a v4 configuration and an inline block in a v3 one. An entry that describes the v4 shape says so, and a configuration pinned to v3 is read by the entries written for v3 and by none of the others.

A configuration states its own pin:

```hcl
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
```

The reader takes that pin and hands it to the pack. A configuration that pins nothing is read by every entry, since nothing said otherwise.

Every entry here was written against `>=4 <7`, from these pages of the provider's own documentation:

- [`aws_dynamodb_table`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table), [`aws_s3_bucket`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket)
- [`aws_elasticache_cluster`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_cluster), [`aws_elasticache_replication_group`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_replication_group)
- [`aws_rds_cluster`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/rds_cluster), [`aws_db_instance`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance)
- [`aws_sqs_queue`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue), [`aws_sns_topic`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sns_topic), [`aws_cloudwatch_event_bus`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_bus)
- [`aws_kinesis_stream`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_stream), [`aws_kinesis_firehose_delivery_stream`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_firehose_delivery_stream)
- [`aws_cloudwatch_log_metric_filter`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter), [`aws_cloudwatch_metric_alarm`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm)

## Where it fits in suss

Depends on `@suss/contract-terraform` for the shape of an entry, and on nothing else. A pack for another provider, `google` or `cloudflare`, is the same file with different entries.
