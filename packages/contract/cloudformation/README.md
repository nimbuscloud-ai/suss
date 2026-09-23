# @suss/contract-cloudformation

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from an AWS [CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/) or [SAM](https://aws.amazon.com/serverless/sam/) template that embeds an OpenAPI definition under an API Gateway resource. With it you can check TypeScript consumers against an API deployed on AWS, without exporting an OpenAPI document first.

## What this package is

`@suss/contract-cloudformation` walks the template's `Resources` map and runs two extraction paths side by side:

1. **Inline OpenAPI body**: API Gateway resources whose `Properties.Body` (REST / HTTP API) or `Properties.DefinitionBody` (SAM) contains an OpenAPI document. Each body goes to [`@suss/contract-openapi`](../openapi/) for the conversion.
2. **CFN-native resources**: stacks that wire routes one resource at a time with `AWS::ApiGateway::Method` (REST) or `AWS::ApiGatewayV2::Route` (HTTP API). The reader walks the `AWS::ApiGateway::Resource` chain to work out each method's path, and declared `MethodResponses` become transitions per status.

Both paths always run, so a mixed template, with inline OpenAPI for some routes and CFN-native resources for others, shows every route.

The reader understands CloudFormation's YAML shorthand for intrinsics (`!Ref`, `!GetAtt`), and tolerates `!Sub`, `!Join`, `!If` and the rest by passing them through, so hand-written templates parse correctly.

When the reader loads a template from a file, it also loads the templates that template embeds. A resource of type `AWS::CloudFormation::Stack` (or SAM's `AWS::Serverless::Application`) points at another template, and AWS deploys its resources alongside the parent's, so the reader summarises them alongside the parent's too. It walks each document separately, because a logical id, a `Globals` section and a relative path only mean something inside the document that contains them.

Two documents can each declare a resource called `HandlerFunction` and mean two different Lambdas. So when a summary identifies a deployed instance, it includes the path of stack resources that leads to it, as in `OrdersStack/HandlerFunction`. The aws-lambda pack builds that name the same way from the same template, so the two sides still pair. A channel keeps the name its own document gives it, since code that sends to a queue refers to the queue and cannot know which document declared it. Each summary's `location.file` records which document it came from.

When the reader cannot open a child template, it prints the child's name to stderr with the reason. The reason is one of: a `TemplateURL` that points at S3 or HTTPS, a path that is not on disk, a location that contains an `Fn::Sub` substitution, a file that does not parse, a chain that loops back to a document already open above it, or nesting more than ten stacks deep. Reading stops there, and the reader never treats such a child as one that declares nothing.

Before any of the walks run, the reader applies a SAM `Globals` section to every resource that inherits from it. So a template that declares an environment variable, a `CodeUri` or a timeout once for all its functions comes out the same as one that repeats it on each. The resource's own value wins where both declare one, maps merge key by key, and lists put the section's entries first, which is [what SAM itself does](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-specification-template-anatomy-globals.html). When a function takes a variable from the section, that variable is marked `globals` in `metadata.runtimeContract.envVarSources`, because a default written once for a whole document describes the document, and no one function in particular.

Recognised resource types:

| Resource type | Property read | Path source |
|---------------|---------------|-------------|
| `AWS::ApiGateway::RestApi` | `Body` | OpenAPI |
| `AWS::ApiGatewayV2::Api`   | `Body` | OpenAPI |
| `AWS::Serverless::Api`     | `DefinitionBody` | OpenAPI |
| `AWS::Serverless::HttpApi` | `DefinitionBody` | OpenAPI |
| `AWS::ApiGateway::Method`  | n/a | walked via `ResourceId` chain |
| `AWS::ApiGatewayV2::Route` | n/a | parsed from `RouteKey` |

A template's `AWS::DynamoDB::Table` resources become storage boundaries as well. The table gets one summary and each of its secondary indexes gets another, because a query through an index keys on that index's own fields. The contract records the key attributes and marks them as only part of what an item has, so code that reads an ordinary attribute does not produce a finding.

### Message buses

Each channel gets a provider summary, and each Lambda that receives from it gets a consumer summary on the same channel. Producers found in code pair with the provider.

- **SQS**: one channel per `AWS::SQS::Queue`, named by its logical id. A Lambda receives from a queue through a SAM `Events` entry of type SQS or an `AWS::Lambda::EventSourceMapping`.
- **EventBridge**: one channel for each bus and detail type a rule routes, written `<bus>#<detailType>` the way `@suss/framework-aws-eventbridge` writes it. The bus is the event bus's logical id, or `default`. A producer that sends a detail type no rule routes is reported as `messageBusProducerOrphan`. A rule whose pattern does not reduce to literal detail types still gives its Lambda a consumer, marked `patternResolution: "unresolvable"` so it is reported and never paired on a guess. A scheduled rule sends no message, and its consumer is marked `"schedule"` so it is not reported as orphaned. The event bus gets no summary of its own, because every channel already includes it.
- **SNS**: one channel per `AWS::SNS::Topic`. A subscription with protocol `lambda` gives a consumer. Protocols other than `lambda` and `sqs` do not reach code and are skipped. A subscription with a FilterPolicy is marked unresolvable.
- **S3**: one channel per bucket that declares a notification or that a SAM S3 event refers to. A LambdaConfiguration gives a consumer. A TopicConfiguration gets its own consumer on the bucket's channel, with the topic in its metadata. A Filter is marked unresolvable, the same as an SNS FilterPolicy.

When exactly one subject reaches a queue from upstream, the queue's Lambda consumers use that subject's channel in place of the queue's, so the upstream producer pairs with the Lambda that handles its message. The subject can come from an EventBridge rule with one detail type, or from an SNS subscription with protocol `sqs` or an S3 QueueConfiguration that has no filter. The queue's logical id moves to `metadata.messageBus.queue`. A queue that several subjects reach keeps its own channel.

### Load balancer routing

A request's path through an Application Load Balancer is recorded as one-hop edges, which the reachability walk follows. The checker does not pair them.

- `routesTo`: a listener rule, or a listener's default forward action, and the target group it forwards to. The rule's conditions and priority are on the same record.
- `answers`: a rule or default action that responds without forwarding, such as a fixed response.
- `fronts`: what a target group sends traffic to, which is a Lambda function, an ECS container, or another load balancer.
- `belongsTo`: the load balancer a listener belongs to. A `fronts` edge that ends at a load balancer continues through this edge into that balancer's listeners.

A Route 53 alias record that points at a resource in the template becomes a `routesTo` edge, with the record's name as a host-header condition.

## Minimal usage

```ts
import { cloudFormationFileToSummaries } from "@suss/contract-cloudformation";
import fs from "node:fs";

const summaries = cloudFormationFileToSummaries("template.yaml");
fs.writeFileSync("provider.json", JSON.stringify(summaries, null, 2));
```

Or from code:

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

- **OpenAPI bodies stored elsewhere are not fetched.** `Properties.BodyS3Location`, which refers to an S3 object, is skipped. Point `@suss/contract-openapi` at the spec directly, or inline it first.
- **`HttpMethod: ANY` methods are skipped.** Producing 7 separate verbs would over-report, so only explicit verbs are read.
- **`AWS::ApiGatewayV2::Route` does not produce transitions per status.** The RouteKey only gives `(method, path)`. For an HTTP API the declared response codes are on the integration, which v0 does not walk.
- **Parameters and outputs are not followed across a nested stack.** A parent passes `Parameters` down to a child, and a child publishes `Outputs` back up. When a child refers to one of its own parameters, the reader does not follow it back to what the parent passed in. It also does not follow a `Fn::GetAtt` on a stack resource's `Outputs.X` through to the child's output. In both cases the reference points at nothing, which is how the reader already treats any reference to something the document does not declare.
- **No CDK synthesis.** This package reads the synthesised CloudFormation output, and cannot read CDK source. Run `cdk synth` first.
- **AWS-specific `x-amazon-apigateway-*` extensions** in the OpenAPI body are ignored. Auth, throttling and integration settings do not add transitions today.

## Where it fits in suss

The package depends on `@suss/behavioral-ir` for the IR types it produces, `@suss/contract-openapi` for converting schemas to types, and `yaml` for parsing templates. The CloudFormation part is a thin walker.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-cloudformation.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md). For the underlying OpenAPI conversion, see [`@suss/contract-openapi`](../openapi/README.md).
