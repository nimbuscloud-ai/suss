# @suss/framework-drizzle

Pattern pack for [Drizzle ORM](https://orm.drizzle.team/). It recognizes query-builder calls in TypeScript and emits `interaction(class: "storage-access")` effects on the transitions that contain them.

## What this package is

`@suss/framework-drizzle` returns a `PatternPack` with an empty `discovery` list and no terminals. Drizzle calls become effects on handlers and services that some other pack discovered, so run this pack alongside a handler pack (Express, Fastify, NestJS, Lambda) or the effects have nothing to land on.

Drizzle writes a query as a method chain. Each supported form has one anchor call that the recognizer fires on, once per chain, and the rest of the chain is read by walking up from the anchor:

| Written as | Anchor |
| --- | --- |
| `db.select({...}).from(users).where(...)` | `.from(t)` |
| `db.insert(users).values({...})` | `db.insert(t)` |
| `db.update(users).set({...}).where(...)` | `db.update(t)` |
| `db.delete(users).where(...)` | `db.delete(t)` |
| `db.query.users.findMany({...})` | `.findMany()` / `.findFirst()` |
| ``db.execute(sql`SELECT ...`)`` | `db.execute(s)` |

The receiver is checked by type. Its symbol declaration has to live under `node_modules/drizzle-orm/`, which covers a `drizzle(...)` result from any driver entry point, a wrapped `ctx.db`, and the `tx` handed to a transaction callback. The pack does not have to list the drivers.

The table name comes from the schema declaration. The recognizer walks the table identifier back to its `pgTable("users", {...})` (or `mysqlTable` / `sqliteTable`) declaration and takes the first string argument, so the summary records the SQL table name. When the declaration cannot be resolved, the table comes out null and pairs with nothing.

Fields and selectors are read off the chain. A select's object argument gives the projected columns, `.values(...)` and `.set(...)` give the columns a write touches, and `.where(...)` gives the selector by collecting property accesses on the table expression.

Statements handed to `db.execute` as a tagged template are parsed as SQL instead, so a join comes out as one effect per table. An interpolated schema object resolves through the same table factory call.

## Options

Both options exist so the effects this pack emits pair with the provider side. Pass them to `drizzleFramework()`, or as JSON to `-f drizzle=packs/drizzle.json`.

```json
{
  "storageSystem": "mysql",
  "scope": "default"
}
```

- `storageSystem`: the storage system the recognized calls target, one of `"postgresql"`, `"mysql"`, or `"sqlite"`. It has to match the `storageSystem` on provider summaries for pairing keys to line up. Defaults to `"postgresql"`, the dominant Drizzle deployment.
- `scope`: the scope label on the storage binding. Defaults to `"default"`.

## Not covered yet

- `alias(users, "u")` self-join aliases.
- Join clauses (`.leftJoin(orders, ...)`). The joined table is not emitted as a second effect.

## Where it fits in suss

Depends on `@suss/extractor` (for the `PatternPack` type), `@suss/behavioral-ir` (for `storageBinding`), `@suss/recognize` (which compiles the raw-SQL declaration), and `@suss/adapter-typescript`. `ts-morph` is a peer dependency, since the builder-path recognizer walks the AST directly.

A Drizzle schema uses SQL table names, while a Prisma schema uses PascalCase model names. The two still correspond, because `@suss/contract-prisma` records an `@@map` rename as `storageContract.physicalTable` and the checker accepts that as a pairing alias. Accesses from both ORMs land on the same schema provider.

## Coverage

![coverage](../../../.github/badges/coverage-drizzle.svg)

## License

Licensed under Apache 2.0. See [LICENSE](../../../LICENSE).

---

For how framework packs work, see [`docs/packs.md`](../../../docs/packs.md).
