# @suss/framework-pg-ruby

Says which Postgres tables a Ruby service reads and writes through the pg gem.

## What this package is

A pattern pack for the Ruby adapter. It emits the same `storage-access` effects an ActiveRecord call does, so a table a service reads and a table a service writes are the same kind of boundary whether the query went through an ORM or was written out as SQL.

```ts
import { pgRubyFramework, withPg } from "@suss/framework-pg-ruby";

const standalone = pgRubyFramework();
const alongsideRails = withPg(railsFramework(options));
```

A project that talks to Postgres directly usually also runs a web framework, so `withPg` composes with whichever pack already discovers the units.

## What it reads

```ruby
conn = PG.connect(ENV["DATABASE_URL"])
conn.exec_params("SELECT id, name, tier FROM accounts WHERE id = $1", [id])
conn.exec("UPDATE accounts SET suspended_at = now()")
conn.prepare("by_email", "SELECT id FROM accounts WHERE email = $1")
```

Ruby writes no types, so a receiver is typed by following it back to the gem call that produced it: `PG.connect`, `PG::Connection.new` or `PG::Connection.open`. A connection kept in a local, an instance variable or a method reads the same as one opened at the call.

The statement goes to `@suss/sql`, which says which tables it touches, which columns it states, and what it picks rows by. It goes through the value evaluator first, so a statement built by interpolation or held in a constant another file wrote reads the same as one written out. Whatever the evaluator could not settle becomes a parameter, which is what an interpolated value would have been on the wire:

```ruby
conn.exec("SELECT name FROM accounts WHERE id = #{id}")   # a read of accounts, picking by id
```

Calls that take the statement first: `exec`, `exec_params`, `async_exec`, `async_exec_params`, `sync_exec`, `sync_exec_params`, `query`, `send_query`, `send_query_params`. Calls that take a name first and the statement second: `prepare`, `async_prepare`, `sync_prepare`.

## What it will not tell you

A statement handed in from outside says nothing: `conn.exec(sql)` where `sql` is a parameter reaches no table this can settle, and nothing is recorded rather than a guess. The same goes for a table interpolated from a value nobody wrote, and for `BEGIN`, `COMMIT`, `SET` and anything else that touches no table.

`exec_prepared` runs a statement `prepare` stored earlier, and this records the `prepare` rather than each run of it, so a body that only runs a prepared statement reports nothing. `PG::Connection#copy_data` and the large-object calls are not read at all.

Every access reports its scope as `default`. A project with more than one Postgres connection cannot yet say which one a call reached.

## Where it fits in suss

Depends on `@suss/adapter-ruby` for the `RubyPack` contract and `@suss/ir-core` for the binding it builds. The storage pass in `@suss/checker` pairs what this emits against whatever declares the database.

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
