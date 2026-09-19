# @suss/sql

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Reads what a SQL statement touches: which tables, which fields, and what it picks rows by.

## What this package is

A reader, not a pack. A pattern pack that meets a query written as SQL rather than through an ORM hands the text here and gets back the same shape its own recognizer would have produced.

```ts
import { readSqlAccess } from "@suss/sql";

readSqlAccess("SELECT id, email FROM users WHERE tenant_id = $1");
// [{ table: "users", qualifier: [], kind: "read", fields: ["id", "email"], selector: ["tenant_id"] }]
```

`qualifier` is the namespaces written in front of the table, outermost first. Postgres and MySQL hand the schema back separately and it never reaches the table, so those are always empty. BigQuery addresses a table as `` `project.dataset.table` `` and the parser hands back the whole quoted string, so this splits it: the table is the one a provider declares, and the dataset is the namespace to record the access under.

```ts
readSqlAccess("SELECT id FROM `analytics.core.dim_account`", { dialect: "bigquery" });
// [{ table: "dim_account", qualifier: ["analytics", "core"], ... }]
```

A pack that reads a table off a call's argument rather than out of a statement, the way `client.get_table("analytics.core.dim_account")` states one, splits it through `splitQualifiedTable` so both spellings land on the same table and the same namespace. It gives back nothing for a table that came through as a parameter.

```ts
splitQualifiedTable("analytics.core.dim_account");
// { table: "dim_account", qualifier: ["analytics", "core"] }
```

The statement is parsed rather than pattern-matched, so a join contributes every table it reads:

```ts
readSqlAccess("SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id");
// [{ table: "users", fields: ["email"], ... }, { table: "orders", fields: ["total"], ... }]
```

A query written as a tagged template becomes readable through `sqlFromParts`, which writes each interpolation as a parameter. What a query interpolates is a value nearly every time, and a parameter is how the statement would supply one anyway.

Two things override that. A caller who knows a hole is a table passes it in `substitutions`, which is how a Drizzle query that interpolates a schema object reaches the statement as a table name. And a caller who ran the source's own evaluator over each hole passes the results in `settled`, which are used only where the statement wrote the hole inside a quoted name:

```ts
// `SELECT id FROM \`${TABLE}\`` with TABLE = "analytics.core.dim_account"
sqlFromParts(["SELECT id FROM `", "`"], [], ["analytics.core.dim_account"]);
// SELECT id FROM `analytics.core.dim_account`
```

A hole in a value position is left alone even when the evaluator settled it. `WHERE tier = ${TIER}` with `TIER = "gold"` would parse as a column called `gold` and put it in the selector, which is worse than the parameter the reader would otherwise see. Inside a quoted name there is no such ambiguity: whatever the hole came to is part of the name.

A part of a name nothing settled stays a parameter, and the qualifier is then read from the table outward and stops there. The part beside the table is the one a scope comes from, so a project read as though it were a dataset would place the access somewhere it never went:

```
analytics.core.dim_account   → dim_account, ["analytics", "core"]
$1.core.dim_account          → dim_account, ["core"]
analytics.$1.dim_account     → dim_account, []
$1                           → nothing
```

A whole table nothing settled produces nothing at all.

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
