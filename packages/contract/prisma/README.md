# @suss/contract-prisma

Generate suss `BehavioralSummary[]` from a [Prisma](https://www.prisma.io/) schema. A `schema.prisma` file declares every table an application has and every column on it, which is the contract the code reads and writes against. This reader turns that declaration into storage boundaries, so a query touching a column nobody declared becomes a finding.

## What this package reads

`@suss/contract-prisma` parses `schema.prisma` with [`@mrleebo/prisma-ast`](https://github.com/MrLeebo/prisma-ast), a parser that does not pull in the Prisma runtime, so reading a schema never requires a generated client or a database connection.

The `datasource` block decides whether anything comes out. A `provider` of `postgresql`, `postgres`, `mysql`, or `sqlite` sets the storage system on every boundary. Any other provider (MongoDB, for instance) returns an empty array, since document semantics are a different boundary kind.

## What it produces

One `library`-kind summary per `model` and per `view`, with a storage boundary binding: `recognition: "prisma"`, the storage system from the datasource, a scope, and the model name as the container. The checker's storage pass pairs those against `interaction(class: "storage-access")` effects the adapters find in code. A monorepo with several Prisma schemas should pass a distinct `scope` per schema so pairings stay separate; it defaults to `"default"`.

The behavior is in `metadata.storageContract`:

- `fieldSet: "exhaustive"`. A Prisma model declares every column its table has, so a column the code touches and this list leaves out is unknown rather than merely unlisted.
- `fields`, one entry per column, with the Prisma type, whether the field is optional (`nullable`), and `primary` / `unique` from the `@id` and `@unique` field attributes. Scalar fields (`Int`, `BigInt`, `Float`, `Decimal`, `String`, `Boolean`, `DateTime`, `Json`, `Bytes`) and enum fields are columns.
- Relation fields also appear, marked `derived`, because the Prisma client accepts them in an `include` or a `select` even though no column of that name exists. Leaving them out of a contract that calls itself exhaustive would report working code as reading an undeclared field. When the model stores the foreign key, the columns listed in `@relation(fields: [...])` come along as `relationKey`. Prisma allows that argument on one side of a relation only, so the other side and every implicit many-to-many have no key.
- A many-to-many relation with no explicit join model gets a `joinContainer` entry instead, saying which table Prisma manages for it. See below.
- A model with any relation also gets a derived `_count` entry, which is what the client exposes for relation counts.
- `indexes`, from `@@index([...])` (not unique), `@@unique([...])`, and `@@id([...])` (both unique).
- `physicalTable`, when `@@map("...")` gives the table a SQL name different from the model name. That is the bridge to code speaking SQL names directly, such as Drizzle's `pgTable("users")` or a raw query.

These summaries have no inputs and no transitions. A table is a shape the code agrees with, not a function that returns something. Confidence is `declared` at `high`, since the schema says all of this outright.

### Implicit many-to-many join tables

Two list fields pointing at each other with neither side declaring `@relation(fields: [...])` are Prisma's implicit many-to-many: Prisma creates and manages the join table itself, and the schema never declares a model for it. This reader emits a summary for that table too, with the boundary Prisma would create: container `_Name` when the fields carry `@relation("Name")`, or `_FirstToSecond` with the two model names in alphabetical order otherwise, and two columns, `A` and `B`, keyed to whichever model sorts first and second. Each side of the relation gets `joinContainer` set to that table's own container name, so a `connect`, `disconnect` or `set` through the field counts as a write there instead of going unrecorded.

An explicit join model, the kind written out by hand to carry extra columns, already has a boundary through the ordinary model path above and gets none of this.

## What it does not read

- **Non-relational providers.** A MongoDB schema comes back empty; document storage semantics are separate work.
- **Composite types and unsupported field types.** A field whose type is neither a scalar, an enum, nor another model (`Unsupported(...)`, a Mongo composite type, or a typo) is skipped rather than guessed at.
- **Array scalar fields.** `String[]` is dropped along with relation lists, because the walk treats every array field as a relation array.
- **Native type attributes.** `@db.VarChar(255)` and friends are not recorded; the field's Prisma type is what comes through.
- **`generator` blocks, the datasource URL, and relation cardinality** as behavior of their own.

## Worked example

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id    Int     @id @default(autoincrement())
  email String  @unique
  name  String?
  posts Post[]

  @@map("users")
  @@index([email])
}
```

```sh
suss contract --from prisma prisma/schema.prisma -o summaries/db.json
suss check summaries/db.json summaries/app.json
```

The `User` summary declares `id` (primary), `email` (unique), a nullable `name`, the derived `posts` relation, a derived `_count`, an index on `email`, and `physicalTable: "users"`.

Or programmatically:

```ts
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";

const summaries = prismaSchemaFileToSummaries("prisma/schema.prisma", {
  scope: "billing",
});
```

## Where it fits in suss

Depends only on `@suss/behavioral-ir` (for the IR types it produces) and `@mrleebo/prisma-ast` (for parsing). It does not extract from source code and is independent of the language adapters. The Prisma pattern pack is what finds the query call sites this contract pairs against.

## Coverage

![coverage](../../../.github/badges/coverage-contract-prisma.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/behavioral-summary-format.md`](../../../docs/behavioral-summary-format.md). For how contract sources fit together, see [`docs/contract-sources.md`](../../../docs/contract-sources.md).
