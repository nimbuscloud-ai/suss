# @suss/framework-pg

This pack records which Postgres tables a TypeScript service reads and writes through node-postgres.

## What this package is

A pattern pack. It records the same `storage-access` effects the Drizzle and Prisma packs do. So when one service writes a table through an ORM and another reads it with a raw query, the two are ends of one boundary.

```ts
import { pgFramework } from "@suss/framework-pg";

const pack = pgFramework();
```

Every query in the library goes through one method, and the pack reads everything else from the statement:

```ts
await pool.query("SELECT id, email FROM users WHERE id = $1", [id]);
```

`@suss/sql` parses that and works out the table, whether the call reads or writes, the fields it touches, and what it selects rows by. A join comes out as one effect per table, each with its own fields.

## What each part contributes

| Written as | What it becomes |
| --- | --- |
| the table in the statement | the container |
| `SELECT` / `INSERT` / `UPDATE` / `DELETE` | whether the call reads or writes |
| the columns the statement states | the fields |
| the columns in the `WHERE` | the selector |

A placeholder stays a placeholder. `WHERE tier = $1` records `tier` as the selector, since the value only exists at run time.

## Which calls it reads

`query` on a `Client`, on a `Pool`, and on the client that `pool.connect()` returns. Both ways of calling it count:

```ts
pool.query("SELECT email FROM users WHERE id = $1", [id]);
pool.query({ text: "SELECT email FROM users WHERE id = $1", values: [id] });
```

The pack settles the receiver by its type, whatever the program calls the variable. So if a project builds its pool in one module and exports it, the pack reads it without knowing the module's name. A `query` on something the project wrote itself is ignored.

A statement built from a template is read too, when the source settles what goes in the holes:

```ts
const USERS_TABLE = "users";
await pool.query(`SELECT id FROM ${USERS_TABLE} WHERE id = $1`, [id]);
await pool.query(`SELECT id FROM "${USERS_TABLE}"`);
```

In both statements the hole is where a name goes: straight after `FROM` in the first, and inside a quoted name in the second. So the value the source gives it becomes the table. A hole anywhere else stays a parameter, because a constant in a value position would parse as a column and end up in the selector.

A query built with `pg-template-tag` is read as well, because the tag returns the text of the tagged template:

```ts
await client.query(sql`SELECT id FROM users WHERE id = ${id}`);
```

## What it will not tell you

- **A table that cannot be settled produces nothing.** For `` pool.query(`SELECT * FROM ${table}`) ``, where `table` is a parameter, the pack records nothing instead of a guess.
- **A statement that touches no table produces nothing.** `BEGIN`, `COMMIT` and `SET` are calls against the store, but there is no container to record them under.
- **A bare `sql` tag is not read.** The porsager `postgres` client writes its queries as `` sql`SELECT ...` `` with no receiver, so the pack cannot tell which library the tag came from. Reading it needs a way to trace a bare tag back to where it was created.
- **Which database.** Every access records the scope the pack was built with, so a project with two Postgres connections gets both under one name.

## Where it fits in suss

The pack depends on `@suss/recognize` for the chain, and through it on `@suss/sql` for the parse. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the table, such as a Prisma schema, a Drizzle schema, or a Terraform database.
