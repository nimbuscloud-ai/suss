# @suss/framework-aws-secrets-manager

Pattern pack for AWS Secrets Manager. It reads the calls a service makes against a secret and records each one as a storage access, so `suss ask "what reads aws.secretsmanager:prod/db/password"` has an answer.

```ts
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

await client.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ID }));
```

## What this package is

`@suss/framework-aws-secrets-manager` exports a `PatternPack` built from one `@suss/recognize` declaration, with no walk written by hand. The pack matches on the command, the same way the S3 pack reads an object call. The method is `send` at every AWS SDK v3 call site, and the command class tells you which operation it is.

| Command | What it records |
|---|---|
| `GetSecretValueCommand` | a read of the secret `SecretId` gives |
| `BatchGetSecretValueCommand` | one read per secret in `SecretIdList` |
| `CreateSecretCommand` | a write of the secret `Name` gives |
| `PutSecretValueCommand`, `UpdateSecretCommand`, `DeleteSecretCommand` | a write of the secret `SecretId` gives |

A secret is one blob with no fields, so a call records which secret it reached and nothing about what is inside. When the code takes the `SecretId` from `process.env.DB_SECRET_ID`, suss keeps the env var name. The access records the container `{DB_SECRET_ID}`, and a later resolver can ground it.

The pack covers only the AWS SDK v3 call pattern. The command class has to come from `@aws-sdk/client-secrets-manager`, so a class with the same name from another module is ignored.

## Why suss treats a secret as a store

Reading a secret is reading configuration, and suss already has a `runtime-config` boundary for that. So the choice needs explaining before the code.

`runtime-config` does not fit, for two reasons. First, its identity is `(deploymentTarget, instanceName)`, which is a deployable unit, and its fields are the env var names that unit declares. A secret is neither. It is a resource outside the unit, and a boundary built around one unit cannot express two services reading the same secret. Second, `checkRuntimeConfig` reports a config read that the unit's environment does not declare as `boundaryFieldUnknown`, at error severity. Putting secret ids on that boundary would fail the run once for every secret a service reads.

`storage` describes what happens without stretching. A secret is a named container that many units read and write, addressed by name, the same way a bucket or a table is. Nothing declares secrets as storage providers today, and suss stays silent about a storage access with no pair, so recording one adds a fact and no finding. When a template reader starts recording `AWS::SecretsManager::Secret` as a provider, these accesses will pair with it and nothing here has to change.

## Where it fits in suss

The pack depends only on `@suss/recognize`, which compiles the declaration into the recognizer hook the adapters call. It does not use `ts-morph`.

`aws.secretsmanager` is suss's own name for the store. OpenTelemetry's `db.system.name` has no value for it, the same as for `s3`.

## Coverage

![coverage](../../../.github/badges/coverage-aws-secrets-manager.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
