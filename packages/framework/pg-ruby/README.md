# @suss/framework-pg-ruby

This pack records which Postgres tables a Ruby service reads and writes through the pg gem.

## What this package is

A pattern pack for the Ruby adapter. It records the same `storage-access` effects an ActiveRecord call does. So a table a service reads or writes is the same kind of boundary whether the query went through an ORM or was written out as SQL.

```ts
import { pgRubyFramework, withPg } from "@suss/framework-pg-ruby";

const standalone = pgRubyFramework();
const alongsideRails = withPg(railsFramework(options));
```

A project that talks to Postgres directly usually runs a web framework too, so `withPg` combines this pack with whichever pack already discovers the units.

## What it reads

```ruby
conn = PG.connect(ENV["DATABASE_URL"])
conn.exec_params("SELECT id, name, tier FROM accounts WHERE id = $1", [id])
conn.exec("UPDATE accounts SET suspended_at = now()")
conn.prepare("by_email", "SELECT id FROM accounts WHERE email = $1")
```

Ruby code has no type annotations, so the pack works out a receiver's type by following it back to the gem call that produced it: `PG.connect`, `PG::Connection.new` or `PG::Connection.open`. A connection kept in a local, an instance variable or a method is read the same as one opened at the call.

The statement goes to `@suss/sql`, which works out the tables it touches, the columns it lists, and what it selects rows by. The value evaluator runs over it first, so a statement built by interpolation, or kept in a constant another file set, is read the same as one written out. Anything the evaluator could not settle becomes a parameter, since an interpolated value would have been sent as one:

```ruby
conn.exec("SELECT name FROM accounts WHERE id = #{id}")   # a read of accounts, picking by id
```

Calls that take the statement first: `exec`, `exec_params`, `async_exec`, `async_exec_params`, `sync_exec`, `sync_exec_params`, `query`, `send_query`, `send_query_params`. Calls that take a name first and the statement second: `prepare`, `async_prepare`, `sync_prepare`.

## What it will not tell you

A statement passed in from outside cannot be read. In `conn.exec(sql)`, where `sql` is a parameter, the pack cannot settle a table, so it records nothing instead of guessing. The same goes for a table interpolated from a value no code in the project sets, and for `BEGIN`, `COMMIT`, `SET` and anything else that does not touch a table.

`exec_prepared` runs a statement that `prepare` stored earlier. The pack records the `prepare` and skips each run of it, so a body that only runs a prepared statement reports nothing. `PG::Connection#copy_data` and the large-object calls are not read at all.

Every access reports its scope as `default`. A project with more than one Postgres connection cannot yet tell which one a call reached.

## Where it fits in suss

The pack depends on `@suss/adapter-ruby` for the `RubyPack` contract, and on `@suss/ir-core` for the binding it builds. The storage pass in `@suss/checker` pairs what this pack records with whatever declares the database.

- [Documentation](https://nimbuscloud-ai.github.io/suss/)
- [Source and issues](https://github.com/nimbuscloud-ai/suss)
