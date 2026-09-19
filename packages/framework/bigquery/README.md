# @suss/framework-bigquery

Says which BigQuery datasets and tables a TypeScript service reads and writes.

## What this package is

A pattern pack. It emits the same `storage-access` effects the Postgres and DynamoDB packs do, so a warehouse table is the same kind of boundary as any other store.

```ts
import { bigqueryFramework } from "@suss/framework-bigquery";

const pack = bigqueryFramework();
```

A caller reaches BigQuery two ways, and the pack reads both.

## A statement

```ts
await bigquery.query("SELECT id, name FROM `analytics-prod.core.dim_account` WHERE tier = @tier");
```

`@suss/sql` parses that in BigQuery's own dialect and settles what the statement touches. A table is addressed as `` `project.dataset.table` ``, so the parse splits it: `dim_account` becomes the container and `core` becomes the scope. A join comes out as one effect per table.

The statement travels as the argument or under the `query` key of an options object, and both are read:

```ts
await bigquery.query({ query: sql, params: { tier }, location: "US" });
await bigquery.createQueryJob({ query: sql });
bigquery.createQueryStream({ query: sql });
```

A parameter stays a parameter, so `WHERE tier = @tier` records `tier` as the selector.

## A table reached through a chain

```ts
await bigquery.dataset("core").table("fct_event").insert(rows);
```

`.dataset(d)` gives the scope and `.table(t)` gives the container, which is the same pair a statement produces, so the two spellings of an access pair with each other. A dataset written into a variable first is followed back to where it was built.

Operations that read: `getRows`, `exists`. Operations that write: `insert`, `load`, `delete`.

`insert`, `load` and `getRows` touch whole rows, so their fields are `["*"]`. `exists` and `delete` are about the table rather than its rows, so they state no field.

## A table name the source builds

```ts
const TABLE = "analytics-prod.core.dim_account";
await bigquery.query(`SELECT id, name FROM \`${TABLE}\``);
```

The hole is written inside a backtick-quoted name, so what the source settled it to becomes part of the table. A part nothing settles is dropped and the rest still reads:

```ts
await bigquery.query(`SELECT id FROM \`${project}.${dataset}.dim_account\``);
// container dim_account, scope default
```

## What it will not tell you

- **A table nothing settles produces nothing.** No project or dataset is ever invented for one.
- **Which columns a row insert writes.** `insert(rows)` records `["*"]` rather than reading the keys of whatever went in.
- **A query run through a job the code did not write.** A statement that arrives from a file, a template the code loads at run time, or another service is outside what a reader of the source can see.
- **Nothing about the schema.** Pairing a table this reads against one Terraform or a schema file declares is the checker's job.

## Where it fits in suss

Depends on `@suss/recognize` for both chains and, through it, on `@suss/sql` for the parse. The storage pass in `@suss/checker` pairs what this emits against whatever declares the table.
