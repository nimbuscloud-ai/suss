# @suss/terraform-aws

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
| `aws_sqs_queue` | a channel |
| `aws_sns_topic` | a channel |
| `aws_cloudwatch_event_bus` | a channel |

Everything else a configuration declares, a security group, a subnet, an IAM policy, is how the deployment is wired rather than something a caller addresses, so nothing reads it.

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

## Where it fits in suss

Depends on `@suss/contract-terraform` for the shape of an entry, and on nothing else. A pack for another provider, `google` or `cloudflare`, is the same file with different entries.
