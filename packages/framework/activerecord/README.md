# @suss/framework-activerecord

Says which calls a Ruby body makes against the database, for a project on
Rails.

## What this package is

A pattern pack. It states the base class ActiveRecord gives every model,
which of its methods read the database and which change what is stored,
and the four calls a model writes to declare an association. The Ruby
adapter does the matching.

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
method says it gives back has no counterpart here. A call matches when its
method is one this pack lists, the class behind its receiver reaches
`ActiveRecord::Base`, and the project does not declare that method itself.
Rails puts its own class between the library and every model, and the walk
goes through it:

```ruby
class ApplicationRecord < ActiveRecord::Base; end
class Order < ApplicationRecord; end

Order.where(id: 1).first   # one read, against Order, picking rows by id
Order.new(name: name)      # nothing: a constructor asks the database for nothing
Order.transaction { ... }  # nothing: the calls inside it are the database work
Order.recent_for(account)  # nothing: suss reads the project's own method instead
```

## What the pack declares

`writes` is the methods ActiveRecord defines that change what is stored, and
`reads` is the methods it defines that run a query: the finders, the
calculations, the batch readers, and the relation builders such as `where`
and `order`. A builder on its own is lazy, and the query runs when something
asks the relation for rows. Recording it as a read is what the code asked
for: a body that writes `Account.where(handle: handle)` is asking the
database for those rows, wherever the fetch happens.

`givesBack` is about something else: what a method hands back, so the
resolution rules can follow it. The two lists differ on purpose:
`new`, `build` and `reload` give back a record, and only `reload` reads
anything, while `update_all` runs a query and gives back a count.
`find_or_create_by` is in `writes`, since storing a row is the stronger of
the two things it may do.

`byPrimaryKey` says which methods take the primary key as a positional
argument, so `Account.find(params[:id])` comes out with `id` as its
selector, and `column` is `id` because that is what ActiveRecord uses
unless a model declares another. `columnArguments` says which reads are
given the columns they want as symbols, so `pluck(:name, :email)` comes out
with those two as its fields.

Every identifier here is ActiveRecord's own, and
[vocabulary.json](./vocabulary.json) says where in the library each comes
from.

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
above is one read, not three calls. The effect lands on the outermost call
ActiveRecord defines, and that call tells a read from a write. A method of
your own written after it, as in `Status.find(id)&.proper`, does not hide the
read: the reach walk follows that method and reports whatever its body does.

`selector` is what the chain picked rows by: the keywords of every read along
it, plus the primary key where a lookup by it was given one. `fields` is what
a write was given as data, and on a read it is the columns the call asked for
by name:

```ruby
Account.find(params[:id])                     # read, selector id
Account.find_by(email: email)                 # read, selector email
Account.pluck(:name, :email)                  # read, fields name and email
Account.create(name: name, email: email)      # write, fields name and email
Account.where(id: id).update_all(state: 1)    # write, selector id, fields state
Account.create(attrs)                         # write, no fields
```

An argument written as a variable states no column, and the last line is the
answer rather than a gap.

A name two files declare says nothing, because picking one class would be a
guess. A call on a receiver the rules settle on no class, or on two, says
nothing for the same reason.

## License

Apache-2.0
