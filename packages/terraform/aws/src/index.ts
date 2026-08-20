/**
 * What AWS's Terraform provider declares, as far as suss reads it.
 *
 * Every entry says which provider versions it describes. The provider
 * moves things between releases, so a configuration pinned to one major
 * is read by the entries written for it and by no others. Version 4
 * split a bucket's settings into resources of their own, which is why
 * the bucket entry starts there.
 */

import type { TerraformPack } from "@suss/contract-terraform";

/** The versions each entry below was written against. */
const CURRENT = ">=4 <7";

export function awsTerraform(): TerraformPack {
  return {
    name: "terraform-aws",
    provider: "aws",
    resources: [
      {
        resource: "aws_dynamodb_table",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "aws.dynamodb",
          // A caller reaches a table through the SDK over HTTPS rather
          // than through a wire protocol of its own.
          transport: "aws-sdk",
          nameAttribute: "name",
          // A table declares its key attributes and lets every other
          // attribute vary.
          fieldSet: "partial",
          identifies: ["hash_key", "range_key"],
          accessPathBlocks: ["global_secondary_index", "local_secondary_index"],
          serves: {
            kindAttribute: "projection_type",
            fieldsAttribute: "non_key_attributes",
            everything: "ALL",
          },
          fieldTypes: {
            block: "attribute",
            nameAttribute: "name",
            typeAttribute: "type",
          },
        },
      },
      {
        resource: "aws_s3_bucket",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "s3",
          transport: "aws-sdk",
          nameAttribute: "bucket",
          // An object has no fields to compare a read against, and what
          // picks one out is the shape of its key, which the bucket
          // does not state.
          fieldSet: "none",
        },
      },
      {
        resource: "aws_elasticache_cluster",
        providerVersions: CURRENT,
        // A cluster with no engine of its own joins a replication
        // group, which always runs one of the two Redis-protocol
        // engines, so an unset engine is read.
        appliesWhen: {
          attribute: "engine",
          equals: ["redis", "valkey"],
          whenUnset: "read",
        },
        boundary: {
          kind: "storage",
          storageSystem: "redis",
          // Code addresses key namespaces, which no attribute of a
          // cluster lists, so the cluster declares the store and
          // claims no access. The README says how the sides meet.
          declares: "store",
          fieldSet: "none",
        },
      },
      {
        resource: "aws_elasticache_replication_group",
        providerVersions: CURRENT,
        boundary: {
          kind: "storage",
          storageSystem: "redis",
          declares: "store",
          fieldSet: "none",
        },
      },
      {
        resource: "aws_sqs_queue",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "aws_sqs",
          nameAttribute: "name",
        },
      },
      {
        resource: "aws_sns_topic",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "aws.sns",
          nameAttribute: "name",
        },
      },
      {
        resource: "aws_cloudwatch_event_bus",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "eventbridge",
          nameAttribute: "name",
        },
      },
    ],
  };
}

export default awsTerraform;
