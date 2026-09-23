# @suss/framework-bigquery-ruby

This pack records which BigQuery tables a Ruby service reads and writes through the google-cloud-bigquery gem.

## What this package is

A pattern pack for the Ruby adapter. It records the same `storage-access` effects an ActiveRecord call does. So a table a job reads or writes is the same kind of boundary whether the query went through an ORM or was written out as SQL.

```ts
import { bigqueryRubyFramework, withBigquery } from "@suss/framework-bigquery-ruby";

const standalone = bigqueryRubyFramework();
const alongsideRails = withBigquery(railsFramework(options));
```

A Rails app reaches BigQuery through the gem, outside ActiveRecord, so `withBigquery` combines this pack with whichever pack already discovers the units.

## What it reads

```ruby
bigquery = Google::Cloud::Bigquery.new(project_id: ENV["GCP_PROJECT"])
bigquery.query("SELECT id, name FROM `analytics-prod.core.dim_account` WHERE tier = @tier", params: { tier: tier })
bigquery.dataset("core").query("SELECT id FROM events")
bigquery.dataset("core").table("report_runs").insert(rows)
```

Ruby code has no type annotations, so the pack works out a receiver's type by following it back to the gem call that produced it. The chain starts at `Google::Cloud::Bigquery.new` or at the shorthand `Google::Cloud.bigquery`. A client kept in a local, an instance variable or a method is read the same as one built at the call.

The statement goes to `@suss/sql`, which works out the tables it touches, the columns it lists, and what it selects rows by. The value evaluator runs over it first, so a table kept in a constant another file set is read the same as one written out:

```ruby
ACCOUNTS_TABLE = Tables::ACCOUNTS   # "analytics-prod.core.dim_account"
bigquery.query("SELECT id FROM `#{ACCOUNTS_TABLE}`")
```

| Written as | What it becomes |
| --- | --- |
| `project.dataset.table` in the statement | `dataset` is the scope, `table` the container |
| `.dataset("core")` | the scope, for a statement that writes a bare table |
| `.table("report_runs")` | the container, for a call with no statement |
| a `@tier` or `#{...}` in the statement | a parameter, so the selector reads and the value does not |

Calls that take a statement: `query`, `query_job`. Calls that reach rows with no statement: `insert`, `insert_async`, `load`, `load_job`, `data`, `exists?`, `delete`. Called on a dataset, these take the table as their first argument. Called on a table, they leave it out. Both ways of calling `insert` come out the same.

## What it will not tell you

A statement passed in from outside cannot be read. In `bigquery.query(sql)`, where `sql` is a parameter, the pack cannot settle a table, so it records nothing instead of guessing. The same goes for a table interpolated from a value no code in the project sets, and for `BEGIN`, `COMMIT` and anything else that does not touch a table.

`copy` and `extract` read one table and write another. An effect cannot yet describe one call doing two things to two tables, so the pack leaves them out.

The pack only knows which project a dataset belongs to when the statement spells it out, and it does not check that a dataset the code writes exists. The other side of the boundary comes from whatever declares the dataset, and the checker pairs this pack's accesses with that.

## Where it fits in suss

The pack depends on `@suss/adapter-ruby` for the `RubyPack` contract, and on `@suss/ir-core` for the binding it builds. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the dataset.

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
