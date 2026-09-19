# @suss/framework-pg

Says which Postgres tables a TypeScript service reads and writes through node-postgres.

## What this package is

A pattern pack. It emits the same `storage-access` effects the Drizzle and Prisma packs do, so a table one service writes through an ORM and another reads through a raw query are two ends of one boundary.

```ts
import { pgFramework } from "@suss/framework-pg";

const pack = pgFramework();
```

Every query in the library goes through one method, and the statement says the rest:

```ts
await pool.query("SELECT id, email FROM users WHERE id = $1", [id]);
```

`@suss/sql` parses that and settles the table, whether the call reads or writes, the fields it touches and what it picks rows by. A join comes out as one effect per table, each with its own fields.

## What each part contributes

| Written as | What it becomes |
| --- | --- |
| the table in the statement | the container |
| `SELECT` / `INSERT` / `UPDATE` / `DELETE` | whether the call reads or writes |
| the columns the statement states | the fields |
| the columns in the `WHERE` | the selector |

A placeholder stays a placeholder. `WHERE tier = $1` records `tier` as the selector rather than reading a value that only exists at run time.

## Which calls it reads

`query` on a `Client`, on a `Pool`, and on the client a `pool.connect()` hands back. Both spellings of the call count:

```ts
pool.query("SELECT email FROM users WHERE id = $1", [id]);
pool.query({ text: "SELECT email FROM users WHERE id = $1", values: [id] });
```

The receiver is settled by type rather than by what the program called it, so a project that builds its pool in one module and exports it is read without this pack knowing what that module is called. A `query` on something a project wrote itself is left alone.

A statement built from a template reads too, when the source settles what goes in the holes:

```ts
const USERS_TABLE = "users";
await pool.query(`SELECT id FROM ${USERS_TABLE} WHERE id = $1`, [id]);
await pool.query(`SELECT id FROM "${USERS_TABLE}"`);
```

Both holes are where the statement writes a name, straight after `FROM` in the first and inside a quoted name in the second, so what the source settled becomes the table. A hole anywhere else stays a parameter, since a constant written in a value position would parse as a column and land in the selector.

A query built with `pg-template-tag` reads as well, because the text of a tagged template comes back through the tag:

```ts
await client.query(sql`SELECT id FROM users WHERE id = ${id}`);
```

## What it will not tell you

- **A table nothing settles produces nothing.** `` pool.query(`SELECT * FROM ${table}`) `` where `table` is a parameter says nothing rather than recording a guess.
- **A statement that touches no table produces nothing.** `BEGIN`, `COMMIT` and `SET` are calls against the store, but there is no container to record them under.
- **A bare `sql` tag is not read.** The porsager `postgres` client writes its queries as `` sql`SELECT ...` `` with no receiver, so nothing settles which library the tag came from. That needs a way to pin down a bare tag by where it was made.
- **Which database.** Every access records the scope the pack was built with, so a project with two Postgres connections has both under one name.

## Where it fits in suss

Depends on `@suss/recognize` for the chain and, through it, on `@suss/sql` for the parse. The storage pass in `@suss/checker` pairs what this emits against whatever declares the table, which is a Prisma schema, a Drizzle schema, or a Terraform database.
