# @suss/contract-graphql

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from the GraphQL files a repository already commits. It has two readers, one for each side of a GraphQL boundary:

| Reader | Input | Summaries |
|--------|-------|-----------|
| `suss contract --from graphql` | a plain SDL schema file | one `resolver`-kind summary per root field (the provider side) |
| `suss contract --from graphql-documents` | `.graphql` / `.gql` operation documents | one `client`-kind summary per operation (the consumer side) |

Each side pairs with the other, and with summaries the Apollo and NestJS packs extract from code. Nothing has to be traced through TypeScript first.

## Reading a schema

`graphqlSdlFileToSummaries` parses the SDL and walks every field on `Query`, `Mutation` and `Subscription`, including fields added with `extend type Query { ... }`. Each field becomes one summary:

- `identity.name` is `Type.field`, with a `graphql-resolver` boundary binding that records `transport: "http-graphql"`, `recognition: "graphql"`, and the type and field names. You can override both defaults, which helps when the same SDL backs several deployments and the findings should tell them apart.
- Inputs come from the field's arguments, each with `role: "args"`.
- Two transitions: a default success that returns the field's declared shape, and a `GraphQLError` throw for the `errors[]` path.
- `metadata.graphql.declaredContract` records the return type, the arguments with a `required` flag on each, and the framework tag. Its provenance is `"derived"`, because the contract and the transitions come from the same field declaration, and comparing one with the other would find nothing.

One extra `library`-kind summary contains the SDL text itself, under `metadata.graphql.schemaSdl`. Type definitions belong to the schema as a whole, so every resolver points at that document through a source-document label. The checker follows the label to resolve a consumer's nested selections against a resolver's return type. That summary does not bind to a boundary, so pairing records it as taking no part.

Named types convert to `TypeShape` like this: `String` and `ID` become `text`, `Int` and `Float` become `number`, `Boolean` becomes `boolean`, and any other named type becomes a `ref` with that name. A list becomes an `array`. A non-null wrapper is dropped, because in a `TypeShape` a value is non-null when its union does not include null.

## Reading operation documents

`graphqlDocumentsPathToSummaries` accepts a single file, or a directory that it searches recursively for `.graphql` and `.gql` files, skipping `node_modules`. Each query, mutation and subscription definition becomes one summary:

- A `graphql-operation` boundary binding with the operation type and, when the operation is named, its name. The default recognition tag is `"graphql-documents"`, so findings can tell these apart from operations found at a call site.
- Inputs from the operation's variable definitions, each with `role: "variable"`. That is the same role the TypeScript adapter gives the `$variables` it finds in a tagged template literal.
- The full document text at `metadata.graphql.document`, the same place the TypeScript adapter puts documents it finds in code, so the checker's GraphQL pairing pass reads both the same way.
- A response shape estimated from the selection set. Field names become record properties and leaves become `unknown`, since a document does not declare field types. A field selected twice, once directly and once through a fragment, merges into one property, the way a server would merge it.

Fragment spreads are resolved against every fragment definition in the files read, and inlined into the stored document, so the pairing pass sees the selected fields directly. A spread the reader cannot expand stays in the document as written, and becomes a gap on the summary instead of an error. The fragment may be missing from the files read, part of a cycle, or defined in more than one file. When it is defined more than once, the first definition in read order wins, and the gap lists which files had one.

An anonymous operation is named after its path relative to the directory you passed, plus its operation type, so the name is the same on every machine that checks out the repo. A repeated name gets a `#2` suffix, because transition ids are built from the name, and a repeated id would make two operations look like one.

## What neither reader does

- **Non-root resolvers.** The schema reader only produces summaries for `Query`, `Mutation` and `Subscription` fields. A field resolver on `Order.customer` does not get a boundary summary today.
- **Directives, unions and interface resolution, and custom scalars** beyond the `ref` fallback are not modeled.
- **Schema validation.** An SDL file that fails to parse comes back as an empty array, with no error. The documents reader skips a file it cannot parse, so one bad file does not lose the rest.
- **Checking documents against a schema.** The documents reader never resolves a selected field's type. The checker does that pairing later, against the schema document summary.

## Worked example

```graphql
# schema.graphql
type User { id: ID!, email: String! }
type Query { user(id: ID!): User }
```

```graphql
# src/queries/user.graphql
query GetUser($id: ID!) {
  user(id: $id) { id email }
}
```

```sh
suss contract --from graphql schema.graphql -o summaries/schema.json
suss contract --from graphql-documents src/queries -o summaries/operations.json
suss check summaries/schema.json summaries/operations.json
```

Or from code:

```ts
import {
  graphqlSdlFileToSummaries,
  graphqlDocumentsPathToSummaries,
} from "@suss/contract-graphql";

const provider = graphqlSdlFileToSummaries("schema.graphql");
const consumer = graphqlDocumentsPathToSummaries("src/queries");
```

## Where it fits in suss

The package depends only on `@suss/behavioral-ir`, for the IR types it produces, and `graphql`, for parsing and printing. It does not extract from source code and does not use the language adapters. `@suss/contract-appsync` reuses this package's SDL loader and type conversion for AppSync schemas declared in CloudFormation.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-graphql.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md). For how contract sources fit together, see [`docs/packs/contract-sources.md`](../../../docs/packs/contract-sources.md).
