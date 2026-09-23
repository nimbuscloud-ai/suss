# @suss/framework-aws-ssm

Pattern pack for AWS SSM Parameter Store. It reads the calls a service makes against a parameter and records each one as a storage access, so `suss ask "what reads aws.ssm:/prod/db/host"` has an answer.

```ts
import { GetParameterCommand } from "@aws-sdk/client-ssm";

await client.send(new GetParameterCommand({ Name: process.env.DB_HOST_PARAM }));
```

## What this package is

`@suss/framework-aws-ssm` exports a `PatternPack` built from one `@suss/recognize` declaration, with no walk written by hand. The pack matches on the command, the same way the S3 pack reads an object call. The method is `send` at every AWS SDK v3 call site, and the command class tells you which operation it is.

| Command | What it records |
|---|---|
| `GetParameterCommand` | a read of the parameter `Name` gives |
| `GetParametersCommand` | one read per parameter in `Names` |
| `PutParameterCommand`, `DeleteParameterCommand` | a write of the parameter `Name` gives |
| `DeleteParametersCommand` | one write per parameter in `Names` |

A parameter is one value with no fields, so a call records which parameter it reached and nothing about what is inside. When the code takes the `Name` from `process.env.DB_HOST_PARAM`, suss keeps the env var name. The access records the container `{DB_HOST_PARAM}`, and a later resolver can ground it. If the run cannot read a `Names` list as names, it records one access with no container, so a service that reads parameters still shows up as reading them.

`GetParametersByPathCommand` is not covered. Its `Path` is a prefix over many parameters, so recording it as a container would put a read against a string that is not the name of anything. Reaching a set of containers by prefix needs a pattern container, which is a separate change.

The pack covers only the AWS SDK v3 call pattern. The command class has to come from `@aws-sdk/client-ssm`, so a class with the same name from another module is ignored.

## Why suss treats a parameter as a store

Reading a parameter is reading configuration, and suss already has a `runtime-config` boundary for that. So the choice needs explaining before the code.

`runtime-config` does not fit, for two reasons. First, its identity is `(deploymentTarget, instanceName)`, which is a deployable unit, and its fields are the env var names that unit declares. A parameter is neither. It is a resource outside the unit, and a boundary built around one unit cannot express two services reading the same parameter. Second, `checkRuntimeConfig` reports a config read that the unit's environment does not declare as `boundaryFieldUnknown`, at error severity. Putting parameter names on that boundary would fail the run once for every parameter a service reads.

`storage` describes what happens without stretching. A parameter is a named container that many units read and write, addressed by name, the same way a bucket or a table is. Nothing declares parameters as storage providers today, and suss stays silent about a storage access with no pair, so recording one adds a fact and no finding. When a template reader starts recording `AWS::SSM::Parameter` as a provider, these accesses will pair with it and nothing here has to change.

## Where it fits in suss

The pack depends only on `@suss/recognize`, which compiles the declaration into the recognizer hook the adapters call. It does not use `ts-morph`.

`aws.ssm` is suss's own name for the store. OpenTelemetry's `db.system.name` has no value for it, the same as for `s3`.

## Coverage

![coverage](../../../.github/badges/coverage-aws-ssm.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
