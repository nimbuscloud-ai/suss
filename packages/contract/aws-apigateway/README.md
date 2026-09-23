# @suss/contract-aws-apigateway

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` for AWS API Gateway resources (REST and HTTP API), however they were deployed.

## What this package is

`@suss/contract-aws-apigateway` is a **resource-semantics stub**. Given a normalized configuration, it works out what an API Gateway endpoint *does*: its status codes, authorizer behavior, CORS preflight and throttling. It does **not** read the configuration as someone wrote it. A manifest reader does that: `@suss/contract-cloudformation` today, and CDK and Terraform readers later. The reader parses its own source format and passes a normalized config to this package.

Because of that split, you can configure your API in CloudFormation, CDK, SAM or Terraform, and the same resource semantics produce the same summary.

## Where it fits

```
packages/contract/
  openapi/              # Spec → summaries (declares what the API claims to be)
  aws-apigateway/       # Resource semantics: what AWS API Gateway actually does
  cloudformation/       # Manifest reader: walks CFN/SAM, builds configs, delegates here
  (future) cdk-synth/   # Same delegation pattern
  (future) terraform/   # Same delegation pattern
```

## Why configuration matters

A handler that only returns `200` can respond in *many* more ways once it is deployed behind API Gateway. An authorizer adds `401`/`403`, request validation adds `400`, throttling adds `429`, integration timeouts add `504`, and CORS adds an `OPTIONS` preflight endpoint. If suss did not model these, a consumer that handles `429` would look like it had a dead branch, when the platform does produce `429` even though the handler never does.

These transitions come out with `confidence.source: "derived"` and an opaque `Predicate` of the form `platform:apiGateway:<contract>`. Each transition's `metadata` records which configuration field introduced it, for `inspect`/`diff` output, so consumers do not have to work out the platform cause themselves.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-aws-apigateway.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
