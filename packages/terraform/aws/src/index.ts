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
          storageSystem: "dynamodb",
          // A caller reaches a table through the SDK over HTTPS rather
          // than through a wire protocol of its own.
          transport: "aws-sdk",
          nameAttribute: "name",
          // A table declares its key attributes and lets every other
          // attribute vary.
          fieldSet: "partial",
          identifies: ["hash_key", "range_key"],
          accessPathBlocks: ["global_secondary_index", "local_secondary_index"],
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
        resource: "aws_sqs_queue",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "sqs",
          nameAttribute: "name",
        },
      },
      {
        resource: "aws_sns_topic",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "sns",
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
