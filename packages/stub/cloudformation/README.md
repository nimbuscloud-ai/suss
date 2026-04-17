# @suss/stub-cloudformation

Generate suss `BehavioralSummary[]` from an AWS [CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/) or [SAM](https://aws.amazon.com/serverless/sam/) template that embeds an OpenAPI definition under an API Gateway resource. Lets you check TypeScript consumers against an AWS-deployed API without round-tripping through an OpenAPI export.

## What this package is

`@suss/stub-cloudformation` walks the template's `Resources` map, finds API Gateway-shaped entries, pulls the inline OpenAPI body out, and hands it to `@suss/stub-openapi` for the actual conversion. Result: one `BehavioralSummary` per OpenAPI operation across every API Gateway resource in the template.

Recognised resource types:

| Resource type | Property read |
|---------------|---------------|
| `AWS::ApiGateway::RestApi` | `Body` |
| `AWS::ApiGatewayV2::Api`   | `Body` |
| `AWS::Serverless::Api`     | `DefinitionBody` |
| `AWS::Serverless::HttpApi` | `DefinitionBody` |

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

- **Inline OpenAPI bodies only.** Out-of-line definitions via `BodyS3Location` (referencing an S3 object) aren't fetched — point `@suss/stub-openapi` at the underlying spec directly if it's local, or pre-resolve.
- **No CFN-native `AWS::ApiGateway::Method` walk.** If a stack defines routes one resource at a time without an inline OpenAPI, this package won't find them.
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
