# @suss/contract-appsync

Generate suss `BehavioralSummary[]` from an [AWS AppSync](https://docs.aws.amazon.com/appsync/) API declared in a CloudFormation or [SAM](https://aws.amazon.com/serverless/sam/) template. AppSync is schema-first: the SDL is authored by hand and the template binds each `(TypeName, FieldName)` pair to a data source. This reader turns that wiring into resolver summaries you can check consumers against, without deploying the stack or exporting anything from AWS.

## What this package reads

`@suss/contract-appsync` walks the template's `Resources` map and covers both ways an AppSync API gets written:

- **Raw resources**: `AWS::AppSync::GraphQLApi`, `AWS::AppSync::GraphQLSchema`, `AWS::AppSync::Resolver`, `AWS::AppSync::FunctionConfiguration`, and `AWS::AppSync::DataSource`.
- **The SAM shorthand** `AWS::Serverless::GraphQLApi`, whose inline `SchemaInline` / `SchemaUri`, `DataSources`, `Functions`, and `Resolvers` blocks are normalized into the same model before any summary is built. Synthesized logical ids are prefixed with the API's logical id, so two GraphQL APIs in one template stay apart.

The SDL comes from the inline `Definition` / `SchemaInline` property, or from a local file when `DefinitionS3Location` / `SchemaUri` is a path (resolved against the template's directory). An `s3://` or `http(s)://` URI cannot be fetched by a static reader, and neither can a location the template computes through an intrinsic. Both cases are recorded under `metadata.appsync.schemaSource` with a `status` of `"unresolved"` and a reason, so a schema the reader could not open is never silent.

## What it produces

One `resolver`-kind summary per resolver, plus one `library`-kind summary per API whose SDL resolved.

Each resolver summary has:

- `identity.name`: `Type.field`, and a `graphql-resolver` boundary binding with `transport: "aws-https"`, `recognition: "appsync"`, plus the type and field names. That pairs against resolvers the Apollo and NestJS packs extract from code, and against clients that cross the same field.
- Inputs from the SDL field's arguments, each with `role: "args"` and the argument's type converted to a suss `TypeShape`.
- Two transitions: a default success returning the field's declared shape, and a generic throw for the GraphQL `errors[]` path.
- `metadata.appsync`: the API's logical id and name, the data source's logical id, the Lambda function behind that data source, the resolver kind (`UNIT` or `PIPELINE`), the authentication type, the `CodeUri` and runtime for SAM resolvers written as JS or VTL, whether the schema declared the field (`schemaMatched`), and, for pipeline resolvers, the ordered function chain with each step's own data source and Lambda.

A resolver whose field the SDL never declares still gets a summary. AppSync rejects that stack at deploy time, and reporting the boundary is more useful than dropping it. Its success transition returns `unknown` and `schemaMatched` is `false`.

The `library` summary is where the SDL itself goes. Type definitions belong to the schema rather than to any one field, so each resolver points at that document through a source-document label, and the checker follows the label to resolve a consumer's nested selections against the resolver's return type. It binds to no boundary, so pairing records it as taking no part.

Data source types are normalized from `AWS_LAMBDA`, `AMAZON_DYNAMODB`, `AMAZON_ELASTICSEARCH`, `AMAZON_OPENSEARCH_SERVICE`, `HTTP`, `RELATIONAL_DATABASE`, `AMAZON_EVENTBRIDGE`, and `NONE`. Anything else comes back as `"unknown"`.

## What it does not read

- **Resolver code.** A SAM resolver's `CodeUri` and runtime are recorded, and the file behind them is never opened. VTL request and response mapping templates on raw `AWS::AppSync::Resolver` resources are ignored.
- **Dynamic intrinsics.** A resolver whose `TypeName` or `FieldName` comes from a `!Ref` or an `Fn::Join` is skipped rather than guessed at. A pipeline whose `Functions` array cannot be resolved statically still reports `kind: "PIPELINE"` with an empty chain.
- **Remote schemas.** Nothing is fetched over the network.
- **Authorization.** The API's `AuthenticationType` is recorded on each resolver and does not become extra transitions.
- **Nested stacks.** Only the template you point at is walked.

## Worked example

```yaml
Resources:
  Api:
    Type: AWS::AppSync::GraphQLApi
    Properties:
      Name: orders
      AuthenticationType: API_KEY
  Schema:
    Type: AWS::AppSync::GraphQLSchema
    Properties:
      ApiId: !GetAtt Api.ApiId
      Definition: |
        type Order { id: ID!, total: Float! }
        type Query { order(id: ID!): Order }
  OrderResolver:
    Type: AWS::AppSync::Resolver
    Properties:
      ApiId: !GetAtt Api.ApiId
      TypeName: Query
      FieldName: order
      DataSourceName: !Ref OrdersLambda
```

```sh
suss contract --from appsync template.yaml -o summaries/appsync.json
```

That gives a `Query.order` resolver summary with one `id` input of type `ID`, a success transition returning a `ref` to `Order`, and the SDL under the API's schema document summary.

Or programmatically, when you already have the template in memory (a CDK `Template.fromStack`, JSON from a build tool):

```ts
import { appsyncToSummaries } from "@suss/contract-appsync";

const summaries = appsyncToSummaries(template, { baseDir: "infra" });
```

## Where it fits in suss

Depends on `@suss/behavioral-ir` (for the IR types it produces), `@suss/contract-graphql` (for SDL parsing, the type conversion, and loading an external schema file), `@suss/manifest-aws` (for template loading, including CloudFormation YAML intrinsic shorthand), and `graphql`. It does not extract from source code and is independent of the language adapters.

## Coverage

![coverage](../../../.github/badges/coverage-contract-appsync.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md). For the schema-only counterpart that reads a plain SDL file, see [`@suss/contract-graphql`](../graphql/README.md).
