# @suss/terraform-aws

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This pack declares what the AWS Terraform provider's resources are, for `@suss/contract-terraform` to read.

## What this package is

A pack, made of data and nothing else. The reader walks HCL and has no knowledge of any provider. This pack declares that `aws_dynamodb_table` is a store keyed by `hash_key` and `range_key`, that `aws_sqs_queue` is a channel, and which provider versions each of those declarations applies to.

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

Everything else a configuration declares, such as a security group, a subnet or an IAM policy, is part of how the deployment is wired and is not something a caller addresses. So nothing reads it.

A database instance and a Redis cluster are the two that do not pair with anything. Code addresses tables and key namespaces inside them, and no attribute of either lists those, so each one declares the store and claims no access. Kinesis does not pair with anything yet either, since no code pack records a send to a stream. [Why each entry reads what it reads](./DESIGN.md) explains each of these, and what an alarm and a metric filter have in common.

## Why every entry states a version range

The provider moves things around between releases. Version 4 split a bucket's settings into separate resources, so `aws_s3_bucket_server_side_encryption_configuration` is a separate resource in a v4 configuration and an inline block in a v3 one. An entry written for the v4 layout declares that, and a configuration pinned to v3 is read only by the entries written for v3.

A configuration states its own pin:

```hcl
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
```

The reader takes that pin and passes it to the pack. A configuration with no pin is read by every entry, since nothing rules any of them out.

Every entry here was written against `>=4 <7`, from these pages of the provider's own documentation:

- [`aws_dynamodb_table`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/dynamodb_table), [`aws_s3_bucket`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/s3_bucket)
- [`aws_elasticache_cluster`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_cluster), [`aws_elasticache_replication_group`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/elasticache_replication_group)
- [`aws_rds_cluster`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/rds_cluster), [`aws_db_instance`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance)
- [`aws_sqs_queue`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sqs_queue), [`aws_sns_topic`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/sns_topic), [`aws_cloudwatch_event_bus`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_event_bus)
- [`aws_kinesis_stream`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_stream), [`aws_kinesis_firehose_delivery_stream`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/kinesis_firehose_delivery_stream)
- [`aws_cloudwatch_log_metric_filter`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_log_metric_filter), [`aws_cloudwatch_metric_alarm`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudwatch_metric_alarm)

## Where it fits in suss

The pack depends on `@suss/contract-terraform` for the type of an entry, and on `@suss/ir-core` for the variables each deployment target injects by itself. A pack for another provider, such as `google` or `cloudflare`, is the same file with different entries.

## More

- [Why each entry reads what it reads](./DESIGN.md)
- [Documentation](https://suss.sh/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
