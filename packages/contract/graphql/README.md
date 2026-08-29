# @suss/contract-graphql

Generate suss `BehavioralSummary[]` from GraphQL files a repository already commits. Two readers ship in this package, one for each side of a GraphQL boundary:

| Reader | Input | Summaries |
|--------|-------|-----------|
| `suss contract --from graphql` | a plain SDL schema file | one `resolver`-kind summary per root field (the provider side) |
| `suss contract --from graphql-documents` | `.graphql` / `.gql` operation documents | one `client`-kind summary per operation (the consumer side) |

Either side pairs against the other, and against summaries extracted from code by the Apollo and NestJS packs. Nothing has to be traced through TypeScript first.

## Reading a schema

`graphqlSdlFileToSummaries` parses the SDL and walks every field on `Query`, `Mutation`, and `Subscription`, including fields added through `extend type Query { ... }`. Each field becomes one summary:

- `identity.name` is `Type.field`, with a `graphql-resolver` boundary binding that records `transport: "http-graphql"`, `recognition: "graphql"`, and the type and field names. Both defaults are overridable, which is what you want when the same SDL backs several deployments and findings should tell them apart.
- Inputs come from the field's arguments, each with `role: "args"`.
- Two transitions: a default success returning the field's declared shape, and a `GraphQLError` throw for the `errors[]` path.
- `metadata.graphql.declaredContract` records the return type, the arguments with a `required` flag per argument, and the framework tag. Its provenance is `"derived"`, because the contract and the transitions come from the same field declaration and comparing one against the other would say nothing.

One extra `library`-kind summary contains the SDL text itself, under `metadata.graphql.schemaSdl`. Type definitions belong to the schema rather than to any one field, so every resolver points at that document through a source-document label, and the checker follows the label to resolve a consumer's nested selections against a resolver's return type. That summary binds to no boundary, so pairing records it as taking no part.

Named types convert to `TypeShape` as follows: `String` and `ID` become `text`, `Int` and `Float` become `number`, `Boolean` becomes `boolean`, and any other named type becomes a `ref` with that name. A list becomes an `array`, and a non-null wrapper is dropped because `TypeShape` treats nullability as the absence of null in a union.

## Reading operation documents

`graphqlDocumentsPathToSummaries` accepts a single file or a directory walked recursively for `.graphql` and `.gql` files (`node_modules` is skipped). Each query, mutation, and subscription definition becomes one summary:

- A `graphql-operation` boundary binding with the operation type and, when the operation is named, its name. The default recognition tag is `"graphql-documents"`, so findings distinguish these from operations traced at a call site.
- Inputs from the operation's variable definitions, each with `role: "variable"`, the same role the TypeScript adapter stamps on `$variables` it recovers from a tagged template literal.
- The full document text at `metadata.graphql.document`, the same place the TypeScript adapter puts documents it finds in code, so the checker's GraphQL pairing pass reads both alike.
- A response shape approximated from the selection set. Field names become record properties and leaves become `unknown`, since a document does not declare field types. A field selected twice, once directly and once through a fragment, merges into one property the way a server would merge it.

Fragment spreads are resolved against every fragment definition in the read set and inlined into the stored document, so the pairing pass sees the selected fields directly. A spread the reader cannot expand stays in the document as written and becomes a gap on the summary rather than an error: the fragment may be missing from the read set, part of a cycle, or defined in more than one file. In the ambiguous case the first definition in read order wins and the gap says which files competed.

An anonymous operation is named after its path relative to the directory you passed, plus its operation type, so the name is the same on every machine that checks the repo out. Repeated names get a `#2` suffix, because transition ids are built from the name and a repeated id would make two operations look like one.

## What neither reader does

- **Non-root resolvers.** A schema reader summary is emitted for `Query`, `Mutation`, and `Subscription` fields. A field resolver on `Order.customer` is not a boundary summary today.
- **Directives, unions and interface resolution, and custom scalars** beyond the `ref` fallback are not modeled.
- **Schema validation.** An SDL file that fails to parse comes back as an empty array rather than an error, and the documents reader skips a file it cannot parse so one bad file does not lose the rest.
- **Cross-checking documents against a schema.** The documents reader never resolves a selected field's type; that pairing happens later in the checker, against the schema document summary.

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

Or programmatically:

```ts
import {
  graphqlSdlFileToSummaries,
  graphqlDocumentsPathToSummaries,
} from "@suss/contract-graphql";

const provider = graphqlSdlFileToSummaries("schema.graphql");
const consumer = graphqlDocumentsPathToSummaries("src/queries");
```

## Where it fits in suss

Depends only on `@suss/behavioral-ir` (for the IR types it produces) and `graphql` (for parsing and printing). It does not extract from source code and is independent of the language adapters. `@suss/contract-appsync` reuses this package's SDL loader and type conversion for AppSync schemas declared in CloudFormation.

## Coverage

![coverage](../../../.github/badges/coverage-contract-graphql.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md). For how contract sources fit together, see [`docs/contract-sources.md`](../../../docs/contract-sources.md).
