# @suss/framework-prisma

Pattern pack for [Prisma](https://www.prisma.io/) client calls in TypeScript. It records `interaction(class: "storage-access")` effects on the transitions that contain them.

```ts
const db = new PrismaClient();

await db.user.findMany({ where: { tier }, select: { id: true, email: true } });
```

## What this package is

`@suss/framework-prisma` exports a `PatternPack` with an empty `discovery` list and no terminals. Prisma calls become effects on handlers and services that another pack discovered. Run it alongside a handler pack such as Express or Lambda, or the effects have nothing to attach to.

The recognizer matches a three-part chain, `<receiver>.<modelDelegate>.<method>(args)`, and checks the receiver by its type. The type's symbol, or the symbol of a class it extends, has to be declared in `@prisma/client`, in `.prisma/client`, or in a directory that contains a `schema.prisma`. That covers `const db = new PrismaClient()`, a wrapped `ctx.prisma`, a project's `class PrismaService extends PrismaClient`, and a generator whose `output` points at a directory in the project.

A generator with its own `output` also gets past the import check, since the code then reaches the client by a relative path and nothing imports `@prisma/client`. The pack declares `generatedModuleMarkers: ["schema.prisma"]`, and the adapter treats a relative import into a directory that contains that file as an import of the package.

The model comes from the delegate property. Prisma lowercases the first letter of a model when it builds the client (`prisma.user` for `model User`), so the recognizer reads the property and capitalizes the first letter again to get the PascalCase schema model. That matches the channel `@suss/contract-prisma` publishes.

Each method counts as a read or a write:

- read: `findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`
- write: `create`, `update`, `delete`, `upsert`, `createMany`, `updateMany`, `deleteMany`

The fields come from the call's first argument. A read takes the `select` keys, plus the `include` keys when a `select` lists which fields to return. A query with no `select` reads the whole record and comes back as `["*"]`. A write takes the union of the `data`, `create` and `update` keys, since an upsert can pass two of them. The keys of `where` become the selector.

### Relations

A call shows which relation it goes through, but never which model is at the other end. So each relation comes out as its own effect, with the `relationPath` it was written under, and the checker resolves that path against the model's contract to find the table.

Reads work this way for `select` and `include`. So do writes: a `create` with an `include` returns a relation the way a query does, and a nested operation under `data` writes across the relation. The nested operations the pack reads are `create`, `createMany`, `connectOrCreate`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `connect`, `disconnect` and `set`. An operation that changes which row is joined sets a foreign key, so it arrives with `relationKey` and the checker fills in the columns from the contract. For a many-to-many with no join model, the contract points that relation at the join table Prisma manages, and the checker counts the write there instead of on either model.

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

- `storageSystem`: the storage system the matched calls target, one of `"postgresql"`, `"mysql"` or `"sqlite"`. It has to match the `storageSystem` on the schema reader's provider summaries, or the pairing keys will not match. The default is `"postgresql"`, since most Prisma projects run on Postgres.
- `scope`: the scope label, which has to match the schema reader's scope. The default is `"default"`, to line up with `prismaSchemaToSummaries`.

## Not covered yet

`findUniqueOrThrow` and `findFirstOrThrow` are not in the read set.

## Where it fits in suss

The pack depends on `@suss/extractor` for the `PatternPack` type, `@suss/behavioral-ir` for `storageBinding`, and `@suss/recognize` to compile the raw-statement declaration. `ts-morph` is a peer dependency, because the client recognizer walks the AST directly.

The provider side is `@suss/contract-prisma`, which reads `schema.prisma` and publishes a summary per model.

## Coverage

![coverage](../../../.github/badges/coverage-prisma.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
