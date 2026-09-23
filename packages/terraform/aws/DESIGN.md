# Why each AWS entry reads what it reads

Each entry reads some attributes and refuses others, for the reasons below. The [README](./README.md) explains what the pack is and lists what it covers.

## Why a database instance pairs with nothing

`aws_rds_cluster` and `aws_db_instance` declare that a PostgreSQL or a MySQL store exists, and nothing more. Code addresses tables inside the database, and no attribute of either resource lists a table. So the reasoning for ElastiCache applies here too: the summary declares the store with no container name, and the storage check claims no access for it. You get visibility of a store the run saw, and tables still pair between an ORM schema and the code that queries it.

The `engine` attribute decides which kind of store the resource is, so the entry reads the engine from that attribute and does not use it to filter resources out. An engine suss has no word for, such as `oracle-ee` or `sqlserver-ex`, and an engine supplied by a variable both leave the store with no engine on it. Either way the instance is deployed and has a name, and dropping it would lose a store the run can see, only because suss has no word for its engine.

## Why a Redis cluster pairs with nothing

Code addresses Redis by key namespace. `@suss/framework-redis` reads `session:{id}` and records the container `session`. A cluster declares no namespaces. Its `cluster_id` is a deployment name that code never uses. The two sides have no name in common that either can state, so the entry declares only that the store exists, with no container name, and the storage check claims no access for it. If a cluster called `session` paired with the `session` namespace, that would be a coincidence between a deployment name and a key prefix, so the entry refuses to report it.

The entry gives you visibility. `suss contract --from terraform` shows the cluster, and `suss check` reports it as a declared store that nothing paired with. Pairing at the namespace level happens between the code's own readers and writers of the same keys.

## What Kinesis pairs with

Nothing yet. A stream and a delivery stream each become a channel, and no code pack records a send to either, so they show up as declared channels that nothing paired with. They stay as separate buses because they are different APIs. A producer puts records on a stream and consumers read from it. A delivery stream has no reader at all, and writes into a destination instead. If both used one bus name, a stream and a delivery stream with the same name would pair with each other.

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

Both become `OrderService/Refusals`, so `suss check` reports an alarm on a metric that nothing publishes, and a metric that nothing watches.

The shape check that `checkMetric` runs never fires here. A metric filter only publishes a number and an alarm only compares against one, so the two sides cannot disagree about shape. The pair is recorded so the report of a missing side can name it. An alarm that sets `extended_statistic` instead of `statistic` does not record a reduction, because a percentile is written as `pNN.NN` and no fixed table can list those values.

## Deployable entries

A function's variables are in one map, `environment.variables`, and the entry points there. A task definition's variables are per container, inside `container_definitions`, which the provider takes as JSON. The reader reads what is inside a `jsonencode` call, so a task written the way the provider docs show is read.

Both entries take the variables AWS injects by itself from the list that every suss reader of an AWS deployment uses, so `AWS_REGION` is never reported as a variable that nothing supplies. The lists come from [Lambda's reserved environment variables](https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html) and [the ECS task metadata endpoint](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_metadata.html).

A container's `secrets` entry gives the parameter or secret that supplies a variable, and that resource is recorded. The configuration does not contain the secret's contents, so nothing is recorded for the value.

## What the AWS entries leave out

- **`aws_s3_bucket_versioning` and `aws_s3_bucket_lifecycle_configuration`**, and the rest of the resources split out in v4, describe how a bucket is administered. A caller does not address them, so nothing reads them. The bucket itself is the boundary.
- **`aws_rds_cluster_instance`** is a compute node of the cluster that `aws_rds_cluster` already declares, so reading it would count one store twice.
- **`aws_mq_broker`** runs ActiveMQ or RabbitMQ. suss has no bus name for either, and no pack that records a send to one. A bus that nothing produces on would not pair with anything or report anything.
- **An alarm written with `metric_query` blocks** puts its metric inside a block while its threshold stays on the resource. The entry reads one reading at a time, so only the direct form is read.
- **`filename` and `s3_key` on a function.** Both point at a deployed artifact and not at source, so neither shows where the code is. The handler is what places the unit.
