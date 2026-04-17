# @suss/stub-cloudformation

Generate suss `BehavioralSummary[]` from an AWS [CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/) or [SAM](https://aws.amazon.com/serverless/sam/) template that embeds an OpenAPI definition under an API Gateway resource. Lets you check TypeScript consumers against an AWS-deployed API without round-tripping through an OpenAPI export.

## What this package is

`@suss/stub-cloudformation` walks the template's `Resources` map and runs two extraction paths side by side:

1. **Inline OpenAPI body** — API Gateway resources whose `Properties.Body` (REST / HTTP API) or `Properties.DefinitionBody` (SAM) carries an OpenAPI document. Each body is handed to [`@suss/stub-openapi`](../openapi/) for the actual conversion.
2. **CFN-native resources** — stacks that wire routes one resource at a time via `AWS::ApiGateway::Method` (REST) or `AWS::ApiGatewayV2::Route` (HTTP API). The `AWS::ApiGateway::Resource` chain is walked to derive each method's path; declared `MethodResponses` become per-status transitions.

Both paths run unconditionally so a mixed template (inline OpenAPI for some routes plus CFN-native for others) surfaces every kind of route.

CloudFormation YAML intrinsic shorthand (`!Ref`, `!GetAtt`, plus pass-through tolerance for `!Sub`/`!Join`/`!If`/etc.) is recognised so realistic hand-written templates parse correctly.

Recognised resource types:

| Resource type | Property read | Path source |
|---------------|---------------|-------------|
| `AWS::ApiGateway::RestApi` | `Body` | OpenAPI |
| `AWS::ApiGatewayV2::Api`   | `Body` | OpenAPI |
| `AWS::Serverless::Api`     | `DefinitionBody` | OpenAPI |
| `AWS::Serverless::HttpApi` | `DefinitionBody` | OpenAPI |
| `AWS::ApiGateway::Method`  | n/a | walked via `ResourceId` chain |
| `AWS::ApiGatewayV2::Route` | n/a | parsed from `RouteKey` |

## Minimal usage

```ts
import { cloudFormationFileToSummaries } from "@suss/stub-cloudformation";
import fs from "node:fs";

const summaries = cloudFormationFileToSummaries("template.yaml");
fs.writeFileSync("provider.json", JSON.stringify(summaries, null, 2));
```

Or programmatically:

```ts
import { cloudFormationToSummaries } from "@suss/stub-cloudformation";

const summaries = cloudFormationToSummaries({
  Resources: {
    UsersApi: {
      Type: "AWS::ApiGateway::RestApi",
      Properties: { Body: openApiSpec },
    },
  },
});
```

## Limitations (v0)

- **Out-of-line OpenAPI bodies aren't fetched.** `Properties.BodyS3Location` (referencing an S3 object) is skipped; point `@suss/stub-openapi` at the underlying spec directly or pre-resolve to inline.
- **`HttpMethod: ANY` methods are skipped.** Synthesising 7 distinct verbs would over-report; explicit verbs only.
- **`AWS::ApiGatewayV2::Route` carries no per-status transitions.** RouteKey gives `(method, path)` only — declared response codes for HTTP API live on the integration, which v0 doesn't traverse.
- **No CDK synthesis.** This package consumes the synthesised CloudFormation output, not raw CDK source. Run `cdk synth` first.
- **AWS-specific `x-amazon-apigateway-*` extensions** in the OpenAPI body are ignored — auth, throttling, integration shapes don't become extra transitions today.

## Where it sits in suss

Depends on `@suss/behavioral-ir` (for the IR types it produces), `@suss/stub-openapi` (for the actual schema → shape conversion), and `yaml` (for template parsing). The CloudFormation surface is just a thin walker.

## Coverage

![coverage](../../../.github/badges/coverage-stub-cloudformation.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md). For the underlying OpenAPI conversion, see [`@suss/stub-openapi`](../openapi/README.md).
