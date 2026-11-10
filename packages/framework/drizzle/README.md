# @suss/framework-drizzle

Pattern pack for [Drizzle ORM](https://orm.drizzle.team/). It matches query-builder calls in TypeScript and records `interaction(class: "storage-access")` effects on the transitions that contain them.

## What this package is

`@suss/framework-drizzle` exports a `PatternPack` with an empty `discovery` list and no terminals. Drizzle calls become effects on handlers and services that another pack discovered. Run it alongside a handler pack such as Express or Lambda, or the effects have nothing to attach to.

Drizzle writes a query as a method chain. Each supported form has one anchor call that the pack reads the chain at, once per chain, and it reads the rest of the chain from the calls made on the anchor's result, however far out each one is:

| Written as | Anchor |
| --- | --- |
| `db.select({...}).from(users).where(...)` | `.from(t)` |
| `db.insert(users).values({...})` | `db.insert(t)` |
| `db.update(users).set({...}).where(...)` | `db.update(t)` |
| `db.delete(users).where(...)` | `db.delete(t)` |
| `db.query.users.findMany({...})` | `.findMany()` / `.findFirst()` |
| ``db.execute(sql`SELECT ...`)`` | `db.execute(s)` |

The pack checks the receiver by its type. The type's symbol has to be declared under `node_modules/drizzle-orm/`. That covers a `drizzle(...)` result from any driver entry point, a wrapped `ctx.db`, and the `tx` passed to a transaction callback, so the pack does not have to list the drivers. A project read before its dependencies are installed has no types, so a database the source makes with `drizzle(...)`, imported from `drizzle-orm` or one of its driver subpaths, counts as well. A select call kept in a variable before `.from`, `const query = db.select(); query.from(users)`, is read the same as one written in place.

The table name comes from the schema declaration. The recognizer follows the table identifier back to its `pgTable("users", {...})` declaration (or `mysqlTable` / `sqliteTable`) and takes the first string argument, so the summary records the SQL table name. When the declaration cannot be resolved, the table comes out null and does not pair with anything.

A relational query picks its table by a key, as in `db.query.users`. Drizzle types that key as a member of the schema passed to `drizzle(client, { schema })`, so the recognizer follows it to the schema export and on to the same table factory call. The key itself is never used as the table name, since a schema can export `accountDim = pgTable("dim_account", ...)`. When the key cannot be followed, for example because the database was made without a schema, the table comes out null.

Fields and selectors come from the chain. A select's object argument gives the columns it returns. `.values(...)` and `.set(...)` give the columns a write touches. `.where(...)` gives the selector: every column the condition reads off the table expression, through the operator calls it is built from, such as `and(eq(users.id, id), isNull(users.deletedAt))`.

A statement passed to `db.execute` as a tagged template is parsed as SQL instead, so a join comes out as one effect per table. An interpolated schema object resolves through the same table factory call.

## Options

Both options make the effects this pack records pair with the provider side. Pass them to `drizzleFramework()`, or as JSON with `-f drizzle=packs/drizzle.json`.

```json
{
  "storageSystem": "mysql",
  "scope": "default"
}
```

- `storageSystem`: the storage system the matched calls target, one of `"postgresql"`, `"mysql"` or `"sqlite"`. It has to match the `storageSystem` on provider summaries for the pairing keys to line up. The default is `"postgresql"`, since most Drizzle projects run on Postgres.
- `scope`: the scope label on the storage binding. The default is `"default"`.

## Not covered yet

- `alias(users, "u")` self-join aliases.
- Join clauses (`.leftJoin(orders, ...)`). The joined table does not get a second effect.
- A relational query on a schema written as an object literal, `drizzle(client, { schema: { users, orders } })`. The table comes out null. A whole-module import (`import * as schema`), or a spread of several, is followed.
- A relational query whose table is kept in a variable first, `const table = db.query.users; table.findMany()`. Nothing is recorded.
- A `where` condition built by a helper function, or kept in a variable. The access is recorded without a selector.

## Where it fits in suss

Every path is a `@suss/recognize` declaration, so the pack depends on `@suss/recognize` and on `@suss/extractor` for the `PatternPack` type, and doesn't read a syntax tree itself.

A Drizzle schema uses SQL table names, and a Prisma schema uses PascalCase model names. The two still line up, because `@suss/contract-prisma` records an `@@map` rename as `storageContract.physicalTable` and the checker accepts that as another name to pair on. Accesses from both ORMs land on the same schema provider.

## Coverage

![coverage](../../../.github/badges/coverage-drizzle.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs/what-a-pack-is.md`](../../../docs/packs/what-a-pack-is.md).
