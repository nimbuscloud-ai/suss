# @suss/framework-activerecord

This pack records which calls a Ruby body makes against the database, for
a project on Rails.

## What this package is

A pattern pack. It declares the base class ActiveRecord gives every model,
which of its methods read the database and which change what is stored,
and the four calls a model uses to declare an association. The Ruby
adapter does the matching.

```ts
import { graphqlRubyFramework } from "@suss/framework-graphql-ruby";
import { withActiveRecord } from "@suss/framework-activerecord";

const pack = withActiveRecord(graphqlRubyFramework({}), {
  storageSystem: "postgresql",
});
```

A project picks its GraphQL library and its database library separately,
so this pack combines with whichever pack a run already uses.
`activeRecordFramework` is for a run that wants the storage patterns and
no discovery.

You have to set `storageSystem`. ActiveRecord works with Postgres, MySQL
and SQLite, and database.yml decides which, so the pack cannot work it
out.

From the CLI, the option comes from a config file. A bare
`-f activerecord` stops with a message asking for one:

```sh
echo '{ "storageSystem": "postgresql" }' > suss.activerecord.json
suss extract -f rails -f activerecord=suss.activerecord.json
```

## Why it matches on ancestry

Ruby code has no return types, so the SQLAlchemy pack's approach of
reading a method's declared return type does not carry over. Here a call
matches when three things are true: its method is one this pack lists, the
class behind its receiver reaches `ActiveRecord::Base`, and the project
does not define that method itself. Rails puts its own class between the
library and every model, and the walk goes through it:

```ruby
class ApplicationRecord < ActiveRecord::Base; end
class Order < ApplicationRecord; end

Order.where(id: 1).first   # one read, against Order, picking rows by id
Order.new(name: name)      # nothing: a constructor asks the database for nothing
Order.transaction { ... }  # nothing: the calls inside it are the database work
Order.recent_for(account)  # nothing: suss reads the project's own method instead
```

## What the pack declares

`writes` lists the methods ActiveRecord defines that change what is
stored. `reads` lists the methods it defines that run a query: the
finders, the calculations, the batch readers, and the relation builders
such as `where` and `order`. A builder by itself is lazy, and the query
only runs when something asks the relation for rows. Recording the
builder as a read still matches what the code asked for. A body that
writes `Account.where(handle: handle)` is asking the database for those
rows, wherever the fetch happens.

`givesBack` is a separate list. It records what a method returns, so the
resolution rules can follow it, and it differs from the other two on
purpose. `new`, `build` and `reload` return a record, and only `reload`
reads anything. `update_all` runs a query and returns a count.
`find_or_create_by` is in `writes`, since storing a row is the stronger
of the two things it may do.

`statements` lists the finders that take SQL the project wrote, where
ActiveRecord does not build it from the model. `bindPlaceholder`
declares that ActiveRecord writes `?` where a bind value goes. The
section on statements below explains what follows from that.

`byPrimaryKey` lists the methods that take the primary key as a
positional argument, so `Account.find(params[:id])` comes out with `id`
as its selector. Its `column` is `id`, because ActiveRecord uses that
unless a model declares another. `columnArguments` lists the reads that
take the columns they want as symbols, so `pluck(:name, :email)` comes
out with those two as its fields.

Every identifier here is ActiveRecord's own, and
[vocabulary.json](./vocabulary.json) records where in the library each
one comes from.

## Associations

`has_many`, `has_one`, `belongs_to` and `has_and_belongs_to_many` in a
model's body each declare that the model reaches another one. The pack
lists the four call names, split by whether Rails writes the name in
the singular or the plural, and the keyword that gives the class
explicitly:

```ts
associations: {
  singular: ["has_one", "belongs_to"],
  plural: ["has_many", "has_and_belongs_to_many"],
  classNameKeyword: "class_name",
}
```

The adapter turns each declaration into a fact the shared rules read, so
`@account.statuses.find(params[:id])` is a read against `Status`. The
class comes from `class_name:` when the call has one. Otherwise it comes
from the association's own name, run through the inflections
ActiveSupport ships. This pack does not read the project's
`config/initializers/inflections.rb`. The rails pack does, and when it
is in the same run the adapter checks the project's inflections before
the defaults. Without the rails pack, a word the project teaches Rails
to inflect differently gets the default inflection, the association
points at a class that nothing in the project declares, and nothing is
recorded for it.

Concerns are covered too. A `has_many` inside an `included do` belongs
to the module, and the module is in the ancestry of every model that
includes it.

## Statements the project wrote itself

A project that goes around the query builder still reaches the database.
The tables then come from the statement, with no model involved:

```ruby
ActiveRecord::Base.connection.execute(sql)   # write, against whatever sql updates
Account.connection.select_values(sql)        # read, the same connection from the model
Account.find_by_sql(["... WHERE id = ?", id]) # read, the statement at the head of the array
Account.count_by_sql("select count(*) ...")   # read, against the table in the count
```

Inside a model's own class method, a bare `connection` is a call on that
class. The pack matches it the same way it matches `Account.connection`,
by following what the class extends back to `ActiveRecord::Base`.

`?` is ActiveRecord's own placeholder for a bind value, and no database
reads it as SQL. The pack declares that, and the adapter gives the SQL
reader a parameter in its place. A statement the evaluator cannot settle
to a string reports nothing, and so does one no parser can read.

## Callbacks

A model registers its own methods for ActiveRecord to run around a
write. A body that writes through the model runs them without calling
them by name:

```ruby
class Order < ApplicationRecord
  before_save :normalize_reference
  after_commit :sync_search_index, on: :create
  after_destroy :drop_search_index
end

OrderService.new.place_order(ref)   # Order.create, then normalize_reference and sync_search_index
OrderService.new.cancel_order(id)   # Order.update, then normalize_reference alone
```

The pack declares which event each write triggers, and which call
registers a callback for which events. `on:` narrows one declaration.
Callbacks do not get a unit of their own. Each one is an invocation on
the body that did the write, so whatever the callback reaches ends up on
that body's summary too. A callback registered on `ApplicationRecord`
counts for every model below it, through the same ancestry the rest of
the pack matches on.

The bulk writers are left out, because ActiveRecord does not run
callbacks for `update_all`, `insert_all` or `delete_all`.

A callback written as a block, `after_commit do ... end`, has no method
name and is not read. Nothing in its body reaches any summary.

## What comes out

One `interaction` effect per chain, with `class: "storage-access"`. The
chain above counts as a single read, however many calls it makes. The effect goes on the
outermost call ActiveRecord defines, and that call decides whether it is
a read or a write. A method of your own called after it, as in
`Status.find(id)&.proper`, does not hide the read. The reach walk follows
that method and reports whatever its body does.

`selector` is what the chain selected rows by: the keywords of every read
along it, plus the primary key where a lookup by primary key was given
one. `fields` is the data a write was given. On a read, it is the columns
the call asked for by name:

```ruby
Account.find(params[:id])                     # read, selector id
Account.find_by(email: email)                 # read, selector email
Account.pluck(:name, :email)                  # read, fields name and email
Account.create(name: name, email: email)      # write, fields name and email
Account.where(id: id).update_all(state: 1)    # write, selector id, fields state
Account.create(attrs)                         # write, no fields
```

An argument passed as a variable does not list any column, so the last
line is a complete result. There is no gap in it.

When two files declare the same class name, the pack records nothing,
because picking one class would be a guess. It records nothing for the
same reason when the rules resolve a receiver to no class, or to two.

## License

Apache-2.0
