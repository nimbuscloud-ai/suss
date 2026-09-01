# @suss/framework-aws-secrets-manager

Pattern pack for AWS Secrets Manager. It reads the calls a service makes against a secret and emits storage-access interactions, so `suss ask "what reads aws.secretsmanager:prod/db/password"` has an answer.

## What this package is

`@suss/framework-aws-secrets-manager` returns a `PatternPack` built from one `@suss/recognize` declaration and no hand-written walk. The anchor is the command, the same way the S3 pack reads an object call: the method is `send` at every AWS SDK v3 call site and the command class says which operation it is.

| Command | What it records |
|---|---|
| `GetSecretValueCommand` | a read of the secret `SecretId` gives |
| `BatchGetSecretValueCommand` | one read per secret in `SecretIdList` |
| `CreateSecretCommand` | a write of the secret `Name` gives |
| `PutSecretValueCommand`, `UpdateSecretCommand`, `DeleteSecretCommand` | a write of the secret `SecretId` gives |

A secret is one blob rather than a set of fields, so a call records which secret it reached and claims nothing about what is inside. A `SecretId` the code takes from `process.env.DB_SECRET_ID` keeps the env var name, so the access records container `{DB_SECRET_ID}` and a later resolver can ground it.

Only the AWS SDK v3 call shape is covered, and the command class has to come from `@aws-sdk/client-secrets-manager`, so a class of the same name from somewhere else is left alone.

## Why a secret is a store rather than runtime config

Reading a secret is reading configuration, and suss already has a `runtime-config` boundary for that, so this is the question worth answering before reading the code.

`runtime-config` is the wrong home for two reasons. Its identity is `(deploymentTarget, instanceName)`, which is a deployable unit, and its fields are the env var names that unit declares. A secret belongs to neither: it is a resource outside the unit, and two services reading one secret is a relationship the unit-shaped boundary cannot express. Worse, `checkRuntimeConfig` reports a config read the unit's environment does not declare as `boundaryFieldUnknown` at error severity, so putting secret ids on that boundary would fail a run for every secret a service reads.

`storage` says what is happening without stretching. A secret is a named container that many units read and write, addressed by name, with a read and a write side, which is the same shape a bucket or a table has. Nothing declares secrets as storage providers today, and an unpaired storage access is silent, so recording one adds a fact without adding a finding. When a template reader starts emitting `AWS::SecretsManager::Secret` as a provider, these accesses pair with it and nothing here has to change.

## Where it fits in suss

Depends on `@suss/recognize`, which compiles the declaration into the recognizer hook the adapters call. Nothing else, and no `ts-morph`.

`aws.secretsmanager` is suss's own name for the store. OpenTelemetry's `db.system.name` has no value for it, the way it has none for `s3`.

## Coverage

![coverage](../../../.github/badges/coverage-aws-secrets-manager.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
