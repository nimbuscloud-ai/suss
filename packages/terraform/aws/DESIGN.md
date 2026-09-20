# What each AWS entry decided

Why each entry reads what it reads, and refuses what it refuses. The [README](./README.md) says what the pack is and lists what it covers.

## Why a database instance pairs with nothing

`aws_rds_cluster` and `aws_db_instance` declare that a PostgreSQL or a MySQL store exists, and no more. Code addresses tables inside the database, and no attribute of either resource lists one, so the same reasoning as for ElastiCache applies: the summary declares the store with no container name, and the storage check claims no access for it. What you get is visibility, a store the run saw, and the tables keep pairing between an ORM schema and the code that queries it.

The `engine` attribute decides which store the resource is, so the entry reads the engine off that attribute rather than gating on it. An engine suss has no word for, `oracle-ee` or `sqlserver-ex`, and an engine a variable supplies both leave the store with no engine on it. The instance is deployed and it has a name either way, so dropping it would lose a store the run can see for the sake of a word it cannot.

## Why a Redis cluster pairs with nothing

Code addresses Redis by key namespace: `@suss/framework-redis` reads `session:{id}` and records the container `session`. A cluster declares no namespaces; its `cluster_id` is a deployment name, and code never spells it. The two sides share no name either can state, so the entry says so: the summary declares the store exists, with no container name, and the storage check claims no access for it. A pair between a cluster called `session` and the `session` namespace would be a coincidence between a deployment name and a key prefix, so the entry refuses it rather than reporting it.

What you get from the entry is visibility: `suss contract --from terraform` shows the cluster, and `suss check` reports it as a declared store nothing paired with. Namespace-level pairing stays between the code's own readers and writers of the same keys.

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

## What a deployable entry says

A function's variables are one map, `environment.variables`, and the entry says so. A task definition's are per container, inside `container_definitions`, which the provider takes as JSON; the reader reads what is inside a `jsonencode` call, so a task written the way the docs show it is read.

Both entries take the variables AWS injects on its own from the list every suss reader of an AWS deployment uses, so `AWS_REGION` is never reported as a variable nothing supplies. The lists come from [Lambda's reserved environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html) and [the ECS task metadata endpoint](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_metadata.html).

A container's `secrets` entry says which parameter or secret supplies a variable, and that resource is recorded. What the secret contains is not in the configuration, so nothing is recorded for the value.

## What the AWS entries leave out

- **`aws_s3_bucket_versioning` and `aws_s3_bucket_lifecycle_configuration`**, and the rest of the v4 split resources, say how a bucket is administered rather than what a caller can address, so nothing reads them. The bucket itself is the boundary.
- **`aws_rds_cluster_instance`** is a compute node of the cluster `aws_rds_cluster` already declares, so reading it would count one store twice.
- **`aws_mq_broker`** runs ActiveMQ or RabbitMQ, and suss has no bus word for either, nor any pack that records a send to one. A bus value nothing produces would pair with nothing and say nothing.
- **An alarm written as `metric_query` blocks** states its metric inside a block while its threshold stays on the resource, and the entry reads one reading at a time, so only the direct form is read.
- **`filename` and `s3_key` on a function.** Both point at a deployed artifact rather than at source, so neither says where the code is, and the handler is what places the unit.
