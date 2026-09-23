# How the Ruby adapter reads a project

`@suss/adapter-ruby` reads a Ruby project and writes a summary for each unit it discovers. The sections below describe how it decides what each unit does and where it stops reading. The [README](./README.md) explains what the package is for.

## What an action responds with

A controller action gets one branch for each path that sends a response. An action that renders `:created` in one arm of an `if` and `:unprocessable_entity` in the other reports both statuses, each under the condition that leads to it.

The pack lists the calls that send a response, in `responseStatusCalls` on the `controllerActions` pattern. Each entry gives the name of a call the library lets an action make with no receiver, and where that call takes its status: as a keyword, or at a positional index. When a call is written with both, the keyword wins. An entry can also give the status the call sends when the action writes none. That is how Rails' `redirect_to` reports 302 while `render` reports the controller default. `statusCodeNames` on the same pattern maps each status name the library accepts in place of a number to that number. For Rails this is Rack's symbol table. This package contains no call names and no status names of its own.

The walk passes every response call to the shared path engine as a terminal, and the statement containing the call ends its path, because Rails raises on a second render. So a response call after one that already ran is not reported. A path that reaches the end of the body, or ends in a bare `return`, is the implicit render.

Each branch records its own `statusCodeReading`, and the pattern's `defaultStatusCode` gives the library default. `assembleSummary` combines the two the same way it does for a status a Flask route returns in a tuple:

- When the call writes no status, the branch has no reading, and the summary reports the call's own default, or the pattern's default when the call has none.
- A status argument goes through the shared value evaluator. A number, a status name, and a local variable whose value settles on either one all give the same result.
- When a status argument does not settle on a number, as with `params[:code]` or a name the pack does not declare, the branch reports no status and gets one gap recording why. The other branches are unaffected.

A branch also lists the calls made on the way to it. `guardsHoldOn` from `@suss/extractor` works that out by comparing the conditions around each call with the conditions around the branch. The Python and TypeScript adapters use the same test.

## What runs around an action

A pack lists the class-level calls that run one of a controller's own methods ahead of its actions, in `filters` on the `controllerActions` pattern. Each entry gives the call's name and where the call takes the method: a leading symbol, or a `with:` keyword. It also records whether the library runs the method only after the action raised, which call removes the filter again, and which keywords limit it to some of the actions. In Rails those are `before_action`, `rescue_from`, `skip_before_action`, `only:` and `except:`. None of those words appear in this package.

The adapter reads filters from the class body and from the body of every ancestor, most distant first, because that is the order the library runs them in. The filter's method is looked up the way Ruby looks up any method. A filter declared and defined on a base class therefore applies to every controller that inherits it, and is read once, in the file where it is written.

Each filter method becomes a `middleware` unit with no boundary. A path through it that writes a response ends the request. Every other path passes the request on, and the unit records those paths as `delegate` branches. `composeWrappers` in `@suss/extractor` folds the unit into each action that uses the filter. The action then reports the filter's 401 under the filter's condition, and its own outcomes under the negation of that condition.

## The method behind a field

Most fields in a graphql-ruby schema get their value from a method. A summary should report that a field has no method behind it only when the adapter looked for one and found none.

graphql-ruby calls a field's method with `public_send`, so the method can be defined anywhere in the class's ancestry. `ancestry.ts` walks that chain. It finds each ancestor's file with the same convention that turns a constant into a path for a `mutation:` or `resolver:` reference. A plain field gets its value from a method of the same name somewhere along the chain. A wired field gets its value from the `resolve` method somewhere along the wired class's chain. graphql-ruby decides which method name a wired class uses, so the pack declares it in `resolverMethodName`. The pack also declares where a project's chain ends. `ancestryRootClassNames` lists the library's own root classes, and when the walk reaches one it has passed every class the project defined.

A bare superclass name is looked up the way Ruby does it: each level of the enclosing nesting, innermost first, then the top level. In `module Api; class UsersController < ApplicationController`, the superclass is `Api::ApplicationController` when any file, this one included, defines it, and `ApplicationController` otherwise. When no file defines any of the candidates, the chain keeps the bare name as an unread ancestor. A configured base class with no file of its own still matches by the name the project wrote.

A module passed to `include` or `prepend` is looked up the same way. Inside `module Admin; class ReportsController`, `include Pagination` tries `Admin::ReportsController::Pagination`, then `Admin::Pagination`, then `Pagination`, and takes the first one the run defines. A top-level concern is found from inside a namespaced class, and a module of the same name nested closer to the class takes precedence, as in Ruby. A `resolver:` or `mutation:` reference is looked up the same way. A module already in the chain the walk is building is skipped, because Ruby rejects a cyclic include.

The walk produces the same order Ruby does. Ruby builds a class's ancestors as each `include` runs. It works out the included module's own chain first and inserts that chain as a unit. It skips anything already among the ancestors, and it never moves a module that an earlier include or the superclass already placed. Two concerns that share a base give `[C, B, A, Base]`, with `Base` after both concerns. A base that the superclass already mixes in stays after the superclass. To match, the walk builds the superclass chain first and checks every later step against what is already there. It expands each sibling include separately, instead of descending into it with the set the siblings share. `include A, B` mixes in B before A, while `include A` followed by `include B` puts B first, so the walk reads the calls in source order and reads the arguments of a single call backwards.

The tests cover this. The order was also compared against `Module#ancestors` in a running Ruby process for these cases: a diamond, a three-way diamond, a diamond that crosses a superclass boundary, `prepend`, `include` with several arguments, a module included twice, and a nested module chain.

The same walk builds the declared contract, starting from the most distant ancestor, so a mutation picks up the `argument` declarations it inherits from a base mutation.

The summary then reports one of three things:

- When the walk finds a method, `bodyContent` comes from that method's body. Nothing in the body matches a pattern this pack looks for, so the extractor falls back to its own sentence saying the summary does not describe what the field does.
- When the walk reads the field's whole ancestry and does not find a method, `bodyContent` stays `"absent"` and the summary keeps its sentence saying the field has no body. That is correct for such a field, because the library gets its value by reading the attribute off the object the field was resolved against.
- When the walk stops early, `bodyContent` stays unset and the summary gets one sentence saying what stopped it. The walk stops at an ancestor whose file the naming convention cannot find, at a `define_method` call that defines the name being looked for, or at a wiring value that is not a constant path. `bodyContent` stays unset because the extractor writes its own sentence from that field, and any value would be a claim the adapter cannot back. The walk does not read `method_missing` either.

An ancestor the adapter could not open ends the search, even when a method further along would match. Ruby would call whatever that ancestor defines, so a method found past it is not known to be the one that runs. Reporting it would make a confident claim that may be wrong, where the adapter should say nothing.

A `define_method` call stops the search only for the names it defines. The adapter does not match the call's argument against fixed patterns. Instead it emits two facts as it walks a class body, and the lookup joins them:

```
definesMethodFrom  order.rb:0-120  order.rb:64-67
nameTurnsOn        order.rb:64-67  key  element  order.rb:30-52
```

`definesMethodFrom` records that the class defines a method whose name is whatever that expression evaluates to. `nameTurnsOn` records that a loop around the call binds `key` to each element of another expression. Both expressions then go through the value evaluator that also works out route paths. It follows names and constants across the whole run, so it gets the same answer whether the name is a literal symbol, a constant another file defines, a list a project method returns, or an interpolated symbol built from a loop's element.

The name the evaluator settles on goes back into the facts as `declaresName`. One shared rule adds it to `wantedDeclaredName` next to the names written with `def`. A caller asking which methods a class declares gets the dynamically defined ones too, with no special handling.

The adapter recognizes Ruby's own `each`, `each_with_index` and `map` as loops without a pack, the same way it recognizes `ENV`, because they belong to `Enumerable` and not to a library.

When only part of a name settles, as in `"category_#{filter}"` with nothing known about `filter`, the adapter keeps a pattern built from the literal parts. A lookup for a name that does not match any pattern continues up the ancestry. A lookup for a name that matches stops at the class, since the loop may be defining it. When a `define_method` name settles on nothing at all, such as a bare variable or a call nothing binds, the class stops every lookup.

The adapter still does not read what the method body does. That needs the path engine: statements to walk, a return value to turn into a type shape, and calls resolved against something that can tell what they return. Filling `RawCodeStructure.dependencyCalls` would not help, because nothing in summary assembly reads it. A field's location stays where the field is declared and does not move to a resolver method in another file, so the path and line numbers on a summary keep pointing at the same place.

The walk does not discover a `field` declared on a base object type on that type's subclasses. Doing so would change which units exist, where this walk only changes what each unit reports about itself, so it is left out on purpose and belongs to separate work.

## What a body lowers to

The adapter lowers a method body into the statement form that the shared path engine in `@suss/extractor` walks. The Python and TypeScript adapters use the same engine. The engine is generic over the type each language uses for a condition and never looks inside one, so enumerating the paths and negating an earlier arm happen once, in the engine, and are not written again here.

| Ruby | Lowers to |
| --- | --- |
| `if` / `elsif` / `else` | one `if` per test, with the elsif chain nested into the else arm |
| `unless` | the same `if`, with the two arms swapped, so a body that runs when the test fails is recorded that way |
| `render :gone if expired?` and the `unless` spelling of it | one `if` with a single arm, on whichever side of the test the modifier puts it |
| `while`, `until`, `for` | `loop` |
| a call with a `do` block, such as `items.each do \|i\|` | `loop`, because the block runs once per iteration |
| `begin` / `rescue` / `ensure` | `try` |
| `case` / `when` / `else` | `switch`, with `else` as the default group |
| `return`, `raise`, `break`, `next` | `exit` |
| anything else | `opaque` |

Three things differ from Python, and they are why Ruby has its own lowering instead of sharing one:

- **`raise` is an ordinary method call.** The adapter recognises a throw by the call's name, since there is no keyword node to match.
- **A `return` inside a `do` block returns from the method**, so the scan for returns goes into `do` blocks. A lambda keeps its own `return`, so the scan does not go into a lambda.
- **A method returns its last expression** without a `return`. Python has no equivalent.

### Keying anything on a node

tree-sitter hands back a fresh wrapper object every time a child is read, so two reads of one node are never `===` and a plain `Set` or `Map` keyed on a node matches nothing. Use `NodeSet` and `NodeMap`, which key on the node id. `npm run check:style` fails a build that keys either on a node.

### Asking the rules once for a file

Each question to `@suss/resolution` runs the rules over every fact the project emitted. A question costs about the same whether it covers one key or a thousand. Asking key by key runs the rules again for every key, and on a large Rails app that took almost the whole extraction time.

So code with many nodes to ask about asks about them together, through `askWrittenValues` in `values/evaluator.ts`. `discoverUnits` does this for the client patterns before it reads any call site. It asks one question covering every call receiver in the file, then one covering the URLs passed to the receivers that turned out to belong to the library. `storageEffects` and the environment reader batch the same way, one method at a time: one question for the receivers of every storage chain in a body, and one for every callee key in it. No check enforces this, because code that asks per site gets the same answer, only slower.

## Which scope a name belongs to

Ruby has no local declarations. Assigning a name anywhere in a method body makes it a local of that method, including inside an `if`, a `case`, a `begin` or a block, and the local is gone once the method returns. So a name fact is keyed on its scope instead of on its file:

| Where the name is written | Key |
| --- | --- |
| a method's parameter, or any name its body assigns | `<method node>#<name>` |
| a block's parameter | `<block node>#<name>` |
| a name assigned at the top of a file, and any constant | `<file>#<name>` |

Two methods in one file that both assign `query` have two separate names. Keying both on the file would give the rules one name with every value from both methods, and the rules refuse to settle a name like that. Only a name at the top level of a file is recorded as something another file can read.

When a name is written more than once, something has to decide which write a reader sees. The adapter collects the writes in source order and passes them to `@suss/resolution`, which makes that decision the same way for every language. `writesRunInOrder` works out whether the scope's own statements put the writes in order, using a description of Ruby's grammar that this adapter passes in. `valueLeftByWrites` then picks the value the name ends up with. A name written once gets `binds`. A reassigned name that the helper settles gets `endsHolding`, and one it cannot settle does not get either fact. These count as writes: plain assignment, `||=` and `&&=` (which write their whole right side), `+=` and the other compound operators (which write a value the source never states), a multiple assignment, a `for` variable, and a block parameter. A parameter counts as the first write of its name, which is why a parameter that the body assigns again settles on nothing.

## Finding the definition behind a constant

Ruby has no imports. A file calls `require` to load another file, and after that every constant either file defines can be reached by name. So the file a name comes from depends on where the constant is defined, and nothing at the reading site records it. The Python and TypeScript adapters emit `imports`; this one binds a reference directly to its definition.

The lookup follows Ruby's rule. A name written inside `module Types; class Wrapper` is tried as `Types::Wrapper::Order`, then `Types::Order`, then `Order`, and the first one that settles wins:

```ruby
module Types
  class Order; end
  class Wrapper
    def build
      Order      # Types::Order, not the top-level one
    end
  end
end
```

When two files define a name under the same nesting, the reference is not bound, because choosing between them would be a guess. A constant built at run time through `const_set` or `Object.const_get` is not bound either, since the adapter does not read those calls.

The adapter collects definitions per file and matches references afterwards, because it can only tell which file defines a constant once it has read every file.

A class that the ancestry walk reaches by name, with no reading site, is found through the naming convention instead. The constant is underscored into a path. The adapter looks for that path under the configured root, then under each directory directly beneath the root, and last under each `concerns` directory inside those. Rails autoloads from every directory under `app`, so `ApplicationController` is `app/controllers/application_controller.rb`. Rails also autoloads from `app/controllers/concerns` and `app/models/concerns`, so a concern written there as `module Auditable` is found by that bare name. When the root and a directory beneath it both have the file, the root's file wins. No other spelling is tried.

## What a class inherits

The adapter records a class's superclass in two facts. `extends` points at whatever the superclass name binds to, so the shared rules can find a method that a base class declares when it is called on a subclass that never overrode it. `extendsNamed` keeps the name as written, because a base class the project does not declare, like `ActiveRecord::Base`, has no node in the run to point at:

```ruby
class Order < ApplicationRecord
end
```

```
extends       order.rb:0-31  order.rb#ApplicationRecord
extendsNamed  order.rb:0-31  ApplicationRecord
```

A pack that matches a library base class reads `extendsNamed`, and follows `extends` to keep going up the chain.

A module mixed in with `include` or `prepend` appears in Ruby's `ancestors` list, so it goes in `extends` too, and every rule that walks an ancestry reaches what the module declares:

```ruby
# account.rb
class Account < ApplicationRecord
  include Account::Associations
end

# associations.rb
module Account::Associations
end
```

```
extends       account.rb:0-68  associations.rb:0-32
extends       account.rb:0-68  account.rb#ApplicationRecord
extendsNamed  account.rb:0-68  ApplicationRecord
```

The mixin goes only in `extends`. `extendsNamed` records the library base a class ends up at, and a module is never one. Putting a mixin there would give the class a second base for a pack to match. The facts come from the same two calls that the syntactic ancestry walk in `ancestry.ts` reads, so both agree on which constant is mixed in, down to the order of `include A, B`.

## A block that runs as part of the body

Ruby itself has no call whose block runs as part of the surrounding class or module body. Libraries define such calls, so a pack lists its library's calls in `bodyBlocks`:

```ts
bodyBlocks: [
  { name: "included", moduleOnly: true },
  { name: "class_methods", moduleOnly: true, definesClassMethods: true },
  { name: "with_options" },
]
```

The adapter reads a declared block's statements as if they were written in the body around it, so a method or a value inside the block belongs to the class or module and is not lost with the block. `moduleOnly` stops a call that the library only offers to modules from matching the same name in a class body. `definesClassMethods` marks that a `def` in the block defines a method on the class itself. The lookup then finds it where it looks for `def self.name`, and never as an instance method.

When no pack in the run declares any of these, every block is read as an ordinary block. The keywords such a call passes down to the calls inside its block are not read.

## What a body calls out to

A pack lists, in `clients`, the constant that its library's request calls are made on. Each entry gives the constant as a project writes it, the method names and the request method each one sends, and where the URL is written. It also lists the builder methods that return a value accepting the same calls, and the keyword a builder takes its base URL under.

The adapter walks every method in a file for those calls. A call on the constant itself is read directly. A call on a local name is read when the same method body assigned that name from one of the library's builders. That is the same one-hop limit the other readers here have. The URL argument goes through the value evaluator and `pathOf` from `@suss/values`, as a Rails route path does, so an interpolated string gives the path it spells out, with the builder's base URL in front.

For a library that sends a request object built separately, the pack fills in `requestObject`: the method that sends the request, each request class with the request method it sends, and where the class takes its URL. The adapter reads a request built inside the call and one assigned to a name in the same method.

A library that takes a URL object in place of a string needs nothing extra from the pack. `URI("...")` and `URI.parse("...")` are part of Ruby, so they have rows in the value tables next to `File.join`, and every reader of a path looks through them. A URL passed in whole evaluates to a path with no text of its own. That path does not match any route and stays unbound.

The enclosing method becomes a `client` unit bound to that request method and path. A method that makes two calls is a client of both. A call written outside any method produces nothing, and neither does a call whose URL does not settle on a string.

The pack also lists which members of the response give the status, the success flag and the body. Those names go on the summary. The method's body is walked the way an action's body is, so a test on one of those members becomes a path whose condition records which member it read. `suss check` then reports a caller that handles a status the other side never sends.

## What a condition tests

The adapter records what a condition tests instead of only its source text. A comparison keeps its two sides and its operator. `nil?` becomes a null check, a member read becomes a truthiness check, `!` becomes a negation, and `&&` and `||` become compound conditions. A member read is recorded as the name it starts from plus the members read off it, so `response.status` is `response` and `["status"]`. A reader can then ask which member a test read. Ruby's own conversions are looked through, so `response.code.to_i` is the same member as `response.code`. Anything not modelled here stays opaque, with its source text.

## What a body does with the database

Ruby code declares no return types, so the adapter cannot do what the Python adapter does and read the return type a method declares. Instead a pack lists the base class the library provides for models:

```ts
storage: [
  {
    baseClasses: ["ActiveRecord::Base"],
    writes: ["update", "destroy", "save", "create", "delete_all"],
    reads: ["find", "find_by", "where", "first", "pluck", "count"],
    givesBack: ["find", "where", "first"],
    byPrimaryKey: { methods: ["find", "update", "destroy"], column: "id" },
    columnArguments: ["select", "pluck", "pick"],
    associations: {
      singular: ["has_one", "belongs_to"],
      plural: ["has_many", "has_and_belongs_to_many"],
      classNameKeyword: "class_name",
    },
    storageSystem: "postgresql",
  },
]
```

One rule covers every call. A call is database work when `reads` or `writes` lists its method, the class behind its receiver has one of those base classes in its ancestry, and the project does not declare that method itself. Rails puts its own class between the library and every model. Following `extends` through the project and matching `extendsNamed` at the library handles that:

```ruby
class ApplicationRecord < ActiveRecord::Base; end
class Order < ApplicationRecord; end

Order.where(id: 1).first   # one read, against Order, picking rows by id
Order.new(name: name)      # nothing: a constructor asks the database for nothing
Order.transaction { ... }  # nothing: the calls inside it are the database work
Order.recent_for(account)  # nothing: the walk steps into the project's own method
```

A chain is one operation, so the first of those examples counts once, at the outermost call the library defines. That call decides whether the chain is a read or a write. Anything written after it is a method called on the result, and the walk follows it:

```ruby
Order.find(params[:id])&.summary   # one read, against Order, picking by id
Order.where(a: 1).first.name       # one read, against Order, picking by a
```

The constant can be written any way Ruby allows: `Order`, `Shop::Order`, or `::Order` for the top-level class from inside a module that has its own `Order`. The binding facts decide which class each spelling refers to.

When the receiver is something other than a constant, the rules work out its class, and the same rule then applies:

```ruby
def set_order
  @order = Order.find(params[:id])
end

def suspend
  @order.update!(suspended_at: Time.now)   # one write, against Order
  @order.reference                         # nothing: not a method the pack lists
end
```

The receiver is keyed the same way `calleeSpellings` keys it for the walk, and `wantedObjectOf` returns its class. The call counts only when exactly one class comes back, since picking between two would be a guess. `container` is the name the class is declared under, which `rbConstantName` adds to the facts next to the bindings. An association leads to the model it targets, so `@account.statuses.find(params[:id])` is a read against `Status`.

A call to a method the project defines itself is skipped. `wantedDeclaredName` lists the methods the class's ancestry declares, the reach walk steps into that method's body, and the body reports its own database work. A module mixed in with `include` is part of that ancestry, so a `def save` in a concern is stepped into and not recorded here as a write. The facts do not bind a block parameter, so `orders.each { |o| o.save }` records nothing.

## A statement the project wrote itself

A model call shows what it touches in the call. A SQL statement shows it in its text, so the adapter passes the text to `@suss/sql`, and the parse gives the tables, the columns, and what the statement picks rows by. A pack declares the library that runs the statement:

```ts
rawSql: [
  {
    constantName: "PG",
    clientBuilders: ["connect"],
    statements: { exec: { at: 0 }, prepare: { at: 1 } },
    storageSystem: "postgresql",
    dialect: "postgresql",
  },
]
```

Ruby code declares no types, so the adapter works out the receiver by following it back to the call that produced it. The chain starts at `constantName`, a call in `clientBuilders` returns a client, and `writtenNodeOf` follows each step. A connection stored in a local, in an instance variable or behind a method all give the same result:

```ruby
conn = PG.connect(ENV["DATABASE_URL"])
conn.exec("SELECT id, name FROM accounts WHERE tier = $1")  # read, picking by tier
conn.exec("BEGIN")                                          # nothing: no table
other.exec("SELECT id FROM accounts")                       # nothing: PG never gave `other` out
```

The statement goes through the value evaluator first, so a statement built by interpolation, or stored in a constant another file defines, reads the same as one written at the call. Any part the evaluator cannot settle becomes a parameter, standing where the interpolated value would appear in the statement sent to the database:

```ruby
conn.exec("SELECT name FROM accounts WHERE id = #{id}")   # read, picking by id
conn.exec("SELECT id FROM #{params[:table]}")             # nothing: no table settled
```

Some libraries select part of the store before the statement is sent, and some reach rows with no statement at all. `addressing` declares the calls in the middle of such a chain, and `rowCalls` declares the calls at the end:

```ts
addressing: { dataset: { says: "scope", at: 0 }, table: { says: "container", at: 0 } },
rowCalls: { insert: { kind: "write" }, data: { kind: "read" } },
```

```ruby
bigquery.dataset("core").query("SELECT id FROM accounts")   # read of accounts in core
bigquery.dataset("core").table("accounts").insert(rows)     # write to accounts in core
bigquery.dataset("core").insert("accounts", rows)           # the same write
```

A row call can take the container as an argument, which is how the last example gives its table. Declare that argument's position in `container`. When the argument does not settle on a string, the container from the chain is used, so both spellings of `insert` come from one declaration.

`@suss/sql` splits a table written with namespaces in front of it, such as BigQuery's `project.dataset.table`, and the namespace nearest the table becomes the scope. A table name passed to a call goes through `splitQualifiedTable` for the same split, so a call and a statement give the same result. A table written with no namespace belongs to whatever the chain addressed, and to `scope` when the chain addressed nothing.

Some libraries, ActiveRecord among them, give out the same client from every subclass of their base class. `baseClasses` declares those bases. The chain can then start at any class whose ancestry includes one of them, or with no receiver at all when the call is written inside such a class:

```ruby
ActiveRecord::Base.connection.execute(sql)   # the constant itself
Account.connection.select_values(sql)        # a model two classes below the base
connection.select_values(sql)                # a bare call inside that model's own class method
```

The ancestry comes from the same rules the model recognizer uses, in `baseClass.ts`, so both readers settle a class the same way.

A model can also take a statement, through `find_by_sql` and `count_by_sql`. `statements` on a storage pattern declares those methods. The tables then come from the statement and not from the model's own container. The first argument can be the statement, or an array whose first element is the statement, because that is how the library takes bind values with it.

A library with its own bind placeholder produces statements no SQL dialect parses. `bindPlaceholder` declares the token, such as ActiveRecord's `?`. The adapter splits the statement at each one, so the parser sees a parameter where the value would go.

## What a read picked and what a write set

`selector` lists what the chain picks rows by. It has the keywords of every read along the chain, whether written bare or inside braces, plus the primary key when a method in `byPrimaryKey` gets a positional argument. On a write, `fields` lists what the write was given as data. On a read, it lists only the columns the call asked for by name:

```ruby
Order.find(params[:id])                      # read, selector id
Order.find_by(email: email)                  # read, selector email
Order.where(a: 1).order(:b).first            # read, selector a
Order.pluck(:name, :email)                   # read, fields name and email
Order.create(name: name, email: email)       # write, fields name and email
Order.where(id: id).update_all(state: 1)     # write, selector id, fields state
Order.create(attrs)                          # write, no fields
```

An argument written as a variable or as `params` does not give a column. The last line is the complete result and does not get a gap, since the adapter does not guess at what a variable was set to.

Some libraries batch reads for the caller, and the model then appears as an argument instead of on the receiver. graphql-ruby's dataloader is one. A resolver writes `dataloader.with(Sources::Record, ::User).load(id)`, or the shorter `dataload_record(::User, id)`, and the model is `::User`. A pack for such a library declares the calls in `loaders`. Every constant argument of the picking call whose ancestry reaches a storage base counts as a read of that model. The source class passed with it does not reach such a base and drops out, so the pack does not have to say which argument position has the model. This needs a storage pattern in the same run. The graphql-ruby pack records nothing on its own, and one read per model once the activerecord pack is loaded as well. The reach walk cannot follow a call on the loader's result and would report it as an unsettled value. A call the storage recognizer records is not reported as a gap, because the summary already describes what it does. `dataload_association(record, :name)` is left out, because the model behind an association is declared on another class, which nothing here reads yet.

The read itself happens in the source class and not at the call. When a pack declares where `pick` takes the source and which method the library runs on it, the walk steps into that method. `resolveCallee` resolves the call to that method the way it resolves any other callee. The source class gets no unit of its own, and whatever its `fetch` reaches is reported on every field that loads through it.

## The methods a write runs on its own

A model registers methods for the library to run around a write, so a body that writes through the model runs them without calling them by name. `callbacks` on a storage pattern declares which event each write method fires, which class-body call registers a callback for which events, and the keyword that limits one registration to fewer events.

The adapter reads the registrations once per class body into `classCallback(class, event, method)`. `wantedCallbackMethod` in `@suss/resolution` joins that fact to the ancestry and to the `def` behind the name. A callback registered on a base class therefore counts for every class below it. It follows the ancestry chain the base names already come from, with no walk of its own.

A write then reports one invocation for each callback the class registers for that write's event. The reach walk gets the same methods, so each one gets a summary and the write links to it. A read reports no callbacks, and neither does a write method the pack left out of the table.

A callback written as a block is not reported. The block has no method name, and the adapter has no way yet to give a block body a summary for the write to link to.

## What a finder gives back

A pack also lists the library methods that return an instance of the model, in `givesBack` on the same storage pattern. For ActiveRecord that is `find`, `first`, `create` and the others that return a record, plus `where`, `order`, `limit` and the others that return a relation. This list differs from `reads`. `new` and `build` return a record without querying the database, and `update_all` runs a query and returns a count. While the run is read, every method in `givesBack` is paired with every base class the pattern lists and added to the facts as `givesBackOne(base, method)`:

```
givesBackOne  ActiveRecord::Base  find
givesBackOne  ActiveRecord::Base  where
```

The shared rules use that fact. `Account.find(params[:id])` resolves to `Account`, so a method called on the result runs the one `Account` declares. A `before_action` that assigns `@account` reaches the action the same way any other instance variable does. A chain is resolved one method at a time, so `Account.where(x).first` resolves to `Account` twice. `Account.first` has no arguments, but the value facts still record it as a call, so the shared rule covers both spellings.

The storage recognizer asks the same rules about a receiver that is not written as a constant. That is how `@account.update(attrs)` after that `before_action` is recorded as a write against `Account`.

## What an association reaches

`associations` on the same storage pattern lists the class-body calls that declare an association from one model to another. The list is split by whether the association name is written in the singular or the plural. Each such call the adapter reads in a class or module body becomes one fact:

```
declaresAssociation  app/models/account.rb:0-812  statuses  app/models/account.rb:0-812#association:statuses
```

The third column is a constant reference the adapter constructs, because the target class is usually not written anywhere. Rails derives it from the association's name: `has_many :statuses` reaches `Status`, singularised and camelised with the inflections ActiveSupport ships. `class_name: "Status"` on the call gives the name explicitly. When a call has a `class_name` the adapter cannot read as a plain string, the call declares nothing, because a name derived from the association would be wrong.

A project can add words to its inflector. Where and how it does that depends on the library, so the pack reads them and declares the result in `inflections`: acronyms, irregular plurals, uncountable words, and singularisation rules. Each is a plain word or a pattern with nothing library-specific left in it. They are searched before the defaults, the same way ActiveSupport searches its newest rule first. `has_many :kine` reaches `Cow` in a project that declared that inflection, and reaches nothing in a project that did not. An acronym stays whole in the constant name, so `has_many :api_tokens` reaches `APIToken` and not `ApiToken`.

The reference is looked up from the nesting of the declaring class, like every other constant reference, so `has_many :statuses` inside `Admin::Account` tries `Admin::Status` before `Status`. The shared rules handle the rest. A read of `statuses` on an Account resolves to the Status class, and `find` on that result resolves the same way `Account.where(x).first` does.

A concern needs nothing extra. The mixed-in module is in the `extends` ancestry, and statements inside a block a pack declared are read as the module's own. So `has_many :statuses` written in a concern is an association of every class that includes it.

The facts do not record whether an association is a collection. `@account.statuses` and `@account.profile` both resolve to the class, as `Account.where(x)` and `Account.find(x)` already do.

## What a file reads from the environment

`ENV` is part of the language core, so the adapter recognizes reads of it without a pack. Each read becomes the same `config-read` interaction the TypeScript adapter emits for `process.env.X`, on the `runtime-config` binding. It is written `ENV["X"]` however the source spelled it. The runtime-config checker pairs those reads with what a template declares for the process the file runs in.

| Ruby | Recognized as | Defaulted |
| --- | --- | --- |
| `ENV["X"]`, `ENV['X']`, `::ENV["X"]` | a read of `X` | no |
| `ENV.fetch("X")` | a read of `X` | no |
| `ENV.fetch("X", "d")`, `ENV.fetch("X", nil)` | a read of `X` | yes |
| `ENV.fetch("X") { "d" }`, `ENV.fetch("X") do ... end` | a read of `X` | yes |
| any of these followed by `\|\|` (`ENV["X"] \|\| "d"`) | a read of `X` | yes |
| `use(ENV["X"]) if ENV["X"]`, `return fallback unless ENV["X"]` and the reads after it, `ENV.fetch("X") if ENV.key?("X")` | a read of `X` | yes: used only where a test passed |
| `x = ENV["X"]` in a method, then `x` used only inside `if x` or after `return if x.nil?` | a read of `X` | yes |
| `x = ENV["X"]`, then `x` used both inside and outside `if x` | a read of `X` | no |
| `if ENV.fetch("X")`, or `x = ENV.fetch("X")` then `if x` | a read of `X` | no: `fetch` raises before the test runs |
| `raise "..." unless ENV["X"]`, or `return x if x` then `raise "..."` | a read of `X` | no: a missing value ends in a raise |
| `Settings.setting("X")`, where the method reads `ENV[key]` or `ENV.fetch(key)` | a read of `X` at the call | whatever the read inside the method says, or yes when an `\|\|` follows the call |
| `GET.call("X")`, where `GET` is a lambda reading `ENV.fetch(key)` | nothing: the callee is a value, not a method | |
| `ENV[name]`, `ENV.fetch("#{prefix}_X")`, `ENV[:X]` | nothing: the name is not a string literal, and no caller supplies one | |
| `ENV["X"] = "1"`, `ENV.key?("X")`, `Settings::ENV["X"]` | nothing: a write, a membership test, or another constant | |
| `other \|\| ENV["X"]` | `X` not defaulted, since it is the chain's last resort | |

A read inside a method that a pack discovers, such as a resolver method behind a GraphQL field, goes on that unit's summary. A read in the file body, in a class or module body, or in a block at those levels runs when the file loads. It goes on a `module-init` summary named after the file, and each file with such a read gets one. A read inside a method no pack discovers, or inside a lambda, is not reported, because the adapter has no way to know when it runs.

### A name handed to a project helper

When a service reads its environment through a helper method of its own, the variable's name is written at the call to the helper and never next to `ENV`. The value facts record `readsKeyed(site, o, x)` for every read whose key comes from an expression, off any container at all. The adapter records `environmentObject(w)` for every expression that spells `ENV` and passes it somewhere. The rules in `@suss/resolution` join the two and work out which parameters end up naming a variable, following a name passed on from one helper to the next.

The adapter asks that question once for the whole run, starting from the environment objects instead of from the read sites or the parameters. A project writes `ENV` in a handful of places and has thousands of callee parameters, so starting from the parameters would take a question per parameter. Starting from the objects returns every such parameter, in any method, however many helpers deep. It also finds a read written off some other name, since `make_reader(ENV)` returning `->(name) { env.fetch(name) }` never writes `ENV` next to the read.

At each call, the adapter looks up the callee's parameters in that one answer and reads the argument for each match. It tries the string literal first, then the value evaluator, so a constant in the caller's file resolves too. The read is reported in the unit where the call is written, so a helper called from two files gives each file its own read. When one call reaches the same name at two sites, that is one read. It counts as defaulted only when every site supplies a fallback, or when an `||` follows the call.

A lambda is read the same way as a method. After `GET = ->(key) { ENV.fetch(key) }`, both `GET.call("X")` and `GET.("X")` read `X`. A lambda gets `func`, `paramOf` and `returnsValue` facts like a method does, and a call written either way runs whatever the receiver evaluates to, instead of a method named `call`. A lambda returned by a method, as in `GET = make_reader`, is read too. The adapter asks what the callee returns as well as what it evaluates to, and one rule states that a call on a name a factory assigned runs the function the factory returned.

A helper passed `ENV` itself is read too. That covers `make_reader(ENV)` returning `->(name) { env.fetch(name) }`, the same object passed through several calls, and a constant assigned `ENV`. The argument has to evaluate to `ENV`; a plain hash reads nothing. A lambda sees the locals of the scope it is written in, which is how it reaches the parameter passed to its factory.

The adapter does not read a name the helper builds instead of using whole, such as `ENV["#{prefix}_URL"]`. It also does not read a name the helper takes off a hash or an options object instead of as a parameter, or a proc written as `lambda { |k| ... }` or `proc { |k| ... }` instead of with `->`.

## What a file depends on in the project

Every summary has `metadata.moduleImports`: the project files this file depends on, relative to the workspace root and sorted. Ruby has no import statement, so the list comes from two sources. One is a `require_relative` whose target is a file in the run. The other is a constant the file references that another file in the run defines, so `Settings::REGION` adds the file that defines `Settings`. A plain `require` is not followed, because where it loads from depends on the load path at run time. A file that depends on nothing in the project gets an empty list, and the field is still present. So for a Lambda handler that only requires gems, the checker can still see that its closure is the handler file alone.

## What a field's resolver reaches

A field's resolver method calls project methods, and those call others. Each method the field reaches this way gets its own summary, of kind `library`, bound as `function-call` with `transport: "in-process"` and `recognition: "reachable"`. That summary lists the calls, environment reads and database work in the method's own body. Each invocation effect on a field or a reached method records, in `summary`, which summary the call lands on. A reader answering "what does this field reach" follows `summary` from one unit to the next and never has to match names.

The walk starts at the resolver method behind every discovered field, found as described under [The method behind a field](#the-method-behind-a-field). It adds a `calls` fact for each call it can follow in a body, until the set stops growing. A method that two actions both reach gets one summary. A call the walk cannot follow is recorded once per callee, on the summary of the body it is in, as an `unfollowedCall` gap giving the reason. There is no gap when no reader could have done better: a call into a gem, a call through a parameter that some caller passes a method by name into, or a call with no declaration the adapter could find.

A call with a receiver is resolved in two steps. First, the rules in `@suss/resolution` work out what the receiver is, from the value facts that `facts/values.ts` emits. A reassigned local, a name aliased through two more, `Klass.new`, a method that returns `self`, and parentheses are all steps those facts record, and asking `objectOf` about the receiver returns the class the value is an instance of. Second, `ancestry.ts` decides which method of that class runs. That follows Ruby's own lookup: `include` and `prepend` put modules into the lookup order at load time, a subclass overrides what its base declares, and `def self.` methods are looked up in a separate place again. A receiver written as a constant refers to the class object itself, so `Klass.build` looks for `def self.build` and `Klass.new` runs the class's own `initialize`.

Ruby has no separate syntax for a property read. `config.host` and `c.run` parse the same way, so whether an expression is a method call or a property read depends on what its receiver evaluates to. A call with no arguments is a method call when the rules settle its receiver on a function or an object this run defines. From there it is resolved like any other call, with the same stops and the same gaps. When the receiver settles on anything else, such as a value a dependency built, a caller's parameter, or a name nothing in the run declares, the call is a property read and produces no invocation and no gap.

The effect list records what the walk did. A unit's list is written while its body is read, before anything has decided which kind each expression is. So every call with no arguments goes on the list, and the walk later removes the ones that did not reach a project method. Each one left links to the summary of what it reached, the same way a call with arguments does. A unit whose list ends up empty reports that its body went unread, which is correct for a resolver whose only statement was `object.name`.

A call with no arguments does not replace the call it is written on, the way a call with arguments does. `Filter.new(scope).results` runs the class's `initialize` and then its `results`, so both are reported, each linked to its own summary. `Order.where(id: 1).limit(10).first` is unchanged, since nothing settles what `first` runs on.

An instance variable belongs to the object and not to any one method, so the adapter treats it as a property of the class. An assignment to `@scope` anywhere in the class body records its value on the class under `@scope`, and every read of `@scope` is a property read off that class. A Rails controller sets one in a `before_action` and reads it in the action. Those are two different bodies, so a key local to one method would never join them. `contains` already walks `extends`, so a write in a base controller reaches a read in a subclass with no extra step, and a module the class `include`s is on that path too. Nothing orders two methods against each other, so several writes that disagree leave several values, and a reader that needs one answer sees more than one source. A write that narrows the value, such as `@scope = @scope.where(a: 1)`, is set aside the same way it is for a local.

A call with no receiver, or with `self` as the receiver, does not go to the rules. Ruby looks that name up in the enclosing class's ancestry, then among the methods the project defines outside any class, which Ruby mixes into every object as private methods. The adapter follows the same order.

A bare name with no receiver, no arguments and no parentheses is one of these calls. `visible_items` on its own parses as an identifier, the same node a local variable read produces, so `bareCalls.ts` tells the two apart the way Ruby does. A name the method binds is a local variable, and every other identifier read is a call on self. A parameter, an assignment, a block or lambda parameter, a `for` variable, or a `rescue => err` clause binds a name. Binding is over-approximated on purpose: a name assigned anywhere in the method counts as a local, even when the assignment comes after the read. When the adapter is wrong, it misses a call instead of inventing one. An identifier that spells a name instead of reading a value, like a method's own name or the left side of an assignment, is left alone. So is an identifier used as another call's receiver, since in `orders.first` there is no way to resolve what `first` runs on.

The value facts read a bare name the same way, using the same table. `handler = build_index` records a `call`, and `handler` evaluates to what `build_index` returns, not to the method itself. Every `a.b` records a `call` too, with the method name as the callee and a `readsProperty` on it, whether or not arguments follow, because Ruby cannot refer to a method by name without running it. That lets the shared rules work out what `Faraday.new` and `Account.first` evaluate to, with no step of the adapter's own for each.

A pack can also list the receiverless calls its library defines, in `inheritedMethodNames` on the `controllerActions` pattern. A call to one of those names is left off the effect list and out of the reach walk. The effect list shows what a body reaches in the project, and nothing in the project defines those methods. The list applies to every body the run reads and not only to discovered actions, because the reach walk reaches methods that no pattern discovered. A call with a receiver keeps its effect, so `page.render(json: 1)` is recorded even when a pack declared `render`. This package contains no such names; `@suss/framework-rails` supplies the list for Rails.

| Written as | Followed to |
| --- | --- |
| `helper`, `helper(x)` or `self.helper(x)`, called in a method | that method in the enclosing class's own ancestry |
| `helper`, when nothing in the enclosing ancestry defines it | `def helper` written outside any class, project-wide |
| `Service.new.method` | `method` in `Service`'s own ancestry |
| `s = Service.new` then `s.method`, however many names apart | `method` in `Service`'s own ancestry |
| `s = Service.new` then `s = s.only(1)`, where `only` returns `self` | `only`, then `method` on the next call in the chain |
| `s = Service.new` then `s.method`, written with no arguments at all | `method` in `Service`'s own ancestry |
| `Service.new`, where `Service` declares `initialize` | that `initialize` |
| `@scope = Service.new` in one method, `@scope.method` in another | `method` in `Service`'s own ancestry |
| `@scope = Service.new` in a base class, `@scope.method` in a subclass | `method` in `Service`'s own ancestry |
| `Service.method` | `def self.method` written in `Service`'s own body |
| `Service.new(x)` | `initialize` in `Service`'s own ancestry |
| `register(method(:build_index))`, where `register(handler)` calls `handler.call` or `handler.()` | `build_index`, followed from wherever a caller in the run named it, through the parameter `register`'s own body calls |

A method passed by name into a call is followed one hop further than the call itself. `method(:build_index)`, written bare with no receiver, is how Ruby refers to a method without calling it. Only that bare form is followed; `self.method(:build_index)`, with an explicit receiver, is not. The same reference works as an `&`-prefixed block argument, `register(&method(:build_index))`. It is numbered by its position among the call's arguments like any other argument, so `&method(...)` takes whatever slot it is written in. The receiving method's own `&blk` parameter is counted at its declared position among that method's parameters, so the two line up with no separate rule for the block slot.

`handler.call`, with or without parentheses, and the `handler.()` shorthand both invoke the `Proc` or `Method` a parameter is bound to, and both are recognized. A plain block passed with `do...end` or `{ }` is not recognized, and neither is `yield`. A resolver that only ever receives its block that way still gets `unboundParameter` on the call, with no join to fill it.

The walk stops in these cases, with this reason in the gap:

| Written as | Reason |
| --- | --- |
| `obj.send(:method)`, `public_send`, `__send__` | a dynamic send this run does not follow |
| a method the project writes with `define_method`, called on `self` or on a name the rules settled on the class | defined with `define_method`, a body this reader cannot see |
| a name no `define_method` in the class defines, where every `define_method` there was read | looked for further up the ancestry, as if the class wrote none |
| a bare name two files each define at the top level | more than one possible source |
| a local two branches write differently | more than one possible source |
| an instance variable two methods build from different classes | more than one possible source |
| `Rails.cache.delete`, a call into a class this run does not define | outside the run (no gap) |
| `user.orders`, where nothing in the run says what `user` is | no declaration this run could find (no gap) |
| `config.host`, written with no arguments, where the rules settle nothing about `config` | a property read (nothing at all) |
| `entity.name`, where `Entity` gets `name` from `attr_reader` | no declaration this run could find (no gap) |
| a call on what another call gave back, where no fact says what that was | the value could not be settled |
| `handler.call` or `handler.()`, where `handler` is a parameter that some caller in the run passes a method by name into | followed through the join above (no gap) |
| `handler.call` or `handler.()`, where `handler` is a parameter that no caller in the run passes a method by name into | the caller supplies it, and nothing named what it passed |
| `service_class.new.method` where `service_class` is not a constant | the value could not be settled |

The walk does not yet follow a method found only on a superclass past an unread ancestor, a callable read out of a variable, the body of a block passed to `define_method`, or `yield`.
