# @suss/framework-activerecord

Says which calls a Ruby body makes against the database, for a project on
Rails.

## What this package is

A pattern pack. It states the base class ActiveRecord gives every model and
the methods that change what is stored, and the Ruby adapter does the
matching.

```ts
import { graphqlRubyFramework } from "@suss/framework-graphql-ruby";
import { withActiveRecord } from "@suss/framework-activerecord";

const pack = withActiveRecord(graphqlRubyFramework({}), {
  storageSystem: "postgresql",
});
```

A GraphQL schema and a database library are separate libraries, and a project
picks both, so this composes onto whichever pack a run already uses.
`activeRecordFramework` is there for a run that wants the storage patterns
and no discovery.

`storageSystem` is yours to say. ActiveRecord talks to Postgres, MySQL and
SQLite alike and database.yml settles which, so the pack cannot.

## Why it matches on ancestry

Ruby writes no return type, so the SQLAlchemy pack's trick of reading what a
method says it gives back has no counterpart here. A call matches when the
constant its receivers start at reaches `ActiveRecord::Base`, following what
each class extends. Rails puts its own class between the library and every
model, and the walk goes through it:

```ruby
class ApplicationRecord < ActiveRecord::Base; end
class Order < ApplicationRecord; end

Order.where(id: 1).first   # one read, against Order, picking rows by id
```

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The chain
above is one read, not three calls. The method the chain ends with tells a
read from a write, and the keywords along it become the selector.

A name two files declare says nothing, because picking one class would be a
guess. `fields` comes back empty, and a call on anything that is not a
constant says nothing, since there is no class to ask about.

## License

Apache-2.0
