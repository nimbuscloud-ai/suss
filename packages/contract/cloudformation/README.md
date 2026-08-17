# @suss/contract-cloudformation

Generate suss `BehavioralSummary[]` from an AWS [CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/) or [SAM](https://aws.amazon.com/serverless/sam/) template that embeds an OpenAPI definition under an API Gateway resource. Lets you check TypeScript consumers against an AWS-deployed API without round-tripping through an OpenAPI export.

## What this package is

`@suss/contract-cloudformation` walks the template's `Resources` map and runs two extraction paths side by side:

1. **Inline OpenAPI body**: API Gateway resources whose `Properties.Body` (REST / HTTP API) or `Properties.DefinitionBody` (SAM) contains an OpenAPI document. Each body is handed to [`@suss/contract-openapi`](../openapi/) for the actual conversion.
2. **CFN-native resources**: stacks that wire routes one resource at a time via `AWS::ApiGateway::Method` (REST) or `AWS::ApiGatewayV2::Route` (HTTP API). The reader walks the `AWS::ApiGateway::Resource` chain to work out each method's path, and declared `MethodResponses` become per-status transitions.

Both paths run unconditionally, so a mixed template (inline OpenAPI for some routes plus CFN-native for others) surfaces every kind of route.

The reader recognizes CloudFormation YAML intrinsic shorthand (`!Ref`, `!GetAtt`, plus pass-through tolerance for `!Sub`/`!Join`/`!If`/etc.), so realistic hand-written templates parse correctly.

When the reader loads a template from a file, it loads the templates that template embeds too. A resource of type `AWS::CloudFormation::Stack` (or SAM's `AWS::Serverless::Application`) points at another template, and AWS deploys its resources alongside the parent's, so the reader summarises them alongside the parent's as well. It walks each document on its own, because a logical id, a `Globals` section and a relative path all mean something only inside the document that writes them.

Two documents can each declare a resource called `HandlerFunction` and mean two different Lambdas. So when a summary identifies a deployed instance, it includes the path of stack resources that reaches it, as `OrdersStack/HandlerFunction`, and the aws-lambda pack builds that name the same way from the same template, so the two sides still meet. A channel keeps the name its own document writes, since the code that sends to a queue refers to the queue and cannot know which document declared it. Each summary's `location.file` says which document it came from.

When the reader cannot open a child, it writes the child's name to stderr along with what stopped it: a `TemplateURL` pointing at S3 or HTTPS, a path that is not on disk, a location containing an `Fn::Sub` substitution, a file that does not parse, a chain that returns to a document already open above it, or nesting more than ten stacks deep. Reading stopped there, and in none of those cases does the reader treat the child as one that declares nothing.

The reader applies a SAM `Globals` section to every resource that inherits from it before any of the walks run, so a template that declares an environment variable, a `CodeUri` or a timeout once for all of its functions comes out the same as one that repeats it on each. The resource's own value wins where both declare one, maps merge key by key, and lists put the section's entries first, which is what [SAM itself does](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-specification-template-anatomy-globals.html). When a function takes a variable from the section, that variable is marked `globals` in `metadata.runtimeContract.envVarSources`, because a default written once for a whole document is a claim about the document rather than about any one function.

Recognised resource types:

| Resource type | Property read | Path source |
|---------------|---------------|-------------|
| `AWS::ApiGateway::RestApi` | `Body` | OpenAPI |
| `AWS::ApiGatewayV2::Api`   | `Body` | OpenAPI |
| `AWS::Serverless::Api`     | `DefinitionBody` | OpenAPI |
| `AWS::Serverless::HttpApi` | `DefinitionBody` | OpenAPI |
| `AWS::ApiGateway::Method`  | n/a | walked via `ResourceId` chain |
| `AWS::ApiGatewayV2::Route` | n/a | parsed from `RouteKey` |

A template's `AWS::DynamoDB::Table` resources become storage boundaries as well. The table gets one summary and each of its secondary indexes gets another, because a query through an index keys on that index's own fields. The contract records the key attributes and states that they are only part of what an item has, so code that reads an ordinary attribute does not produce a finding.

## Minimal usage

```ts
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import fs from "node:fs";

const summaries = cloudFormationFileToSummaries("template.yaml");
fs.writeFileSync("provider.json", JSON.stringify(summaries, null, 2));
```

Or programmatically:

```ts
import { cloudFormationToSummaries } from "@suss/contract-cloudformation";

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

- **Out-of-line OpenAPI bodies aren't fetched.** `Properties.BodyS3Location` (referencing an S3 object) is skipped; point `@suss/contract-openapi` at the underlying spec directly or pre-resolve to inline.
- **`HttpMethod: ANY` methods are skipped.** Synthesising 7 distinct verbs would over-report; explicit verbs only.
- **`AWS::ApiGatewayV2::Route` produces no per-status transitions.** RouteKey gives `(method, path)` only; declared response codes for HTTP API live on the integration, which v0 doesn't traverse.
- **Parameters and outputs are not followed across a nested stack.** A parent passes `Parameters` down to a child and a child publishes `Outputs` back up. When a child refers to one of its own parameters, the reader does not follow that back to whatever the parent bound, and it does not follow a `Fn::GetAtt` on a stack resource's `Outputs.X` through to the child's output. In both cases the reference points at nothing, which is how the reader already treats any reference to something the document does not declare.
- **No CDK synthesis.** This package consumes the synthesised CloudFormation output, not raw CDK source. Run `cdk synth` first.
- **AWS-specific `x-amazon-apigateway-*` extensions** in the OpenAPI body are ignored; auth, throttling, and integration settings don't become extra transitions today.

## Where it fits in suss

Depends on `@suss/behavioral-ir` (for the IR types it produces), `@suss/contract-openapi` (for the actual schema to type conversion), and `yaml` (for template parsing). The CloudFormation surface is a thin walker.

## Coverage

![coverage](../../../.github/badges/coverage-contract-cloudformation.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md). For the underlying OpenAPI conversion, see [`@suss/contract-openapi`](../openapi/README.md).
