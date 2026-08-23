# @suss/sql

Reads what a SQL statement touches: which tables, which fields, and what it picks rows by.

## What this package is

A reader, not a pack. A pattern pack that meets a query written as SQL rather than through an ORM hands the text here and gets back the same shape its own recognizer would have produced.

```ts
import { readSqlAccess } from "@suss/sql";

readSqlAccess("SELECT id, email FROM users WHERE tenant_id = $1");
// [{ table: "users", kind: "read", fields: ["id", "email"], selector: ["tenant_id"] }]
```

The statement is parsed rather than pattern-matched, so a join contributes every table it reads:

```ts
readSqlAccess("SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id");
// [{ table: "users", fields: ["email"], ... }, { table: "orders", fields: ["total"], ... }]
```

A query written as a tagged template becomes readable through `sqlFromParts`, which writes each interpolation as a parameter. What a query interpolates is a value nearly every time, and a parameter is how the statement would supply one anyway.

It reads Postgres, MySQL, SQLite, and BigQuery. Pass the dialect the way a pack states its store:

```ts
readSqlAccess("SELECT `id` FROM `users`", { dialect: "mysql" });
```

## What it will not tell you

- **A dialect it does not read gives back nothing.** So does a statement it cannot parse. Neither produces a guess built out of whatever the text happens to spell.
- **An unqualified field in a join is left out.** `SELECT id FROM users u JOIN orders o ON ...` says nothing about which table `id` is on, so it is dropped rather than attributed to both.
- **An interpolated table or clause makes a statement unreadable.** ``sql`SELECT * FROM ${table}` `` cannot be settled without running it, so it produces nothing.

## Where it fits in suss

`@suss/framework-drizzle` uses it for ``db.execute(sql`...`)``. Nothing else depends on it, and it depends on nothing inside suss, so it stays a plain function over a string.

The grammars come from `node-sql-parser` and are bundled into this package's build rather than installed, which is why it has no runtime dependencies. See THIRD-PARTY-NOTICES.md.
