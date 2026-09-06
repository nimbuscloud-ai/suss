# @suss/framework-prisma

Pattern pack for [Prisma](https://www.prisma.io/) client calls in TypeScript. It emits `interaction(class: "storage-access")` effects on the transitions that contain them.

## What this package is

`@suss/framework-prisma` returns a `PatternPack` with an empty `discovery` list and no terminals. Prisma calls become effects on handlers and services that some other pack discovered, so run this pack alongside a handler pack (Express, Fastify, NestJS, Lambda) or the effects have nothing to land on.

The recognizer matches a three-segment chain, `<receiver>.<modelDelegate>.<method>(args)`, and verifies the receiver by type. Its symbol declaration has to live in `@prisma/client` or `.prisma/client`, which covers both `const db = new PrismaClient()` and a wrapped `ctx.prisma`.

The model comes from the delegate property. Prisma lowercases the first letter of a model when it builds the client (`prisma.user` for `model User`), so the recognizer reads the property and capitalizes the first letter back to the PascalCase schema model. That matches the channel `@suss/contract-prisma` publishes.

Methods classify as reads or writes:

- read: `findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`
- write: `create`, `update`, `delete`, `upsert`, `createMany`, `updateMany`, `deleteMany`

Fields come from the call's first argument. A read takes the `select` keys, plus the `include` keys when a `select` says which fields to return; a query with no `select` reads the whole record and comes back as `["*"]`. A write unions the `data`, `create`, and `update` keys, since an upsert can pass two of them. The keys of `where` become the selector.

### Relations

A call says which relation it reaches through and never says which model is on the other end of it, so each relation comes out as its own effect with the `relationPath` it was written under. The checker resolves that path against the model's contract to find the table.

Reads work this way for `select` and `include`. Writes do too: a `create` with an `include` hands a relation back the way a query does, and a nested operation under `data` writes across the relation. The nested operations read are `create`, `createMany`, `connectOrCreate`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `connect`, `disconnect`, and `set`. An operation that moves which row is joined sets a foreign key, so it arrives with `relationKey` and the checker fills the columns in from the contract. For a many-to-many with no join model, the contract points that relation at the join table Prisma manages, and the checker counts the write there instead of on either model.

### Raw statements

`$queryRaw`, `$executeRaw`, `$queryRawUnsafe`, and `$executeRawUnsafe` bypass the typed client, so the text of the statement is what says which tables are touched. Those go through the SQL reader in `@suss/recognize` instead, and a join comes out as one effect per table.

## Options

Both options exist so the effects this pack emits pair with the schema reader. Pass them to `prismaFramework()`, or as JSON to `-f prisma=packs/prisma.json`.

```json
{
  "storageSystem": "mysql",
  "scope": "default"
}
```

- `storageSystem`: the storage system the recognized calls target, one of `"postgresql"`, `"mysql"`, or `"sqlite"`. It has to match the `storageSystem` on schema-reader provider summaries or pairing keys will not match. Defaults to `"postgresql"`, the dominant Prisma deployment.
- `scope`: the scope label, which has to match the schema reader's scope. Defaults to `"default"`, to line up with `prismaSchemaToSummaries`.

## Not covered yet

`findUniqueOrThrow` and `findFirstOrThrow` are not in the read set.

## Where it fits in suss

Depends on `@suss/extractor` (for the `PatternPack` type), `@suss/behavioral-ir` (for `storageBinding`), and `@suss/recognize` (which compiles the raw-statement declaration). `ts-morph` is a peer dependency, since the client recognizer walks the AST directly.

The provider side is `@suss/contract-prisma`, which reads `schema.prisma` and publishes a summary per model.

## Coverage

![coverage](../../../.github/badges/coverage-prisma.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
