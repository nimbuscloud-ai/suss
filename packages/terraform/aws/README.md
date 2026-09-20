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
| `aws_elasticache_cluster` | a Redis store, when `engine` is `redis` or `valkey` or unset; any other engine leaves the store with no engine on it |
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

A database instance and a Redis cluster are the two that pair with nothing: code addresses tables and key namespaces inside them, and no attribute of either lists one, so each declares the store and claims no access. Kinesis pairs with nothing yet either, since no code pack records a send to a stream. [What each entry decided](./DESIGN.md) says why for each of them, and what an alarm and a metric filter share.

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

Depends on `@suss/contract-terraform` for the shape of an entry, and on `@suss/ir-core` for the variables each deployment target injects on its own. A pack for another provider, `google` or `cloudflare`, is the same file with different entries.

## More

- [What each entry decided](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
