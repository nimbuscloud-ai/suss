# @suss/framework-activerecord

Says which calls a Ruby body makes against the database, for a project on
Rails.

## What this package is

A pattern pack. It states the base class ActiveRecord gives every model,
the methods that change what is stored, and the four calls a model writes
to declare an association, and the Ruby adapter does the matching.

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

From the CLI, the option comes from a config file, and a bare
`-f activerecord` stops with a message asking for one:

```sh
echo '{ "storageSystem": "postgresql" }' > suss.activerecord.json
suss extract -f rails -f activerecord=suss.activerecord.json
```

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

## What an association says

`has_many`, `has_one`, `belongs_to` and `has_and_belongs_to_many` in a
model's body each say that model reaches another one. The pack lists the
four call names, split by whether Rails writes the name in the singular
or the plural, and the keyword that says the class outright:

```ts
associations: {
  singular: ["has_one", "belongs_to"],
  plural: ["has_many", "has_and_belongs_to_many"],
  classNameKeyword: "class_name",
}
```

The adapter turns each declaration into a fact the shared rules read, so
`@account.statuses.find(params[:id])` is a read against `Status`. The
class comes from `class_name:` when the call writes one, and otherwise
from the association's own name put through the inflections
ActiveSupport ships. A project's own
`config/initializers/inflections.rb` is not read, so a word it teaches
Rails about inflects the default way here and the association reaches a
name nothing in the project declares, which says nothing at all.

A concern is covered too. `has_many` inside an `included do` belongs to
the module, and the module is in every including model's ancestry.

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The chain
above is one read, not three calls. The method the chain ends with tells a
read from a write, and the keywords along it become the selector.

A name two files declare says nothing, because picking one class would be a
guess. `fields` comes back empty, and a call on anything that is not a
constant says nothing, since there is no class to ask about.

## License

Apache-2.0
