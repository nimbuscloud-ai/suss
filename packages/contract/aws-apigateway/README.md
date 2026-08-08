# @suss/contract-aws-apigateway

Generate suss `BehavioralSummary[]` for AWS API Gateway resources (REST + HTTP API), independent of how they were deployed.

## What this package is

`@suss/contract-aws-apigateway` is a **resource-semantics stub**: given a normalized configuration, it knows what an API Gateway endpoint *does* (status codes, authorizer behavior, CORS preflight, throttling). It does **not** know how someone wrote that configuration; a manifest reader does that job (`@suss/contract-cloudformation`, future CDK/Terraform readers), parsing its source format and handing a normalized config to this package.

This separation means: configure your API in CloudFormation, CDK, SAM, or Terraform, and the same resource semantics produce the same summary.

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

A handler that only returns `200` produces a *much* larger behavioral envelope once it's deployed behind API Gateway: an authorizer adds `401`/`403`, request validation adds `400`, throttling adds `429`, integration timeouts add `504`, CORS adds an `OPTIONS` preflight endpoint. Without modeling these, a consumer that handles `429` looks like it has a dead branch, when in reality the platform produces `429` even though the handler doesn't.

These transitions are emitted with `confidence.source: "derived"` and an opaque `Predicate` of the form `platform:apiGateway:<contract>`. Each transition's `metadata` records where the transition came from (which configuration field introduced it) for `inspect`/`diff` output, so consumers do not have to work out the platform cause themselves.

## Coverage

![coverage](../../../.github/badges/coverage-stub-aws-apigateway.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).
