# @suss/framework-bigquery

This pack records which BigQuery datasets and tables a TypeScript service reads and writes.

## What this package is

A pattern pack. It records the same `storage-access` effects the Postgres and DynamoDB packs do, so a warehouse table is the same kind of boundary as any other store.

```ts
import { bigqueryFramework } from "@suss/framework-bigquery";

const pack = bigqueryFramework();
```

A caller reaches BigQuery in two ways, and the pack reads both.

## A statement

```ts
await bigquery.query("SELECT id, name FROM `analytics-prod.core.dim_account` WHERE tier = @tier");
```

`@suss/sql` parses that in BigQuery's own dialect and works out what the statement touches. A table is written as `` `project.dataset.table` ``, so the parser splits it: `dim_account` becomes the container and `core` becomes the scope. A join comes out as one effect per table.

The statement is passed either as the argument or under the `query` key of an options object, and the pack reads both:

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

`.dataset(d)` gives the scope and `.table(t)` gives the container. A statement produces the same pair, so the two ways of writing an access pair with each other. When a dataset was stored in a variable first, the pack follows it back to where it was built.

Operations that read: `getRows`, `exists`. Operations that write: `insert`, `load`, `delete`.

`insert`, `load` and `getRows` touch whole rows, so their fields are `["*"]`. `exists` and `delete` act on the table itself, so they do not list any field.

## A table name the source builds

```ts
const TABLE = "analytics-prod.core.dim_account";
await bigquery.query(`SELECT id, name FROM \`${TABLE}\``);
```

The hole is inside a backtick-quoted name, so the value the source gives it becomes part of the table. A part that cannot be settled is dropped, and the rest is still read:

```ts
await bigquery.query(`SELECT id FROM \`${project}.${dataset}.dim_account\``);
// container dim_account, scope default
```

## What it will not tell you

- **A table that cannot be settled produces nothing.** The pack never invents a project or dataset for one.
- **Which columns a row insert writes.** `insert(rows)` records `["*"]` and does not read the keys of whatever was inserted.
- **A query run through a job the code did not write.** A statement that comes from a file, from a template the code loads at run time, or from another service is not visible in the source.
- **Anything about the schema.** Pairing a table this pack reads with one that Terraform or a schema file declares is the checker's job.

## Where it fits in suss

The pack depends on `@suss/recognize` for both chains, and through it on `@suss/sql` for the parse. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the table.
