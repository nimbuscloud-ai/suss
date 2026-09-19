/**
 * What AWS's Terraform provider declares, as far as suss reads it.
 *
 * Every entry says which provider versions it describes. The provider
 * moves things between releases, so a configuration pinned to one major
 * is read by the entries written for it and by no others. Version 4
 * split a bucket's settings into resources of their own, which is why
 * the bucket entry starts there.
 */

import type { MetricValueShape } from "@suss/behavioral-ir";
import type {
  TerraformPack,
  TerraformResourcePattern,
} from "@suss/contract-terraform";

/** The versions each entry below was written against. */
const CURRENT = ">=4 <7";

/** The system a metric filter and an alarm are both part of. */
const METRIC_SYSTEM = "cloudwatch";

/**
 * What each statistic leaves behind. A percentile is written under
 * `extended_statistic` as `pNN.NN`, which no fixed table can list, so
 * an alarm using one states no reduction here.
 */
const STATISTICS: Record<string, MetricValueShape> = {
  SampleCount: "number",
  Average: "number",
  Sum: "number",
  Minimum: "number",
  Maximum: "number",
};

/** The store each value of an `engine` attribute picks. */
const SQL_ENGINES = [
  { storageSystem: "postgresql", engines: ["postgres", "aurora-postgresql"] },
  { storageSystem: "mysql", engines: ["mysql", "aurora-mysql", "mariadb"] },
];

/**
 * One entry per SQL engine a resource can run, since the engine decides
 * which store it is. Code addresses tables inside the database, which
 * no attribute of the resource lists, so each entry declares the store
 * and claims no access, the same as an ElastiCache cluster.
 */
function sqlStores(resource: string): TerraformResourcePattern[] {
  return SQL_ENGINES.map(({ storageSystem, engines }) => ({
    resource,
    providerVersions: CURRENT,
    appliesWhen: { attribute: "engine", equals: engines },
    boundary: {
      kind: "storage" as const,
      storageSystem,
      declares: "store" as const,
      fieldSet: "none" as const,
    },
  }));
}

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
      ...sqlStores("aws_rds_cluster"),
      ...sqlStores("aws_db_instance"),
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
      {
        resource: "aws_kinesis_stream",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "aws_kinesis",
          nameAttribute: "name",
        },
      },
      {
        resource: "aws_kinesis_firehose_delivery_stream",
        providerVersions: CURRENT,
        boundary: {
          kind: "message-bus",
          messageBus: "aws_firehose",
          nameAttribute: "name",
        },
      },
      {
        resource: "aws_cloudwatch_log_metric_filter",
        providerVersions: CURRENT,
        boundary: {
          kind: "metric",
          metricSystem: METRIC_SYSTEM,
          // CloudWatch identifies a metric by its namespace and its
          // name together, and an alarm spells both, so both are the
          // identity the two sides share.
          metricTypeTemplate:
            "{metric_transformation.namespace}/{metric_transformation.name}",
        },
      },
      {
        resource: "aws_cloudwatch_metric_alarm",
        providerVersions: CURRENT,
        boundary: {
          kind: "metric-reading",
          metricSystem: METRIC_SYSTEM,
          // An alarm on a single metric is one reading, written in the
          // resource itself rather than in a block.
          readingBlocks: [],
          identifies: {
            from: "attributes",
            template: "{namespace}/{metric_name}",
          },
          comparesTo: { attribute: "threshold", whenSet: "number" },
          reducesTo: { attribute: "statistic", means: STATISTICS },
        },
      },
      {
        resource: "aws_lambda_function",
        providerVersions: CURRENT,
        boundary: {
          kind: "deployable",
          deploymentTarget: "lambda",
          runtimeAttribute: "runtime",
          env: [{ style: "map", attribute: "environment.variables" }],
          // Lambda writes the module and the exported name into one
          // string, split at the last dot.
          code: {
            handler: { attribute: "handler", spelling: "module.export" },
          },
        },
      },
      {
        resource: "aws_ecs_task_definition",
        providerVersions: CURRENT,
        boundary: {
          kind: "deployable",
          deploymentTarget: "ecs-task",
          // One task definition runs several containers, each starting
          // with an environment of its own, and the JSON they are
          // written in is read the same way a block would be.
          containers: {
            blocks: ["container_definitions"],
            nameAttribute: "name",
          },
          env: [
            {
              style: "entries",
              block: "environment",
              nameAttribute: "name",
              valueAttribute: "value",
            },
            {
              style: "entries",
              block: "secrets",
              nameAttribute: "name",
              secretAttribute: "valueFrom",
            },
          ],
          code: { imageAttribute: "image" },
        },
      },
    ],
  };
}

export default awsTerraform;
