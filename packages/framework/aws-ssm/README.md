# @suss/framework-aws-ssm

Pattern pack for AWS SSM Parameter Store. It reads the calls a service makes against a parameter and emits storage-access interactions, so `suss ask "what reads aws.ssm:/prod/db/host"` has an answer.

## What this package is

`@suss/framework-aws-ssm` returns a `PatternPack` built from one `@suss/recognize` declaration and no hand-written walk. The anchor is the command, the same way the S3 pack reads an object call: the method is `send` at every AWS SDK v3 call site and the command class says which operation it is.

| Command | What it records |
|---|---|
| `GetParameterCommand` | a read of the parameter `Name` gives |
| `GetParametersCommand` | one read per parameter in `Names` |
| `PutParameterCommand`, `DeleteParameterCommand` | a write of the parameter `Name` gives |
| `DeleteParametersCommand` | one write per parameter in `Names` |

A parameter is one value rather than a set of fields, so a call records which parameter it reached and claims nothing about what is inside. A `Name` the code takes from `process.env.DB_HOST_PARAM` keeps the env var name, so the access records container `{DB_HOST_PARAM}` and a later resolver can ground it. A `Names` list this run cannot read into names records one access with no container, because a service that reads parameters should not read as one that reads none.

`GetParametersByPathCommand` is not covered. Its `Path` is a prefix over many parameters rather than one parameter, so recording it as a container would put a read against a string that is nothing's name. Reaching a set of containers by prefix wants a pattern container, which is a separate change.

Only the AWS SDK v3 call shape is covered, and the command class has to come from `@aws-sdk/client-ssm`, so a class of the same name from somewhere else is left alone.

## Why a parameter is a store rather than runtime config

Reading a parameter is reading configuration, and suss already has a `runtime-config` boundary for that, so this is the question worth answering before reading the code.

`runtime-config` is the wrong home for two reasons. Its identity is `(deploymentTarget, instanceName)`, which is a deployable unit, and its fields are the env var names that unit declares. A parameter belongs to neither: it is a resource outside the unit, and two services reading one parameter is a relationship the unit-shaped boundary cannot express. Worse, `checkRuntimeConfig` reports a config read the unit's environment does not declare as `boundaryFieldUnknown` at error severity, so putting parameter names on that boundary would fail a run for every parameter a service reads.

`storage` says what is happening without stretching. A parameter is a named container that many units read and write, addressed by name, with a read and a write side, which is the same shape a bucket or a table has. Nothing declares parameters as storage providers today, and an unpaired storage access is silent, so recording one adds a fact without adding a finding. When a template reader starts emitting `AWS::SSM::Parameter` as a provider, these accesses pair with it and nothing here has to change.

## Where it fits in suss

Depends on `@suss/recognize`, which compiles the declaration into the recognizer hook the adapters call. Nothing else, and no `ts-morph`.

`aws.ssm` is suss's own name for the store. OpenTelemetry's `db.system.name` has no value for it, the way it has none for `s3`.

## Coverage

![coverage](../../../.github/badges/coverage-aws-ssm.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
