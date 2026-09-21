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

A query written in place of a table is read for its own tables. The alias belongs to that query's columns rather than to a base table, so a column read through the alias is dropped rather than attributed to one:

```ts
readSqlAccess("SELECT dc.account_id FROM (SELECT account_id FROM dim_contact) dc JOIN dim_account a ON a.id = dc.account_id");
// [{ table: "dim_account", fields: [], ... }, { table: "dim_contact", fields: ["account_id"], ... }]
```

A write reads too. An insert can take its rows from a query, and an update or a delete can reach another table to pick the rows it changes:

```ts
readSqlAccess("INSERT INTO runs (id) SELECT id FROM jobs");
// [{ table: "runs", kind: "write", fields: ["id"], ... }, { table: "jobs", kind: "read", fields: ["id"], ... }]
```

Every branch of a set operation is read, whether the statement writes it on its own, inside a `WITH` clause, or in place of a table. `SELECT id FROM orders UNION SELECT id FROM refunds` gives back a read on `orders` and one on `refunds`, each with the field `id`.

Wherever a field turns up, it goes on the table the statement qualified it to, and a `WHERE` puts it in the selector rather than the fields. So the table an update reads from lists its join key the way a table a select joins to would:

```ts
readSqlAccess("UPDATE runs SET state = $1 FROM jobs WHERE runs.job_id = jobs.id");
// [{ table: "runs", kind: "write", fields: ["state"], selector: ["job_id"] },
//  { table: "jobs", kind: "read", fields: [], selector: ["id"] }]
```

What a `RETURNING` hands back, and what an `ON CONFLICT` matches on and then sets, are all columns of the one table the statement writes, so they go on that write rather than on a second access: a consumer pairs one access per table against the schema, and a field the statement both writes and hands back is listed once. `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id` writes `users` with the fields `email`, `id` and `name`.

Not every grammar takes every spelling of these. `UPDATE ... FROM` is Postgres alone, and BigQuery parses the statement but drops the clause, so there it gives back the write by itself. No grammar here takes `DELETE ... USING`. `INTERSECT` and `EXCEPT` are Postgres and MySQL, `RETURNING` is Postgres and SQLite, and `ON CONFLICT` is Postgres, where the other three grammars take `ON DUPLICATE KEY UPDATE` instead.

The grammar behind this turns down two spellings that say nothing about which table is touched, so a statement it refuses is tried again without them: a parameter written with the type it is read as, such as `$1::text` or `$1::int[]`, and a select that locks the rows it picks, such as `FOR UPDATE SKIP LOCKED`. Neither is rewritten inside a literal, a quoted name or a comment.

The grammar also takes a `WITH` clause only in front of a select. In front of an insert, an update or a delete the clause is split off and each query read on its own, which is the most that can be read of a statement the grammar will not take whole:

```ts
readSqlAccess("WITH due AS (SELECT id FROM jobs FOR UPDATE SKIP LOCKED) INSERT INTO job_runs (job_id) SELECT id FROM due");
// [{ table: "job_runs", kind: "write", fields: ["job_id"], ... }, { table: "jobs", kind: "read", fields: ["id"], ... }]
```

A query written as a tagged template becomes readable through `sqlFromParts`, which writes each interpolation as a parameter. What a query interpolates is a value nearly every time, and a parameter is how the statement would supply one anyway.

Two things override that. A caller who knows a hole is a table passes it in `substitutions`, which is how a Drizzle query that interpolates a schema object reaches the statement as a table name. And a caller who ran the source's own evaluator over each hole passes the results in `settled`, which are used where the statement writes a name.

There are two of those places. One is inside a quoted name, which is how BigQuery addresses a table:

```ts
// `SELECT id FROM \`${TABLE}\`` with TABLE = "analytics.core.dim_account"
sqlFromParts(["SELECT id FROM `", "`"], [], ["analytics.core.dim_account"]);
// SELECT id FROM `analytics.core.dim_account`
```

The other is straight after `FROM`, `JOIN`, `INTO`, `UPDATE` or `TABLE`, in any case. Postgres code leaves the table unquoted nearly every time, so the quote alone would miss the commonest way a project interpolates one:

```ts
// `SELECT id FROM ${TABLE} WHERE id = $1` with TABLE = "users"
sqlFromParts(["SELECT id FROM ", " WHERE id = $1"], [], ["users"]);
// SELECT id FROM users WHERE id = $1
```

A hole anywhere else is left alone even when the evaluator settled it. `WHERE tier = ${TIER}` with `TIER = "gold"` would parse as a column called `gold` and put it in the selector, which is worse than the parameter the reader would otherwise see. Where the statement writes a name there is no such ambiguity: whatever the hole came to is part of the name.

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
- **An unqualified field in a join is left out.** `SELECT id FROM users u JOIN orders o ON ...` says nothing about which table `id` is on, so it is dropped rather than attributed to both. A query written in place of a table counts as one of the sides, since it could have supplied the field too.
- **An interpolated table or clause makes a statement unreadable.** ``sql`SELECT * FROM ${table}` `` cannot be settled without running it, so it produces nothing.

## Where it fits in suss

`@suss/recognize` uses it for every TypeScript pack that declares a method taking a statement (drizzle, pg, bigquery, prisma), `@suss/framework-cloudflare-workers` for D1 bindings, and the Python and Ruby adapters for the statements their packs declare. It depends on nothing inside suss, so it stays a plain function over a string.

The grammars come from `node-sql-parser` and are bundled into this package's build rather than installed, which is why it has no runtime dependencies. See THIRD-PARTY-NOTICES.md.
