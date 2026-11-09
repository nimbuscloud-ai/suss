# @suss/framework-prisma

Pattern pack for [Prisma](https://www.prisma.io/) client calls in TypeScript. It records `interaction(class: "storage-access")` effects on the transitions that contain them.

```ts
const db = new PrismaClient();

await db.user.findMany({ where: { tier }, select: { id: true, email: true } });
```

## What this package is

`@suss/framework-prisma` exports a `PatternPack` with an empty `discovery` list and no terminals. Prisma calls become effects on handlers and services that another pack discovered. Run it alongside a handler pack such as Express or Lambda, or the effects have nothing to attach to.

The recognizer matches a three-part chain, `<receiver>.<modelDelegate>.<method>(args)`, and checks the receiver by its type. The type's symbol, or the symbol of a class it extends, has to be declared in `@prisma/client`, in `.prisma/client`, or in a directory that contains a `schema.prisma`. That covers `const db = new PrismaClient()`, a wrapped `ctx.prisma`, a project's `class PrismaService extends PrismaClient`, and a generator whose `output` points at a directory in the project.

Before `prisma generate` has run, the client's type is `any`, so the pack checks where the receiver was made instead. A `new PrismaClient()` imported from `@prisma/client` or from a generator's `output` counts, whether it is made in the file that uses it or in a module that file imports it from, directly or through a barrel. A project class that extends that `PrismaClient` counts too.

Inside `prisma.$transaction(async (tx) => ...)`, Prisma hands the callback a client for the transaction as its first argument, so `tx.user.update(...)` counts wherever the `$transaction` call's own receiver does. The callback can be an arrow or a function expression written at the call, or a function passed by name when the store finds the name passed there. The array form, `prisma.$transaction([...])`, needs nothing of its own, since each call in the array is made on the client itself.

A generator with its own `output` also gets past the import check, since the code then reaches the client by a relative path, or through the tsconfig's `baseUrl` or `paths`, and nothing imports `@prisma/client`. The pack declares `generatedModules` with `of: "@prisma/client"` and `markers: ["schema.prisma"]`, and the adapter treats a relative import into a directory that contains that file as an import of `@prisma/client`. Its `dirs` are the `output` directories of the project's schema, and an import into one of those counts by either kind of specifier, before anyone has run `prisma generate`. A NestJS app with `"baseUrl": "./"` that imports `src/generated/prisma/client` is read this way.

The model comes from the delegate property. Prisma lowercases the first letter of a model when it builds the client (`prisma.user` for `model User`), so the recognizer reads the property and capitalizes the first letter again to get the PascalCase schema model. That matches the channel `@suss/contract-prisma` publishes.

Each method counts as a read or a write:

- read: `findUnique`, `findUniqueOrThrow`, `findFirst`, `findFirstOrThrow`, `findMany`, `count`, `aggregate`, `groupBy`
- write: `create`, `update`, `delete`, `upsert`, `createMany`, `updateMany`, `deleteMany`

The fields come from the call's first argument. A read takes the `select` keys, plus the `include` keys when a `select` lists which fields to return. A query with no `select` reads the whole record and comes back as `["*"]`. A write takes the union of the `data`, `create` and `update` keys, since an upsert can pass two of them. The keys of `where` become the selector.

A relation filter in a `where`, such as `profile: { verified: true }` or `posts: { some: { published: true } }`, reads the related rows by the columns it filters. It is recorded as a read with the relation's path and those columns as its fields, and the relation's name stays out of the selector. Only the schema tells a relation from a column, so a value that is an object of anything other than Prisma's column operators (`equals`, `in`, `gte`, `contains` and the rest) counts as a relation's `where`. An `include` or nested `select` that passes its own `where` picks the related rows by that `where`'s columns, and a relation filter inside it is read the same way, one level further down. `AND`, `OR` and `NOT` take one `where` or a list of them on the same rows, so the columns and relation filters inside them are read as the `where`'s own.

A unique `where` can pick a row by a compound unique key, whose name Prisma makes by joining the fields it combines with `_`: `where: { domain_key: { domain, key } }` for a model with `@@unique([domain, key])`. The pack reads that key as the columns `domain` and `key`. It learns which keys a model has from the same project schema the storage system comes from, so a key the schema gives its own `name` reads too, and so does a key whose value the pack can't see into. For a nested operation, the pack looks the key up on the model the relation leads to. When the pack doesn't find a schema, or the schema doesn't declare that model, it reads a key as a compound key only when the key's name is the keys of the object under it joined by `_`. Any other key stays a column or a relation filter.

The pack reads that argument through the value ops on its context, which follow the value policy in `@suss/recognize`'s DESIGN.md. Options kept in a local or an import, a spread, the object a project function returns, and a list mapped through a callback written at the call or passed by name all read as the objects they come to, at any depth. A parameter reads as nothing, so a payload passed in whole writes `["*"]`.

For each column it picks rows by, the pack tells the adapter which value the call wrote under `where`, and for each column a write sets, the value under `data`, `create` or `update`. The summary records where each value came from. The pack declares those paths the way a compiled storage chain does with `.slots()`, and reads them with the same `slotsDeclared`. A read states only its selector's values, since `select` lists its columns as `true`.

### Relations

A call shows which relation it goes through, but never which model is at the other end. So each relation comes out as its own effect, with the `relationPath` it was written under, and the checker resolves that path against the model's contract to find the table.

Reads work this way for `select` and `include`. So do writes: a `create` with an `include` returns a relation the way a query does, and a nested operation under `data` writes across the relation. The nested operations the pack reads are `create`, `createMany`, `connectOrCreate`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `connect`, `disconnect` and `set`. An operation that changes which row is joined sets a foreign key, so it arrives with `relationKey` and the checker fills in the columns from the contract. A nested `create`, `createMany` or `upsert` does the same for the row it creates, since Prisma sets that row's key to the parent's. An operation that picks the related rows by a `where` records the columns it picks by as the effect's `selector`, so `connectOrCreate: { where: { name }, create }` reads `name`. That `where` is read the way a call's own is: `AND`, `OR` and `NOT` give the columns inside them, a compound key gives the columns it combines, and a relation filter becomes a read through that relation. That covers `connectOrCreate`, `updateMany`, `upsert`, an `update` written as `{ where, data }`, and a `delete` or `deleteMany`, whose payload is the `where`. A `connect`, `disconnect` or `set` writes nothing across the relation, so the rows it joins get a read of their own, with no fields and the payload's keys as its selector. For a many-to-many with no join model, the contract points that relation at the join table Prisma manages, and the checker counts the write there instead of on either model.

### Raw statements

`$queryRaw`, `$executeRaw`, `$queryRawUnsafe` and `$executeRawUnsafe` bypass the typed client, so only the text of the statement shows which tables it touches. Those calls go through the SQL reader in `@suss/recognize` instead, and a join comes out as one effect per table.

## Options

Both options make the effects this pack records pair with the schema reader. Pass them to `prismaFramework()`, or as JSON with `-f prisma=packs/prisma.json`.

```json
{
  "storageSystem": "mysql",
  "scope": "default"
}
```

- `storageSystem`: the storage system the matched calls target, one of `"postgresql"`, `"mysql"` or `"sqlite"`. It has to match the `storageSystem` on the schema reader's provider summaries, or the pairing keys will not match. When it is unset, the pack reads the `provider` of the datasource in the calling file's project schema, so an example app on SQLite and a main app on Postgres in one repo stay apart. The schema is the one `prisma.config.ts` gives, then the `prisma.schema` key in package.json, then the `--schema` a `prisma generate` script in package.json passes, then `prisma/schema.prisma` and `schema.prisma`. A schema split over a folder of `.prisma` files is read whole. A project with no schema to read gets `"postgresql"`, since most Prisma projects run on Postgres.
- `scope`: the scope label, which has to match the schema reader's scope. The default is `"default"`, to line up with `prismaSchemaToSummaries`.

## Not covered yet

The pack doesn't state a value for a column inside a compound key or under `AND`, `OR` or `NOT`. The declared paths stop at `where`, and the value is one level further down.

## Where it fits in suss

The pack depends on `@suss/extractor` for the `PatternPack` type, `@suss/behavioral-ir` for `storageBinding`, and `@suss/recognize` to compile the raw-statement declaration and to read the slots it declares. `ts-morph` is a peer dependency, because the client recognizer still walks the AST to check the receiver.

The provider side is `@suss/contract-prisma`, which reads `schema.prisma` and publishes a summary per model.

## Coverage

![coverage](../../../.github/badges/coverage-prisma.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
