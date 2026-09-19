# @suss/framework-bigquery-ruby

Says which BigQuery tables a Ruby service reads and writes through the google-cloud-bigquery gem.

## What this package is

A pattern pack for the Ruby adapter. It emits the same `storage-access` effects an ActiveRecord call does, so a table a job reads and a table a job writes are the same kind of boundary whether the query went through an ORM or was written out as SQL.

```ts
import { bigqueryRubyFramework, withBigquery } from "@suss/framework-bigquery-ruby";

const standalone = bigqueryRubyFramework();
const alongsideRails = withBigquery(railsFramework(options));
```

A Rails app reaches BigQuery through the gem rather than through ActiveRecord, so `withBigquery` composes with whichever pack already discovers the units.

## What it reads

```ruby
bigquery = Google::Cloud::Bigquery.new(project_id: ENV["GCP_PROJECT"])
bigquery.query("SELECT id, name FROM `analytics-prod.core.dim_account` WHERE tier = @tier", params: { tier: tier })
bigquery.dataset("core").query("SELECT id FROM events")
bigquery.dataset("core").table("report_runs").insert(rows)
```

Ruby writes no types, so a receiver is typed by following it back to the gem call that produced it. The chain starts at `Google::Cloud::Bigquery.new` or at the shorthand `Google::Cloud.bigquery`, and a client kept in a local, an instance variable or a method reads the same as one built at the call.

The statement itself goes to `@suss/sql`, which says which tables it touches, which columns it states, and what it picks rows by. It goes through the value evaluator first, so a table held in a constant another file wrote reads the same as one written out:

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

Calls that take a statement: `query`, `query_job`. Calls that reach rows with no statement: `insert`, `insert_async`, `load`, `load_job`, `data`, `exists?`, `delete`. A dataset takes the table as its first argument where a table has it already, and both spellings of `insert` come out the same.

## What it will not tell you

A statement handed in from outside says nothing: `bigquery.query(sql)` where `sql` is a parameter reaches no table this can settle, and nothing is recorded rather than a guess. The same goes for a table interpolated from a value nobody wrote, and for `BEGIN`, `COMMIT` and anything else that touches no table.

`copy` and `extract` read one table and write another, and there is no way yet to say that a call did two things to two tables, so they are left out.

Nothing here says which project a dataset belongs to unless the statement spells it, and nothing checks that a dataset the code writes exists. What the boundary is on the other side comes from whatever declares the dataset, which the checker pairs this against.

## Where it fits in suss

Depends on `@suss/adapter-ruby` for the `RubyPack` contract and `@suss/ir-core` for the binding it builds. The storage pass in `@suss/checker` pairs what this emits against whatever declares the dataset.

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
