# @suss/contract-appsync

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from an [AWS AppSync](https://docs.aws.amazon.com/appsync/) API declared in a CloudFormation or [SAM](https://aws.amazon.com/serverless/sam/) template. AppSync is schema-first: you write the SDL by hand, and the template binds each `(TypeName, FieldName)` pair to a data source. This reader turns that wiring into resolver summaries you can check consumers against, without deploying the stack or exporting anything from AWS.

## What this package reads

`@suss/contract-appsync` walks the template's `Resources` map, and covers both ways of writing an AppSync API:

- **Raw resources**: `AWS::AppSync::GraphQLApi`, `AWS::AppSync::GraphQLSchema`, `AWS::AppSync::Resolver`, `AWS::AppSync::FunctionConfiguration` and `AWS::AppSync::DataSource`.
- **The SAM shorthand** `AWS::Serverless::GraphQLApi`. Its inline `SchemaInline` / `SchemaUri`, `DataSources`, `Functions` and `Resolvers` blocks are converted into the same model before any summary is built. Generated logical ids are prefixed with the API's logical id, so two GraphQL APIs in one template stay apart.

The SDL comes from the inline `Definition` / `SchemaInline` property, or from a local file when `DefinitionS3Location` / `SchemaUri` is a path, resolved against the template's directory. A static reader cannot fetch an `s3://` or `http(s)://` URI, or a location the template computes with an intrinsic. Both cases are recorded under `metadata.appsync.schemaSource` with a `status` of `"unresolved"` and a reason, so a schema the reader could not open is always reported.

## What it produces

One `resolver`-kind summary per resolver, plus one `library`-kind summary per API whose SDL resolved.

Each resolver summary has:

- `identity.name`: `Type.field`, and a `graphql-resolver` boundary binding with `transport: "aws-https"`, `recognition: "appsync"`, and the type and field names. It pairs with resolvers that the Apollo and NestJS packs extract from code, and with clients that use the same field.
- Inputs from the SDL field's arguments, each with `role: "args"` and the argument's type converted to a suss `TypeShape`.
- Two transitions: a default success that returns the field's declared shape, and a generic throw for the GraphQL `errors[]` path.
- `metadata.appsync`: the API's logical id and name, the data source's logical id, the Lambda function behind that data source, the resolver kind (`UNIT` or `PIPELINE`), and the authentication type. For SAM resolvers written as JS or VTL it also has the `CodeUri` and runtime. It records whether the schema declared the field (`schemaMatched`), and for pipeline resolvers, the ordered chain of functions, with each step's own data source and Lambda.

A resolver whose field the SDL never declares still gets a summary. AppSync rejects that stack at deploy time, so reporting the boundary helps more than dropping it. Its success transition returns `unknown`, and `schemaMatched` is `false`.

The `library` summary contains the SDL itself. Type definitions belong to the schema as a whole, so each resolver points at that document through a source-document label. The checker follows the label to resolve a consumer's nested selections against the resolver's return type. The `library` summary does not bind to a boundary, so pairing records it as taking no part.

Data source types are normalized from `AWS_LAMBDA`, `AMAZON_DYNAMODB`, `AMAZON_ELASTICSEARCH`, `AMAZON_OPENSEARCH_SERVICE`, `HTTP`, `RELATIONAL_DATABASE`, `AMAZON_EVENTBRIDGE` and `NONE`. Anything else comes back as `"unknown"`.

## What it does not read

- **Resolver code.** A SAM resolver's `CodeUri` and runtime are recorded, but the file behind them is never opened. VTL request and response mapping templates on raw `AWS::AppSync::Resolver` resources are ignored.
- **Dynamic intrinsics.** A resolver whose `TypeName` or `FieldName` comes from a `!Ref` or an `Fn::Join` is skipped, so the reader never guesses. A pipeline whose `Functions` array cannot be resolved statically still reports `kind: "PIPELINE"`, with an empty chain.
- **Remote schemas.** Nothing is fetched over the network.
- **Authorization.** The API's `AuthenticationType` is recorded on each resolver, and does not add transitions.
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

That produces a `Query.order` resolver summary with one `id` input of type `ID` and a success transition that returns a `ref` to `Order`. The SDL goes in the API's schema document summary.

If you already have the template in memory, such as a CDK `Template.fromStack` or JSON from a build tool, call it from code:

```ts
import { appsyncToSummaries } from "@suss/contract-appsync";

const summaries = appsyncToSummaries(template, { baseDir: "infra" });
```

## Where it fits in suss

The package depends on `@suss/behavioral-ir` for the IR types it produces, `@suss/contract-graphql` for SDL parsing, type conversion and loading an external schema file, `@suss/manifest-aws` for loading templates (including CloudFormation's YAML shorthand for intrinsics), and `graphql`. It does not extract from source code and does not use the language adapters.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-appsync.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md). For the schema-only counterpart that reads a plain SDL file, see [`@suss/contract-graphql`](../graphql/README.md).
