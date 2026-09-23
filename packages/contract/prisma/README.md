# @suss/contract-prisma

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and reports where the two disagree.

This package builds suss `BehavioralSummary[]` from a [Prisma](https://www.prisma.io/) schema. A `schema.prisma` file declares every table an application has and every column on it, and the code reads and writes against that. This reader turns the schema into storage boundaries, so a query that touches a column nobody declared becomes a finding.

## What this package reads

`@suss/contract-prisma` parses `schema.prisma` with [`@mrleebo/prisma-ast`](https://github.com/MrLeebo/prisma-ast), a parser that does not pull in the Prisma runtime. Reading a schema never needs a generated client or a database connection.

The `datasource` block decides whether anything comes out. A `provider` of `postgresql`, `postgres`, `mysql` or `sqlite` sets the storage system on every boundary. Any other provider, such as MongoDB, returns an empty array, since document storage is a different kind of boundary.

## What it produces

One `library`-kind summary per `model` and per `view`, with a storage boundary binding: `recognition: "prisma"`, the storage system from the datasource, a scope, and the model name as the container. The checker's storage pass pairs these with the `interaction(class: "storage-access")` effects the adapters find in code. In a monorepo with several Prisma schemas, pass a different `scope` for each schema so their pairings stay separate. The default is `"default"`.

The behavior is in `metadata.storageContract`:

- `fieldSet: "exhaustive"`. A Prisma model declares every column its table has, so a column the code touches that is missing from this list is unknown, and not merely unlisted.
- `fields`, one entry per column, with the Prisma type, whether the field is optional (`nullable`), and `primary` / `unique` from the `@id` and `@unique` field attributes. Scalar fields (`Int`, `BigInt`, `Float`, `Decimal`, `String`, `Boolean`, `DateTime`, `Json`, `Bytes`) and enum fields are columns.
- Relation fields appear too, marked `derived`, because the Prisma client accepts them in an `include` or a `select` even though no column of that name exists. Leaving them out of a contract marked exhaustive would report working code as reading an undeclared field. When the model stores the foreign key, the columns listed in `@relation(fields: [...])` are included as `relationKey`. Prisma only allows that argument on one side of a relation, so the other side, and every implicit many-to-many, has no key.
- A many-to-many relation with no explicit join model gets a `joinContainer` entry instead, which gives the table Prisma manages for it. See below.
- A model with any relation also gets a derived `_count` entry, since the client exposes relation counts under that name.
- `indexes`, from `@@index([...])` (not unique), `@@unique([...])` and `@@id([...])` (both unique).
- `physicalTable`, when `@@map("...")` gives the table a SQL name different from the model name. That lets it pair with code that uses SQL names directly, such as Drizzle's `pgTable("users")` or a raw query.

These summaries have no inputs and no transitions. A table is a set of columns the code has to agree with, and it does not return anything the way a function does. Confidence is `declared` at `high`, since the schema states all of this explicitly.

### Implicit many-to-many join tables

When two list fields point at each other and neither side declares `@relation(fields: [...])`, that is Prisma's implicit many-to-many. Prisma creates and manages the join table itself, and the schema never declares a model for it. This reader produces a summary for that table too, with the boundary Prisma would create. The container is `_Name` when the fields have `@relation("Name")`, and otherwise `_FirstToSecond`, with the two model names in alphabetical order. The table has two columns, `A` and `B`, keyed to whichever model sorts first and second. Each side of the relation gets `joinContainer` set to that table's container name, so a `connect`, `disconnect` or `set` through the field counts as a write there and is not lost.

An explicit join model, the kind written out by hand to add extra columns, already has a boundary through the ordinary model path above, and none of this applies to it.

## What it does not read

- **Non-relational providers.** A MongoDB schema comes back empty. Document storage is separate work.
- **Composite types and unsupported field types.** A field whose type is not a scalar, an enum or another model is skipped, so the reader never guesses. That covers `Unsupported(...)`, a Mongo composite type, and a typo.
- **Array scalar fields.** `String[]` is dropped along with relation lists, because the walk treats every array field as a relation array.
- **Native type attributes.** `@db.VarChar(255)` and similar are not recorded. The field's Prisma type is what comes through.
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

Or from code:

```ts
import { prismaSchemaFileToSummaries } from "@suss/contract-prisma";

const summaries = prismaSchemaFileToSummaries("prisma/schema.prisma", {
  scope: "billing",
});
```

## Where it fits in suss

The package depends only on `@suss/behavioral-ir`, for the IR types it produces, and `@mrleebo/prisma-ast`, for parsing. It does not extract from source code and does not use the language adapters. The Prisma pattern pack finds the query call sites that this contract pairs with.

## More

- [Documentation](https://suss.sh/)
- [Every package and pack suss ships](https://suss.sh/packs/catalog)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)

## Coverage

![coverage](../../../.github/badges/coverage-contract-prisma.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For the format the summaries conform to, see [`docs/reference/summary-format.md`](../../../docs/reference/summary-format.md). For how contract sources fit together, see [`docs/packs/contract-sources.md`](../../../docs/packs/contract-sources.md).
