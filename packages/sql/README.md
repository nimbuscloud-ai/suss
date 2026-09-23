# @suss/sql

Part of [suss](https://github.com/nimbuscloud-ai/suss), which reads both sides of every call in a repository and says where the two disagree.

Reads what a SQL statement touches: which tables, which fields, and what it picks rows by.

## What this package is

This package is a reader and does not register as a pack. When a pattern pack finds a query written as SQL instead of through an ORM, it passes the text here and gets back the same shape its own recognizer would have produced.

```ts
import { readSqlAccess } from "@suss/sql";

readSqlAccess("SELECT id, email FROM users WHERE tenant_id = $1");
// [{ table: "users", qualifier: [], kind: "read", fields: ["id", "email"], selector: ["tenant_id"] }]
```

`qualifier` lists the namespaces written in front of the table, outermost first. For Postgres and MySQL the parser returns the schema separately and it never reaches the table, so `qualifier` is always empty there. BigQuery addresses a table as `` `project.dataset.table` ``, and the parser returns the whole quoted string, so this package splits it. The table is the one a provider declares, and the dataset is the namespace the access is recorded under.

```ts
readSqlAccess("SELECT id FROM `analytics.core.dim_account`", { dialect: "bigquery" });
// [{ table: "dim_account", qualifier: ["analytics", "core"], ... }]
```

Some packs read a table off a call's argument, as in `client.get_table("analytics.core.dim_account")`, and not out of a statement. They split it through `splitQualifiedTable`, so both spellings land on the same table and the same namespace. It returns nothing for a table that came through as a parameter.

```ts
splitQualifiedTable("analytics.core.dim_account");
// { table: "dim_account", qualifier: ["analytics", "core"] }
```

The statement is parsed with a grammar, so a join contributes every table it reads:

```ts
readSqlAccess("SELECT u.email, o.total FROM users u JOIN orders o ON o.user_id = u.id");
// [{ table: "users", fields: ["email"], ... }, { table: "orders", fields: ["total"], ... }]
```

A query written in place of a table is read for its own tables. The alias refers to that query's columns and not to a base table, so a column read through the alias is dropped instead of being attributed to a table:

```ts
readSqlAccess("SELECT dc.account_id FROM (SELECT account_id FROM dim_contact) dc JOIN dim_account a ON a.id = dc.account_id");
// [{ table: "dim_account", fields: [], ... }, { table: "dim_contact", fields: ["account_id"], ... }]
```

A write can read too. An insert can take its rows from a query, and an update or a delete can reach another table to pick the rows it changes:

```ts
readSqlAccess("INSERT INTO runs (id) SELECT id FROM jobs");
// [{ table: "runs", kind: "write", fields: ["id"], ... }, { table: "jobs", kind: "read", fields: ["id"], ... }]
```

Every branch of a set operation is read, whether the statement writes it on its own, inside a `WITH` clause, or in place of a table. `SELECT id FROM orders UNION SELECT id FROM refunds` returns a read on `orders` and one on `refunds`, each with the field `id`.

Wherever a field appears, it goes on the table the statement qualified it with. A field in a `WHERE` goes in the selector and not in the fields. So the table an update reads from lists its join key, the same way a table joined in a select would:

```ts
readSqlAccess("UPDATE runs SET state = $1 FROM jobs WHERE runs.job_id = jobs.id");
// [{ table: "runs", kind: "write", fields: ["state"], selector: ["job_id"] },
//  { table: "jobs", kind: "read", fields: [], selector: ["id"] }]
```

The columns a `RETURNING` returns, and the columns an `ON CONFLICT` matches on and then sets, all belong to the one table the statement writes. So they go on that write, and no second access is created. A consumer pairs one access per table against the schema, and a field the statement both writes and returns is listed once. `INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id` writes `users` with the fields `email`, `id` and `name`.

Not every grammar accepts every spelling of these. Only Postgres accepts `UPDATE ... FROM`. BigQuery parses the statement but drops the clause, so there it returns the write by itself. No grammar here accepts `DELETE ... USING`. `INTERSECT` and `EXCEPT` work in Postgres and MySQL, and `RETURNING` in Postgres and SQLite. `ON CONFLICT` is Postgres only, and the other three grammars accept `ON DUPLICATE KEY UPDATE` instead.

The grammar rejects two spellings that have nothing to do with which table is touched, so a statement it rejects is tried again with them removed. One is a parameter written with the type it is read as, such as `$1::text` or `$1::int[]`. The other is a select that locks the rows it picks, such as `FOR UPDATE SKIP LOCKED`. Neither is rewritten inside a literal, a quoted name or a comment.

The grammar also accepts a `WITH` clause only in front of a select. In front of an insert, an update or a delete, the clause is split off and each query is read on its own. That is as much as can be read of a statement the grammar will not accept whole:

```ts
readSqlAccess("WITH due AS (SELECT id FROM jobs FOR UPDATE SKIP LOCKED) INSERT INTO job_runs (job_id) SELECT id FROM due");
// [{ table: "job_runs", kind: "write", fields: ["job_id"], ... }, { table: "jobs", kind: "read", fields: ["id"], ... }]
```

`sqlFromParts` makes a query written as a tagged template readable, by writing each interpolation as a parameter. A query interpolates a value nearly every time, and a parameter is how the statement would supply a value anyway.

Two options override that. A caller who knows a hole is a table passes it in `substitutions`. That is how a Drizzle query that interpolates a schema object reaches the statement as a table name. A caller who ran the source's own evaluator over each hole passes the results in `settled`, and they are used where the statement writes a name.

The statement writes a name in two places. One is inside a quoted name, which is how BigQuery addresses a table:

```ts
// `SELECT id FROM \`${TABLE}\`` with TABLE = "analytics.core.dim_account"
sqlFromParts(["SELECT id FROM `", "`"], [], ["analytics.core.dim_account"]);
// SELECT id FROM `analytics.core.dim_account`
```

The other is directly after `FROM`, `JOIN`, `INTO`, `UPDATE` or `TABLE`, in any case. Postgres code nearly always leaves the table unquoted, so checking for the quote alone would miss the most common way a project interpolates a table:

```ts
// `SELECT id FROM ${TABLE} WHERE id = $1` with TABLE = "users"
sqlFromParts(["SELECT id FROM ", " WHERE id = $1"], [], ["users"]);
// SELECT id FROM users WHERE id = $1
```

A hole anywhere else is left alone, even when the evaluator settled it. `WHERE tier = ${TIER}` with `TIER = "gold"` would parse as a column called `gold` and put it in the selector, which is worse than the parameter the reader would otherwise see. Where the statement writes a name, there is no such ambiguity, because whatever the hole came to is part of the name.

A part of a name that nothing settled stays a parameter. The qualifier is then read from the table outward, and stops at that parameter. The part next to the table is the one a scope comes from, so reading a project as if it were a dataset would place the access somewhere it never went:

```
analytics.core.dim_account   → dim_account, ["analytics", "core"]
$1.core.dim_account          → dim_account, ["core"]
analytics.$1.dim_account     → dim_account, []
$1                           → nothing
```

A whole table that nothing settled produces nothing at all.

It reads Postgres, MySQL, SQLite, and BigQuery. Pass the dialect the same way a pack declares its store:

```ts
readSqlAccess("SELECT `id` FROM `users`", { dialect: "mysql" });
```

## What it will not tell you

- **A dialect it does not read returns nothing.** So does a statement it cannot parse. In both cases it does not guess from whatever words the text happens to contain.
- **An unqualified field in a join is left out.** `SELECT id FROM users u JOIN orders o ON ...` does not show which table `id` is on, so the field is dropped and not attributed to both. A query written in place of a table counts as one of the sides, since it could have supplied the field too.
- **An interpolated table or clause makes a statement unreadable.** ``sql`SELECT * FROM ${table}` `` cannot be settled without running it, so it produces nothing.

## Where it fits in suss

`@suss/framework-drizzle` uses it for ``db.execute(sql`...`)``. Nothing else depends on it, and it depends on nothing inside suss, so it stays a plain function over a string.

The grammars come from `node-sql-parser`. They are bundled into this package's build and not installed, which is why the package has no runtime dependencies. See THIRD-PARTY-NOTICES.md.
