---
title: Changelog
description: What changed in each suss release, newest first.
---

# Changelog

One section per release, newest first.

## 0.33.0 (2026-09-20)

0.33.0 reads a large project in a fraction of the time 0.32.0 took, follows the work a file does when it loads, and reads the SQL a service writes by hand.

### Breaking changes

An intent document with an unknown key no longer loads. The document, its transitions and its scenarios are checked strictly now, the way the boundary block already was, so a document that said `scenario:` instead of `scenarios:` stops the run and says which key it did not recognise instead of checking nothing and passing. ([#1108](https://github.com/nimbuscloud-ai/suss/pull/1108), [#1109](https://github.com/nimbuscloud-ai/suss/pull/1109))

A transition lists each effect once, with a `count` saying how many sites produced it, where it used to repeat the effect once per site. ([#1141](https://github.com/nimbuscloud-ai/suss/pull/1141))

`deploymentTarget` and `instanceName` on a runtime-config binding are left off unless a run configured one; every read the node pack emitted used to say `lambda`. A summary written by 0.32.0 still validates. ([#1129](https://github.com/nimbuscloud-ai/suss/pull/1129))

A Terraform value nobody settled is spelled `{var.image}` in the `image`, `runtime` and `entryPoint` fields, the way every other field already wrote it. ([#1127](https://github.com/nimbuscloud-ai/suss/pull/1127))

### Reading a project takes a fraction of the time

Zulip's `zerver/` directory, 1,676 Python files, took 624 seconds to read with 0.32.0 and takes 14 with 0.33.0. Mastodon's `app/` directory, 1,254 Ruby files, went from 8.9 seconds to 5.1. In TypeScript, directus's `api/` went from 372 seconds to 90, twenty-front from 231 to 115, and saleor-dashboard from 57 to 46, each the median of three alternating runs of the published 0.32.0 CLI against this release. twenty-server went the other way, from 44 seconds to 53, because the node pack's new environment questions pull more files into the reachable closure on that corpus than the engine work saved; that is the next thing on the performance list.

The rule engine keeps a relation's facts in a trie over their parts, so checking whether a fact is already known is one map lookup per column instead of building and hashing a string. The Python and Ruby adapters ask the rules once per file instead of once per call site. Reading where a value was written goes through the engine's index instead of scanning every row. And the TypeScript adapter checks whether a module key is a path before asking ts-morph for it, since a bare package name made ts-morph compare path segments against every source file and find nothing. ([#1137](https://github.com/nimbuscloud-ai/suss/pull/1137), [#1143](https://github.com/nimbuscloud-ai/suss/pull/1143), [#1144](https://github.com/nimbuscloud-ai/suss/pull/1144), [#1145](https://github.com/nimbuscloud-ai/suss/pull/1145), [#1147](https://github.com/nimbuscloud-ai/suss/pull/1147))

### A job with no handler is read from the top of its file

A script a scheduler or a container runs does its work at module scope, calling the functions it defines, and none of those calls used to be followed. Module scope is now a root of the reachable closure in all three languages, so `suss ask "what does jobs/sync.py reach"` lists the table reads and writes those calls make, and the file's `module-init` summary lists the calls. ([#1130](https://github.com/nimbuscloud-ai/suss/pull/1130), [#1132](https://github.com/nimbuscloud-ai/suss/pull/1132), [#1138](https://github.com/nimbuscloud-ai/suss/pull/1138))

### SQL a service writes itself is read as table access

New packs read node-postgres and BigQuery in TypeScript (`-f pg`, `-f bigquery`), the BigQuery client and the Airflow BigQuery hook in Python (`-f bigquery-python`), and the pg gem and google-cloud-bigquery in Ruby (`-f pg-ruby`, `-f bigquery-ruby`). A table kept in a module constant is followed to the string, and a BigQuery `project.dataset.table` name lands as a scope and a container, so it pairs with a Terraform BigQuery table. ([#1113](https://github.com/nimbuscloud-ai/suss/pull/1113), [#1115](https://github.com/nimbuscloud-ai/suss/pull/1115), [#1119](https://github.com/nimbuscloud-ai/suss/pull/1119))

ActiveRecord's own ways of running a statement are read too: `connection.execute`, `exec_query`, `select_values`, `find_by_sql` and `count_by_sql`. ([#1125](https://github.com/nimbuscloud-ai/suss/pull/1125))

The SQL reader covers a parameter with a cast, a select that locks its rows, a `WITH` clause in front of an insert or a delete, a derived table in `FROM`, `INSERT ... SELECT`, `UPDATE ... FROM`, set operations, and what `RETURNING` and `ON CONFLICT` touch. ([#1124](https://github.com/nimbuscloud-ai/suss/pull/1124), [#1134](https://github.com/nimbuscloud-ai/suss/pull/1134))

### Terraform declares what it deploys

An `aws_lambda_function`, an `aws_ecs_task_definition` container, a Cloud Run service or job and a Cloud Functions function each become the runtime-config boundary the CloudFormation reader already wrote for a Lambda. The reader expands a `dynamic "env"` block over a map, follows a `module` block into the local directory it points at, and takes `--code-scope api/web=services/api` so a container has code to pair against. Fourteen more resources are read, among them RDS, Kinesis, Firehose, CloudWatch, BigQuery, Cloud SQL, Spanner, Firestore, Bigtable and Pub/Sub, and a store whose engine is a variable with no default is reported with no engine instead of dropped. ([#1114](https://github.com/nimbuscloud-ai/suss/pull/1114), [#1116](https://github.com/nimbuscloud-ai/suss/pull/1116), [#1127](https://github.com/nimbuscloud-ai/suss/pull/1127), [#1136](https://github.com/nimbuscloud-ai/suss/pull/1136))

### Environment variables read through a schema or a factory are reported by name

A service that hands `process.env` to a zod, valibot, envalid, znv or t3 env schema used to be reported as one read of the environment object and no names. The node pack now reads the schema's keys, says which have a default, and finds the parse through its callers when the environment arrives as a parameter from another file. A helper a factory returned is followed in all three languages, so `requireEnv("TABLE_NAME")` where `requireEnv = makeReader(process.env)` is a read of `TABLE_NAME`. `__dirname`, `import.meta.url` and `process.cwd()` are no longer environment reads. ([#1094](https://github.com/nimbuscloud-ai/suss/pull/1094), [#1095](https://github.com/nimbuscloud-ai/suss/pull/1095), [#1129](https://github.com/nimbuscloud-ai/suss/pull/1129), [#1135](https://github.com/nimbuscloud-ai/suss/pull/1135))

### An intent document says what a boundary receives

A `receives` block on every boundary kind declares the fields a boundary is handed, and `suss check --intent` compares it against what the unit reads. For a REST route the block is written as `headers`, `query`, `params` and `body`, and each REST pack says where its handlers read those. `@suss/intent-ir` publishes a JSON Schema for intent documents, and `suss intent outcomes --from intent/` lists the outcome ids a PRD scenario can link to. ([#1108](https://github.com/nimbuscloud-ai/suss/pull/1108), [#1109](https://github.com/nimbuscloud-ai/suss/pull/1109), [#1111](https://github.com/nimbuscloud-ai/suss/pull/1111), [#1118](https://github.com/nimbuscloud-ai/suss/pull/1118))

### The CLI reads suss.json when given nothing

`suss extract` with no `-f` reads the packs from `suss.json`, or picks the ones `suss init` would when there is no file, and `suss inspect` and `suss check` given nothing read the current project first. ([#1090](https://github.com/nimbuscloud-ai/suss/pull/1090))

### Ruby follows dataloader sources and model callbacks

A GraphQL field that loads through `dataloader.with(Sources::CampaignSource, Campaign)` reaches the source's `fetch`, and a write through a model reaches the callbacks its class registers for that event, including one registered on `ApplicationRecord`. ([#1128](https://github.com/nimbuscloud-ai/suss/pull/1128))

### Fixes

- A Prisma client generated into the project's own directory is read, and a pack whose library is installed but whose gate selected no file says so in the pack health report. ([#1106](https://github.com/nimbuscloud-ai/suss/pull/1106))
- An axios instance's `baseURL` is put in front of every path it sends. ([#1093](https://github.com/nimbuscloud-ai/suss/pull/1093))
- A client path through `encodeURIComponent(id)` reads as `/messages/{id}` instead of `/messages/undefined`. ([#1092](https://github.com/nimbuscloud-ai/suss/pull/1092))
- A shorthand property in an object argument is read by a pack's property pick. ([#1123](https://github.com/nimbuscloud-ai/suss/pull/1123))
- `--files` with a tsconfig gives the same summaries a full walk gives those files, and `--files a b` keeps both. ([#1126](https://github.com/nimbuscloud-ai/suss/pull/1126))
- `suss inspect` says which variable a config read takes, and `inspect --diff` no longer folds two variables read through one chain into one line. ([#1089](https://github.com/nimbuscloud-ai/suss/pull/1089))
- The node pack asks the resolution rules whether a value is the environment instead of reading the syntax itself. ([#1142](https://github.com/nimbuscloud-ai/suss/pull/1142))
- A finding no longer says "makes POST POST /v1/charges", and the retired-option warning stops naming a release that never refused them. ([#1105](https://github.com/nimbuscloud-ai/suss/pull/1105))
- The petstore example has a manifest and calls its spec `openapi.json`, so `suss init` finds both. ([#1091](https://github.com/nimbuscloud-ai/suss/pull/1091))
- The docs are at [suss.sh](https://suss.sh/), and every page has been rewritten with its output blocks run through the built CLI. ([#1096](https://github.com/nimbuscloud-ai/suss/pull/1096) through [#1104](https://github.com/nimbuscloud-ai/suss/pull/1104), [#1110](https://github.com/nimbuscloud-ai/suss/pull/1110), [#1112](https://github.com/nimbuscloud-ai/suss/pull/1112), [#1117](https://github.com/nimbuscloud-ai/suss/pull/1117), [#1120](https://github.com/nimbuscloud-ai/suss/pull/1120))

## 0.32.0 (2026-09-17)

0.32.0 reads an environment variable through a project's own settings helper, in all three languages, through one rule instead of three walks.

### An env var read through a helper is reported at the call that passes its name

A helper like `def env(key, default=None): return os.environ.get(key, default)` used to hide every variable behind it in Python and Ruby, and TypeScript found them through a walk of its own in the node pack.

Each adapter now states one fact at the read site, and one rule in `@suss/resolution` works out which calls supply the name, through any number of helpers. `suss ask "what does settings.py reach"` lists `DATABASE_URL` and `AWS_REGION` where it used to say the file crosses no boundary.

The TypeScript walk is gone with it, and a cold extract of this repository takes 26.4s where it took 33.7s, finding the same reads. A helper that is a value rather than a function definition, `functools.partial` or a lambda in a constant, is not followed yet. ([#1086](https://github.com/nimbuscloud-ai/suss/pull/1086))

### Fixes

- A bare call inside a Ruby module constant is looked up on that module. ([#1087](https://github.com/nimbuscloud-ai/suss/pull/1087))

## 0.31.0 (2026-09-14)

0.31.0 follows a value to the place it was actually written: the construction of a class, the caller of a wrapper, the module that defines a GraphQL fragment.

### A class handed part of its request when it is built is read once per construction

A class that takes a path prefix in its constructor, `constructor(private base: string)`, calls `client.get(this.base)` in one method and interpolates the same prefix into a longer path in another. Both used to come out with an empty path: `GET ?` and `GET {base}/{id}`. The prefix is written as two different literals, one per construction, and a value with two writes and nothing to choose between them comes down to nothing.

Each adapter now asks where the surrounding class was built, reads the path again under each construction, and reports one client call per path it finds. A file that builds `new Resource("/users")` and `new Resource("/orders")` gives `GET /users`, `GET /orders`, `GET /users/{id}` and `GET /orders/{id}`, and each of those pairs with the route that serves it where before none did.

The same class in Python, with `self.base` set in `__init__`, goes from one summary to three. In Ruby, with `@base` read in a method that calls `Faraday.get`, it goes from nothing at all to one route per construction. The request method is read the same way when a pack takes it from an argument, so a Ruby class handed `Net::HTTP::Get.new` by one construction and `Net::HTTP::Post.new` by another reports a GET and a POST.

A class the run never builds is unchanged, two constructions that ask for the same thing stay one call, and a class built by a factory function rather than by its own name has no construction this question can find. ([#1069](https://github.com/nimbuscloud-ai/suss/pull/1069), [#1070](https://github.com/nimbuscloud-ai/suss/pull/1070), [#1071](https://github.com/nimbuscloud-ai/suss/pull/1071), [#1075](https://github.com/nimbuscloud-ai/suss/pull/1075), [#1076](https://github.com/nimbuscloud-ai/suss/pull/1076))

### A request through a generated HTTP client is read as one request per service method

A client generated from an OpenAPI schema, and a hand-written one in the same style, builds its request out of a config object. `UsersService.readUsers()` calls `client.get({ url: "/api/v1/users/" })`, `client.get` is an arrow on an object literal that adds `method: "GET"` and calls the project's own `request`, and only `request` reaches axios. suss reported one summary for `request` with no path and the verb its pack defaults to, which was wrong for every call that was not a GET, and nothing at all for the service methods where the paths are written.

Each hop is now a question about a value. The resolution facts say which calls filled the wrapper's parameter and what each wrote there, the request object at the library call is evaluated again with the parameter bound to that, and it repeats outward while a hole is left.

On a three-file client in that shape suss now reports `readUsers` as `GET /api/v1/users/`, `createUser` as `POST /api/v1/users/` and `deleteUser` as `DELETE /api/v1/users/{user_id}`, with the verb read off the caller's own object rather than the pack's default. The callers come from the same rules the GraphQL hook expansion uses, so a wrapper reached through an alias or a barrel is followed, three deep. A method on an object literal is now found from its callers, and a receiver written as `options?.client ?? client` resolves through the fallback. A client whose path is built by a helper that loops, or one whose parameter is destructured in the signature, still comes back with its path open. ([#1047](https://github.com/nimbuscloud-ai/suss/pull/1047))

### A component that calls the project's own GraphQL hook is read as the operation it sends

Production frontends rarely call `useQuery` directly. They write one `useAppQuery` that picks the client or adds telemetry and have every component call that, so the document argument inside the hook is the hook's parameter. suss reported one summary, `useAppQuery.query`, with a gap saying the argument did not resolve, and nothing at all for the several hundred components that name an operation.

Such a hook is now read as one operation per caller, with the caller's document and at the caller's location, so `operationScopes` applies per component file and the caller's `const { data, error } = useAppQuery(Doc)` reads the way it reads off `useQuery`. The callers come from the resolution facts, which follow an alias and a re-export barrel, and a hook in front of another hook is followed to the component at the top, three deep.

The hook's own summary goes away once every caller has one. Where a caller cannot be followed it stays, and `metadata.graphql.unresolvedDocument.reason` says how many were read and how many were not. The same applies to `client.query({ query: doc })` written behind a project function. Which client the hook's other arguments pick is not read. ([#1039](https://github.com/nimbuscloud-ai/suss/pull/1039))

### A GraphQL operation that spreads a fragment by name gets the definition from the file that writes it

A project generated with graphql-codegen's client preset keeps `fragment UserCard on User { ... }` in the component that renders the card and spreads `...UserCard` from a query in another file, importing nothing: codegen finds the fragment among the project's documents and puts it in the document it emits. suss read the template as written, so the operation's document came back with `...UserCard` and nothing behind it. The spread was then taken off the summary, because the project did define the fragment somewhere, and the operation passed as checked with the fields selected through the fragment never walked. On a project written this way that is most of the operations.

A document built by the project's own generated tag now takes each spread's definition from an index of every fragment the project defines, in a TypeScript document or a `.graphql` file, following a fragment that spreads another, so a field the schema does not declare is reported wherever it was selected.

A document built by a library's tag (`@apollo/client`, `graphql-tag`) is still read as written, since that text is what ships, and a spread it does not define stays in `metadata.graphql.unresolvedFragments`. A name the project defines twice with different bodies is taken from neither and comes back in `metadata.graphql.ambiguousFragments`, with the finding saying which it was. ([#1038](https://github.com/nimbuscloud-ai/suss/pull/1038))

### A shared field list is spliced into the operation that interpolates it

A frontend that wants the same selection in several operations writes ``const RESULT_FIELDS = `id title publishedAt author { id name }` `` and puts `${RESULT_FIELDS}` inside the selection set of a `gql` template. The string is neither a document nor a fragment, and every rung of the document reader wanted a document, so the interpolation was dropped, no document was stored, and `metadata.graphql.unresolvedDocument` said the expression inside a selection set did not resolve to a GraphQL document. On a frontend that shares field lists this way that was the largest remaining reason an operation went unread.

Such an interpolation is now spliced as the text it is, whether it is written in place, declared in the same module, or imported from another module or through a barrel. A constant built out of other constants is assembled the same way, and a document interpolated inside one still splices as a document. Whether the result is GraphQL the schema accepts is left to the parse that already runs on the assembled document, so a field the schema does not declare is reported wherever it was selected. A name the reader cannot settle on a single write, and a pair of constants whose text interpolates each other, leave the operation unread with the reason they gave before. ([#1040](https://github.com/nimbuscloud-ai/suss/pull/1040))

## 0.30.0 (2026-09-11)

0.30.0 stops a route's summary multiplying out by its middleware, and teaches the Ruby adapter what a database call actually is.

### A route lists what its middleware responds with, once, instead of multiplying its own outcomes

A Rails action behind ten `before_action` filters, or an Express route behind a chain of `app.use`, used to get every one of its outcomes paired off against every pass-through of every filter, with each filter's effects copied onto each pair. On Discourse that made `PublishedPagesController#check_slug`, a four-line action with two outcomes, a summary of 254 transitions and 9,994 storage effects, 3.4 MB for one action, and the run's whole output was 2.55 GB.

Composition now keeps the unit's own transitions and lists each wrapper's responses beside them, tagged with which wrapper produced them under `wrappers.from`. A pass-through contributes nothing, because the unit's outcomes already say what happens once the request gets through, and `metadata.wrappers.applied` gives the chain in the order it runs.

What a filter does on the way in stays in the filter's own summary, and the CLI follows the chain the way it follows a call: `inspect` shows a filter's table reads once under `Reaches:` with the filter as the hop, `inspect --diff` compares them there, and `why` prints the hop as "registered around".

`check_slug` comes out at 23 transitions and 256 effects, and its `inspect` block at 320 lines where it was 10,840. Across Discourse the summary file goes from 2.55 GB to 211 MB, transitions from 108,444 to 26,416 and storage effects from 166,584 to 20,129, with the distinct storage accesses across the whole run unchanged at 315. Anything that reads one summary on its own now has to follow `wrappers.applied` for the effects along the whole request, the same as for a callee.

The Ruby adapter also builds the filter chain the way Rails does: a `before_action` declared again in a subclass moves that filter to the end of the chain with its new options rather than running it twice, and a `skip_before_action` followed by a new declaration puts the filter back. ([#1035](https://github.com/nimbuscloud-ai/suss/pull/1035))

### A Ruby storage effect is recorded only for a method ActiveRecord defines, with what it was given

`Tag.new(name: x)`, `ApplicationRecord.transaction do`, and a project's own `SiteSetting.login_required?` were each reported as a database read, because every call on a chain that started at a model constant counted. The effect said nothing about what was read either: no selector and no fields. Discourse's most common storage line was a project method, `Notification.read`.

A call is database work now when the activerecord pack lists its method as a read or a write, the class behind its receiver reaches `ActiveRecord::Base`, and the project does not declare that method itself. A constructor, a transaction and a project method say nothing here, and the reach walk follows them instead. The same rule covers a receiver written as a constant and one the rules settle, so a read through `@account` is recorded the way a write already was.

The effect says what the chain was given to pick rows by, `id` for `find(params[:id])` and the keyword keys of every `where` and `find_by` along it, and which columns a write sets or a `pluck` or `select` asks for. A chain counts once, at the outermost call the library defines, so `Status.find(id)&.proper` keeps its `find`.

On Mastodon 266 distinct storage lines go away and 124 arrive. `Api::V1::StatusesController#create` used to say `Status read find` and `Status read proper`, and now says `Status read find | id` twice, from `set_thread` and `set_quoted_status`. On dispatch (Python) a call to a project function annotated `-> Session` is no longer a read against no table. A Rails `scope :name, -> { ... }` reports nothing now, since a scope is not a `def` and the walk cannot follow it yet. ([#1033](https://github.com/nimbuscloud-ai/suss/pull/1033))

### A Ruby method a mixin declares is found from the class that includes it

`include Account::Associations` said nothing to the facts the resolution rules join on, so a method a concern declares was never found from the model, and the statements inside `included do` and `with_options do` were lost with it.

A mixed-in module is now part of the class's ancestry, beside its superclass, and the statements of those blocks are read as statements of the class around them. `has_many :statuses` becomes a fact, one shared rule makes `@account.statuses` settle on `Status`, and `find` on it composes the way `Account.where(x).first` already does. Chains like `@account.statuses.destroy_all`, whose receiver can now be settled, are recorded as writes.

The sqlalchemy and sqlmodel packs say the same for a field given `relationship(...)` or `Relationship(...)`, with the target read from `list[Item]`, `Optional[Item]`, `Mapped[list["Item"]]` or the first argument. ([#1031](https://github.com/nimbuscloud-ai/suss/pull/1031), [#1032](https://github.com/nimbuscloud-ai/suss/pull/1032))

### Fixes

- A Ruby `define_method` loop over a method that gives back a literal list is read, so Discourse's `Discourse.filters.each { |filter| define_method(filter) { ... } }` no longer stops every lookup on `ListController`. Its gaps that mention `define_method` go from 72 to 29. ([#1029](https://github.com/nimbuscloud-ai/suss/pull/1029))
- The calls whose block runs as part of a Ruby class body, `included`, `prepended`, `class_methods`, `concerning` and `with_options`, come from the rails pack rather than a table in the adapter, and a `def` inside `class_methods do` is a class method. The adapter also reads `config/initializers/inflections.rb` in full, so a project that registers `inflect.irregular "person", "people"` gets `has_many :people` pointed at `Person`. ([#1034](https://github.com/nimbuscloud-ai/suss/pull/1034))

### For contributors

**Wrapper composition adds responses and never multiplies.** `composeWrappers` in `@suss/extractor` keeps a unit's own transitions and puts each covering wrapper's non-delegate transitions beside them with `wrappers.from`; the splice, the pass-through product, the error-handler product and the `MAX_PATHS` budget are gone. Pairing a `WrapperReference` with its summary moved to `@suss/behavioral-ir` as `wrapperIndex`, `wrapperFor` and `wrapperChain`, so the extractor and the CLI share one. `readCallFacts` in the CLI states a `wraps(unit, wrapper, name)` fact per chain link, `calls` has a fourth record kind `wraps`, and the reach rules follow it; `directCallers` leaves it out, since a wrapped unit does not call its wrapper.

**`RbStoragePattern` states what the library defines and what each call means.** `reads` is required beside `writes`, and a method in neither is not database work, whatever it is called on. `byPrimaryKey` gives the finder methods and the column a positional argument picks by, `columnArguments` the read methods whose symbol arguments are columns, and `associations` the class-body calls that declare an association, split by singular and plural spelling. The Python side gained `PyModelQueries.relationships`, and `declaresAssociation(cls, n, t)` is the shared fact both adapters supply and one rule in `@suss/resolution` reads.

**A Ruby class body's dynamic declarations are facts, and its body blocks come from the pack.** The value-fact walk states `definesMethodFrom(classKey, exprKey)` and `nameTurnsOn(exprKey, element, index, overKey)` for each `define_method` and the loops around it, and `defineMethod.ts` reads no source: it evaluates each name with the shared evaluator and adds `declaresName(classKey, name)`. `RubyPack.bodyBlocks` replaces the adapter's own table, each entry saying whether the call is module-only and whether a `def` in it is a class method. `RubyPack.inflections` is what the project taught its inflector, and `include` and `prepend` emit `extends(class, module)`.

## 0.29.0 (2026-09-10)

0.29.0 follows a Ruby call through the places a Rails app actually puts one: an instance variable, a no-argument method, the value a finder gave back.

### A Ruby write through an instance variable or a local is recorded against the model

A Rails controller sets `@account = Account.find(params[:id])` in a `before_action` and the action writes through it, `@account.update!(suspended_at: Time.now)` or `@account.save`, and none of that reached the summary: the storage recognizer found the model by the constant a chain starts at, and there is no constant here. Mastodon had 168 such write calls saying nothing.

A call whose method a pack counts as a write now asks the same rules the reach walk asks about its receiver, and records a write against the class they settle on, so long as that class reaches a base the pack lists. Across 0.29.0 as a whole, Mastodon goes from 39 writes to 163 and Discourse from 54,698 to 57,657; this change on its own leaves reads, summaries and gaps unchanged.

Only a write is recorded, because a read on an instance is as likely an attribute read or a project method the walk follows. A call whose method the project writes itself is left out, since the walk steps into that body and the body reports its own effects. A block parameter is still not bound in the facts, so `orders.each { |o| o.save }` says nothing. ([#1025](https://github.com/nimbuscloud-ai/suss/pull/1025))

### A Ruby or Python call on what a database finder gave back is followed

`@account = Account.find(params[:id])` in a `before_action` and `@account.suspend!` in the action said nothing, because `find` runs inside ActiveRecord, which suss does not read, so the value had nothing behind it.

A pack now says which of its library's methods give back one of the class. The activerecord pack lists the finders and the relation methods ActiveRecord defines, and a call on a class that reaches `ActiveRecord::Base` settles on that class, so `@account.suspend!` reaches `Account#suspend!` and a chain such as `Account.where(x).first` composes. The sqlalchemy and sqlmodel packs say the same for `session.get(User, id)`, `session.query(User)` and `select(User)`, where the class is an argument rather than the receiver, and a model under `DeclarativeBase`, `SQLModel` or a `declarative_base()` base is recognised. TypeScript already read the return type from the library's typings.

On Mastodon summaries go from 1807 to 1822 and on Discourse from 3381 to 3530; on dispatch (Python) gaps go from 135 to 127. dispatch runs about 13% slower, since the rules now walk the longer query chains. ([#1021](https://github.com/nimbuscloud-ai/suss/pull/1021), [#1023](https://github.com/nimbuscloud-ai/suss/pull/1023))

### Fixes

- A Ruby call written with no arguments is read as a method call when the rules settle its receiver on a class or a function the run defines, and as a property read otherwise. `Filter.new(scope).results` now reaches `Filter#results`. Mastodon summaries go from 1822 to 2157 and Discourse from 3530 to 4699, and the gaps rise with them because each newly reached body reports its own stops. Discourse takes about 145s where it took 120s. ([#1024](https://github.com/nimbuscloud-ai/suss/pull/1024))
- A Ruby method a `define_method` loop writes is looked up by name instead of stopping the lookup with a gap, which used to hit every admin settings controller in Mastodon through one `Form::AdminSettings.new`. Mastodon gaps go from 125 to 117. ([#1020](https://github.com/nimbuscloud-ai/suss/pull/1020))

## 0.28.0 (2026-09-10)

0.28.0 gives all three adapters one shared answer to "what does this name come down to", and Ruby gets instance variables with it.

### A Python or Ruby call through a reassigned local is followed

`query = Entity.new` followed by `query = query.filter(2)` and `render json: query.all`, or the same in Python, left a gap saying the value could not be settled, and so did a name written through parentheses, an alias chain (`a = Entity.new; b = a; c = b; c.run`) and a builder method that returns `self`. Each adapter had its own reading of what a reassigned name comes down to, and only the TypeScript one followed these.

The three adapters now record every write to a name as a fact and one shared policy decides: a write that narrows the name (`x = x.filter()`) is set aside, a name whose writes run once each in order comes down to the last one, and a name two branches write differently is reported with both sources. Where a call still stops, the summary says which of these it met: the value came from a dependency, from a caller's argument, from more than one place, or from nothing the run declares.

On the dispatch corpus (Python) gaps go from 491 to 135 and three more units are bound. On Mastodon 122 more calls are followed, summaries go from 1745 to 1801 and gaps from 914 to 121; on Discourse summaries go from 3003 to 3355 and gaps from 3562 to 1030. Most of the vanished Ruby gaps are calls on a value a Rails method built, `params.require` or `user.orders` say, which used to be reported as unsettled and are now classed as declared nowhere in the run, the same class the TypeScript adapter already leaves out. Mastodon runs about a second slower (7.4s to 8.4s) and Discourse about thirty seconds slower (102s to 133s), because every reassigned name now goes to the rules. ([#1009](https://github.com/nimbuscloud-ai/suss/pull/1009), [#1010](https://github.com/nimbuscloud-ai/suss/pull/1010), [#1011](https://github.com/nimbuscloud-ai/suss/pull/1011))

### A Ruby call on an instance variable another method set is followed

A Rails controller writes `@suggestions = AccountSuggestions.new(current_account)` in a `before_action` and calls `@suggestions.remove(params[:id])` in the action, and nothing tied the two methods together, so every call on an instance variable stopped with no declaration.

An instance variable is now read as a property of its class, written wherever the class body writes it and read wherever it is read, and a write in a base controller reaches a read in a subclass through the ancestry. `@scope = @scope.where(a: 1)` narrows the name and is set aside the way it is for a local; two methods that build the variable from different classes leave a gap saying it has more than one source.

On Mastodon 7 more calls are followed and on Discourse 21, and eight links that were wrong go away: `@announcement.update` used to be matched by name to the enclosing controller's own `update` action, and now settles on the model, where `update` is ActiveRecord's. Most instance variables in a Rails app are still unfollowed, because `@account = Account.find(params[:id])` assigns what a finder gave back and no pack yet says a finder returns one of the class it was called on. ([#1016](https://github.com/nimbuscloud-ai/suss/pull/1016))

### Fixes

- A Ruby constant that two files open again is bound. `module Jobs` opened in hundreds of files, or a class reopened in a concern, bound to nothing because two definitions used to settle nothing; every reference to such a constant now binds to the first body and the lookup by name reaches the rest. A bare assignment such as `User = Data.define(...)` in a script beside `class User` is still a guess and stays unbound.

### For contributors

**A call's callee comes from the rules, and the rules say why it is nothing.** `calleeOutcomes(db, keys, program)` in `@suss/resolution` asks the resolution program what each callee key comes to and returns a `CalleeOutcome`: one function, one object, several sources, a parameter a caller supplies, a value from outside the run, a value the rules could not settle, or nothing declared. The Python and Ruby adapters both read their callee from it, and the Ruby adapter asks about the receiver instead and lets `ancestry.ts` pick the method, because the shared `contains` rule has no method resolution order. A gap is recorded only for the outcomes that name something the reader failed at. ([#1012](https://github.com/nimbuscloud-ai/suss/pull/1012))

**Whether a name's writes run in order is decided by one shared walk.** `writesRunInOrder(scope, name, writes, rules)` and `startsAtName(node, name, rules)` in `@suss/resolution` take a `NameReads` description of the grammar and each adapter passes its own. Python and Ruby used to carry a copy of that walk each. `nameTypes` is a set because Ruby spells a name two ways, bare and `@name`. ([#1015](https://github.com/nimbuscloud-ai/suss/pull/1015))

**A Ruby instance variable is a `holdsProperty` on the class.** `facts/values.ts` collects every write to `@name` across a class body and emits `holdsProperty(classKey, "@name", value)` for the value the writes settle on, or one fact per disagreeing write; every read emits `readsProperty(readKey, classKey, "@name")`. Nothing orders two methods, so `valueLeftByWrites(writes, false)` decides. A write in a singleton method is collected with the rest, which over-approximates: `def self.x` writes a class-level variable, a different object. ([#1016](https://github.com/nimbuscloud-ai/suss/pull/1016))

## 0.27.0 (2026-09-10)

0.27.0 is a sweep across Rails routing, Express and Hono middleware, and Python parameter annotations, driven by what a run over production applications kept missing.

### A Rails app gets its routes read, however they are written

The rails pack read `resources`, `namespace`, `scope` and the bare verbs, and stopped everywhere else, so an app that keeps its routes in `config/routes/*.rb` had almost every action unbound. On Mastodon, 37 of 583 actions had a method and path before this release.

Six changes landed across the release and each moved that number:

- The pack reads `draw(:name)` under the scope it was written in, `constraints` blocks, `with_options` defaults, `concern` and `concerns`, `match ... via:`, and `module:` on a resource. A singular `resource :settings` routes to `SettingsController`. Mastodon goes to 559 of 583. ([#979](https://github.com/nimbuscloud-ai/suss/pull/979))
- A route written inside `member` or `collection` with its own target is placed under the resource, so `get "logs/:id" => "backup_logs#show"` inside `resources :backups` comes out at `/backups/logs/:id` rather than `/logs/:id`. On Discourse, 474 of 1251 actions had a method and path; 654 do now. ([#990](https://github.com/nimbuscloud-ai/suss/pull/990))
- A routes block looped over a literal word list is walked once per element with the parameter bound, so `%w[users u].each do |root_path| ... end` declares both routes. On Discourse, 751 of 1251. ([#991](https://github.com/nimbuscloud-ai/suss/pull/991))
- A Rails engine the project keeps in its own tree is mounted. A project says where its engines are with `engineRoots` in the pack's config, and the pack reads each engine's `isolate_namespace` and routes file and serves them under the mount path. On Discourse, with `{ "engineRoots": ["plugins/*"], "routesFiles": ["plugins/*/plugin.rb"] }`, 1138 of 1251. ([#992](https://github.com/nimbuscloud-ai/suss/pull/992))
- A controller under a registered acronym is found: a project that writes `inflect.acronym "ActivityPub"` keeps `ActivityPub::InboxesController` at `activitypub/inboxes_controller.rb`, and the pack now applies the project's own acronyms the way ActiveSupport does. A controller extending `ActionController::Base` or `ActionController::API` directly is a controller too. On Mastodon, 582 of 603. ([#993](https://github.com/nimbuscloud-ai/suss/pull/993))
- A routed public method a project ancestor defines, with nothing nearer overriding it, is reported as the subclass's action, located in the ancestor's file. On Mastodon, 608 of 629. ([#994](https://github.com/nimbuscloud-ai/suss/pull/994))
- A call the pack does not know, whose block has a routing call at its top level, is walked under the enclosing scope, so Devise's `devise_scope :user do ... end` binds the routes inside it and the file gets one gap saying the wrapper was read as though it changed nothing. On Mastodon, 615 of 629. ([#995](https://github.com/nimbuscloud-ai/suss/pull/995))

### An Express or Hono route lists its own middleware, and every one of them is read

`router.post("/", asyncHandler(login), respond)` runs `login` first and `respond` only when `login` calls `next()`, and the adapter read the last function alone, so the route's summary was `respond`'s body and the login logic, its 400s and everything it called, was missing with no gap saying so.

Every function listed before the handler is now read as a middleware of that route, the way `app.use(fn)` already is, and the handler is spliced in where each one hands control on. A middleware listed as an array is read in order, one a project factory returns is followed into the factory, and one a dependency's factory returns, `passport.authenticate("jwt")` say, contributes nothing, as it does at the app level. One with no name of its own goes by its factory and the route, `asyncHandler@POST /login`.

On directus's API, where 235 of 269 routes end in the shared `respond` handler, 25 routes pointed at a middleware before and 258 do now, and 244 routes gained transitions or effects. `POST /auth/login` now includes the login itself, the throw the driver leaves for the error handler and the call into the authentication service. A factory that returns what another factory returned, `validateBatch(scope)` giving back `asyncHandler(fn)`, is still one hop too many, and each route that lists one says so in a gap instead of leaving it out. ([#999](https://github.com/nimbuscloud-ai/suss/pull/999))

### A Python or Ruby storage effect is against the model, under the same label as TypeScript

A SQLAlchemy call came out as `reads postgresql:sqlalchemy/select` or `writes postgresql:sqlalchemy.orm/session`, which is the constructor or the variable the chain started on with the library module in front of it, and a Rails call came out as `reads postgresql:ActiveRecord::Base/Order`.

The Python adapter now takes the model from the call: `select(Item)`, `select(Item.id)`, `session.get(Item, 1)` and `session.query(Item)` say it in the first argument, `select_from(Item)` says it later in the chain, and `session.add(item)` takes it from what the function declares `item` to be, through an `Annotated` alias such as `current_user: CurrentUser` and through a project function annotated `-> User | None`. On the FastAPI template, every session call but `commit` now says whether it is against `User` or `Item`; `session.commit()` works on no table and comes out with the container unnamed.

Both adapters now write the same `default` scope every TypeScript pack writes, so the label is `postgresql:Item` in all three languages. `check` pairs a storage access with a schema on the scope as well as the table, so before this a Python or Ruby access could never pair with one. ([#982](https://github.com/nimbuscloud-ai/suss/pull/982))

### Fixes

- A FastAPI parameter annotated with a name from another module gets its role. `item_in: ItemCreate` and `session: SessionDep` both came out as query parameters, because the Python adapter read an annotation inside one file only. It now asks the import facts where the name comes from, through a re-export in an `__init__.py`. ([#1005](https://github.com/nimbuscloud-ai/suss/pull/1005))
- A Python function that calls a method on something a dependency built has no gap for it. `logger = logging.getLogger(__name__)` followed by `logger.info(...)` left an "unsettled value" gap on every function that logs. On the FastAPI template the run goes from seven gaps to one. ([#1006](https://github.com/nimbuscloud-ai/suss/pull/1006))
- A router mounted or a route declared under a condition is read. Both the Python and Ruby readers walked only the top-level statements of a body, so the FastAPI template's `if settings.ENVIRONMENT == "local":` mount came out with no path. All three languages agree now. ([#1004](https://github.com/nimbuscloud-ai/suss/pull/1004))
- Two middleware written out at `app.use` in one file are told apart. Both go by `use`, and composition paired each reference with the first summary of that name, so a 401 check followed by a 403 check read as 401, 401, 200. A reference to a wrapper with no name of its own now includes the line it starts on. ([#1003](https://github.com/nimbuscloud-ai/suss/pull/1003))
- An Express route registered with `search`, `head` or `options` is read. The express pack routed six verbs; directus has 22 routes on the others. ([#1002](https://github.com/nimbuscloud-ai/suss/pull/1002))
- A `--files` run composes a route's listed middleware the way a full run does, and `inspect --diff` keys a block by boundary as well as by function, so three routes served by one `respond` no longer collapse into one block. ([#1000](https://github.com/nimbuscloud-ai/suss/pull/1000))
- An Nx monorepo is read with its path aliases, at the root or in one app. The base file is read when the command points at the directory that keeps it, and a tsconfig with no files of its own takes its file list from the union of its references. ([#997](https://github.com/nimbuscloud-ai/suss/pull/997))
- A `fetch` written through `globalThis`, `window`, `self` or `global` is read the same as the bare spelling. A `fetch` method on some other object is still left alone. ([#998](https://github.com/nimbuscloud-ai/suss/pull/998))
- A Prisma call through a project's own client subclass is read. A NestJS app writing `class PrismaService extends PrismaClient` had no storage effect on any call through the service; the pack now follows the type's base classes. ([#996](https://github.com/nimbuscloud-ai/suss/pull/996))
- An axios request written as one config object is read: `axios({ url, method })`, `api({ url })` on an instance built by `axios.create`, and `axios.request(config)`. The object is evaluated, so a spread from a name the evaluator can follow contributes its fields. ([#983](https://github.com/nimbuscloud-ai/suss/pull/983))
- A FastAPI project on SQLModel gets its database calls read. A new `sqlmodel` pack says the same things about the `sqlmodel` module, with `-f sqlmodel=suss.sqlmodel.json` saying which database is behind the engine. On the template, 84 storage effects come out where there were none. ([#981](https://github.com/nimbuscloud-ai/suss/pull/981))
- `suss init` finds a Python or Ruby service beside the frontend. It took its list of projects from the npm workspace file, and a `pyproject.toml` or a `Gemfile` is listed in none. ([#980](https://github.com/nimbuscloud-ai/suss/pull/980))
- `suss init` reads a Rails app whose frontend packages are npm workspaces. A root that declares workspaces was taken to be a container and not a project itself. The rails pack is also suggested for an app that depends on `railties` rather than `rails`. ([#987](https://github.com/nimbuscloud-ai/suss/pull/987))
- `suss inspect` prints a Python or Ruby storage read. The tree took its reads from a field only the TypeScript adapter wrote, and now prints the effect from the summary itself, so a unit that reads a table shows `+ reads postgresql:User` in every language. ([#978](https://github.com/nimbuscloud-ai/suss/pull/978))

### For contributors

**A Ruby unit is deduplicated by what it is reported as.** `alreadyDiscovered` keyed a unit on its file and range alone, so two controllers inheriting one `show` would have collapsed to a single unit. The key now includes the export path, so one method body can be reported once per controller that routes it, while a filter two controllers share still appears once.

**A Ruby ancestry walk says when it reached the library.** `superclassChain` used to return nothing at all both when a chain ended at one of `ancestryRootClassNames` and when it ended at a class the run could not read. The chain now ends in a `root` entry with the library class's name, and `underscoreConstantPath` and `resolveConstantFile` take the project's inflector acronyms.

**The Ruby value evaluator takes bindings for the enclosing block's parameters.** `stringValueOf(node, db, bindings)` and `evaluatedValue(node, db, bindings)` accept a map from a parameter name to the string to read it as. A reader that replays a block per element supplies `x` and gets the interpolated string back spelled, without a second reading of Ruby strings in the pack.

## 0.26.0 (2026-09-09)

0.26.0 pairs a GraphQL schema against the resolvers behind it, and teaches the graphql-ruby pack what a dataloader call reads.

### A graphql-ruby resolver that reads through the dataloader gets a storage read

A field that resolves with `dataloader.with(Sources::ActiveRecordBelongsTo, ::User).load(object.user_id)`, or with one of the `dataload` shortcuts, used to have no storage effect and a gap saying the call went through a value the run could not settle. The model is one of the call's arguments, so the field now records a read against `User` and the gap is gone.

It takes `@suss/framework-activerecord` in the same run to say which constants are models, as `-f activerecord=suss.activerecord.json` with a config giving `storageSystem`; the graphql-ruby pack alone does not record the read. `dataload_association` is still not read, because the model behind an association is declared on another class. ([#976](https://github.com/nimbuscloud-ai/suss/pull/976))

### A GraphQL schema is compared against the resolvers behind it

A schema read with `suss contract` and the code that implements it both provide `gql:Mutation.articleApprove`, and `check` used to report those as "claimed by more than one file": 210 of them on one repository, with nothing compared.

A document describes a boundary rather than serving it, the same way an OpenAPI document does, and the two are paired now. The schema reader also writes out the record behind each named type, so the two sides have structure to compare: a field's return type used to be the name `ArticleApprovePayload`, and a name has nothing to compare against the record a resolver declares.

### Fixes

- `suss init` prints commands that run. A directory of GraphQL documents is suggested only when a file under it has a query, a mutation or a subscription; Storybook stories are suggested once, at the directory they share; a project with more than one schema file gets one output file per schema; and a document is told apart from a schema by parsing it. ([#970](https://github.com/nimbuscloud-ai/suss/pull/970))
- A Ruby model spelled `::Order` or `Shop::Order` is recognized. The storage recognizer matched a bare name against every binding in the run, which never matched a compound path, and a leading `::` was read as part of the name.

### For contributors

**The corpus runs what `suss init` prints.** A target used to come with a pack list written in this repository, a third copy of what a project needs and not the path anybody takes. A target now says which directory to point `init` at; the run writes the config files `init` said to write, runs the commands it printed, and fails when one of them fails. Every defect the last sweep found sat between what `init` printed and what running it did. `init` suggests packs the hand-written lists left out, so every target reads more: saleor-dashboard went from 5903 summaries to 8739, twenty-server from 4505 to 6747. ([#974](https://github.com/nimbuscloud-ai/suss/pull/974))

## 0.25.0 (2026-09-08)

0.25.0 is three small fixes a sweep over two codebases turned up. ([#971](https://github.com/nimbuscloud-ai/suss/pull/971))

### A pack config kept outside the project says so

A relative path in a pack config is read against the config file, so a config written somewhere else resolves to a directory that is not there. Every class lookup through it came back empty and the run reported hundreds of gaps naming a base class the project defines. The run now says which value points where, before it starts:

```
suss.graphql-ruby.json says root is app/graphql, and there is nothing at
/elsewhere/app/graphql. A relative path is read against the config file, so a
config kept outside the project points at nothing.
```

### Fixes

- `export const Thing` beside `export default Thing` is not a pack fault. Every run of a React codebase printed `double-match react 1 unit matched twice, second dropped`. The dedup key is the function's own file and span, so a collision inside one file only ever means one function reached twice, which ordinary code does. Nothing was lost when the second claim dropped, and the check is gone.
- `suss ask` with no question exits 0. Printing the questions is what `suss --help` says to do, and it exited 1 for it. A question suss cannot answer still does.

## 0.24.4 (2026-09-08)

0.24.4 fixes two ways `init` and the GraphQL reader lost a file.

### Fixes

- `suss init` says which contract files it found, all of them. It kept one suggestion per reader, so the first `.graphql` file the walk reached won and the rest were dropped; on one project a fragment file was named as the schema and `schema.graphql` at the root was never mentioned, and two SAM templates in one repository lost the same way. A GraphQL file that declares types is read as a schema, and one with only operations goes to `--from graphql-documents`, which takes the directory. ([#968](https://github.com/nimbuscloud-ai/suss/pull/968))
- A fragment written in a `.graphql` file counts as registered. graphql-codegen scans `.ts`, `.tsx` and `.graphql` alike for documents, and the reader looked in the TypeScript alone, so a project keeping a fragment in a file of its own got an error saying its query throws. ([#966](https://github.com/nimbuscloud-ai/suss/pull/966))

## 0.24.3 (2026-09-08)

0.24.3 stops `check` reporting a query that works as one that throws.

### Fixes

- A GraphQL query that spreads a fragment the codegen preset registers is left alone. The client preset registers a fragment by writing it in a document of its own and inlines it by name, so nothing interpolates it; `check` read the query on its own, saw a spread with no definition, and reported that the query throws when it runs. On one React codebase that was 20 errors, every one of them wrong. A fragment written on its own in a `gql(...)` call now counts as registered, and a query that spreads a fragment nothing defines is still an error. ([#964](https://github.com/nimbuscloud-ai/suss/pull/964))

## 0.24.2 (2026-09-07)

0.24.2 fixes a Ruby service object that reported nothing, and a `setTimeout` that threw away a whole run.

### Fixes

- A Ruby service object's calls come back, however it keeps its connection. A class that builds its connection once in `def self.conn` and calls it from every request method used to report nothing, because the reader followed a name assigned in the same method and no further. It now reads what a method of that name in the same file comes back with, `@conn ||= Faraday.new(...)` included, and takes a base URL written as the first argument as well as under `url:`. On one Rails application with four vendor services, the calls it finds went from 4 to 12. ([#960](https://github.com/nimbuscloud-ai/suss/pull/960))
- A run with a `setTimeout` in it is readable again. Two packs give the function handed to `setTimeout` a unit of its own and the summary schema did not allow that kind, so `check` and `inspect` refused the whole file `extract` had written, and one such callback anywhere in a repository threw away the run. `check` also printed the reason it skipped a file up to the first newline, which is exactly where the reason starts. ([#958](https://github.com/nimbuscloud-ai/suss/pull/958))

## 0.24.0 (2026-09-07)

0.24.0 gives Python and Ruby a calling side, so `suss check` can compare what a service asks for against what the other side sends.

### A Python function that calls out over HTTP is a client of the route it calls

A FastAPI or Flask project used to report its own routes and its database calls, and nothing it reached, so `suss check` had no consumer side in Python at all. `@suss/client-requests` reads the calls requests gives a project, and a function that makes one comes back bound to the method and path it states:

```
GET /orders/{order_id}  (requests client | line 8)
```

That pairs with whatever serves the route in the same run: a route in the same project, a handler from another repository read into the same folder, or an OpenAPI document read with `suss contract`. The seven verb functions, `requests.request("PATCH", url)` and a `Session` all read the same way, and the URL goes through the same value evaluator a route's path does, so an f-string and a name defined elsewhere both resolve to the path they build. ([#933](https://github.com/nimbuscloud-ai/suss/pull/933))

### A Python caller says which statuses it handles, and `check` compares them

A function that calls another service and tests the response used to come back with one path and no conditions, so nothing could be compared against what the other side sends:

```python
def fetch_order(order_id: str):
    response = requests.get(f"{ORDERS_BASE}/orders/{order_id}")
    if response.status_code == 404:
        return None
    return response.json()
```

`suss check` now reports `Consumer expects status 404 but provider never produces it` when the route on the other side does not send one. The requests and httpx packs say which members of the response mean the status, the success flag and the body, and the caller's own body is walked the way a route's is. To pair the two sides the checker has to know which member a condition read and what it compared against, so Python conditions now record both, in a route as much as in a client. ([#939](https://github.com/nimbuscloud-ai/suss/pull/939))

### A Ruby condition says what it tests, and a Ruby caller says which statuses it handles

Every condition on a Ruby summary used to be the text it was written as, so nothing could read the status a guard names. A comparison, `nil?`, a member read and a negation each come out as themselves now, and a member read says the name it starts from and the members read off it. That is what the Faraday and Net::HTTP packs needed:

```ruby
response = conn.get("/orders/#{id}")
return nil if response.status == 404
```

Against a Rails action that never sends a 404, `suss check` now says `Consumer expects status 404 but provider never produces it`. Net::HTTP hands the status back as a string, and `response.code.to_i == 404` is read as a test on `code`. ([#941](https://github.com/nimbuscloud-ai/suss/pull/941))

### `check` warns when a queue that redelivers reaches a consumer that posts

An SQS queue that is not FIFO can deliver one message more than once, and a handler draining it that calls another service to create something makes that call again on the second delivery. That is the charge-twice bug:

```
[WARNING] repeatUnsafeConsumer
  SQS queue "OrdersQueue" can deliver one message more than once, and handler
  makes POST /v1/charges through stripe.charges.create while handling it. A
  second delivery makes that call again.
```

PUT, PATCH and DELETE land on the same resource twice, so they are left alone, and so is a FIFO queue. A call that sends an idempotency key is safe and still reported: a summary does not record the headers a call sends, and the finding says that it cannot tell. The consumer's call is found whether the pack recorded it as an effect, as the TypeScript clients do, or as a unit bound to the route it calls, as the Python and Ruby clients do. ([#949](https://github.com/nimbuscloud-ai/suss/pull/949))

### `inspect --diff` reports what changed at each boundary

The diff used to list the units that moved, a block each. A reviewer reading that learned a file gained a function, which the pull request's own diff shows better. The report now opens with the boundaries: what each route, consumer or Lambda responds with, and what a request reaches or stopped reaching through the calls it makes.

```
1 boundary changed: 1 outcome, 1 effect. 2 units inside the project also changed.

~ serves GET /orders/{id}  src/app.ts::show  (1 outcome, 1 effect)
  outcomes
    + responds 404 { error }  when  order == null
  effects
    + reads mongodb:orders  through loadOrder -> readOrder
```

An outcome that reached several routes from one filter, middleware or error handler is said once, above the blocks, with how far it reaches and which routes it missed:

```
From require_login  app/controllers/application_controller.rb
  + responds 401  when  session[:user_id].nil?
    at 14 of the 15 boundaries it runs on
    not at GET /health, which it also runs on
```

A route the filter covers that already responded the same way is not one of the exceptions, since nothing about it moved. A route on the second line is one where the filter runs and the outcome is still missing, and that is the line a reviewer checks.

A unit further down the call chain gets no block of its own, since the boundaries that reach it already show what its change did. Under the boundaries, the files with units that moved. A unit with a couple of lines to its name has them written out, one with more gets a count of the outcomes and the effects that moved, and one with a block of its own above is only named. A chain longer than three calls prints its first and last with `(2 intermediate units collapsed)` between them; `--chain full` prints every call and `--chain 0` prints none. Two more flags cap what the report costs: `--changed-files` takes the paths a change touched, one per line, so those files come last, and `--budget` stops the report at a number of characters and counts what it left out. The action passes both. ([#943](https://github.com/nimbuscloud-ai/suss/pull/943), [#944](https://github.com/nimbuscloud-ai/suss/pull/944))

### Fixes

- `suss init` suggests every pack, including the ones that shipped last week. The list it suggested from was a table somebody edited by hand, so the Python and Ruby client packs that arrived in 0.23.0 were never mentioned. Each pack now says which libraries it reads, and `init` matches your dependencies against that. ([#952](https://github.com/nimbuscloud-ai/suss/pull/952))
- `@suss/client-faraday` reads a request method on the Faraday module itself and on a connection `Faraday.new` built, so a Ruby service object comes back bound to the route it reaches. A connection built with `url: "https://api.example.com/v1"` serves its calls under `/v1`. Run it as `-f faraday` beside the rails pack. ([#934](https://github.com/nimbuscloud-ai/suss/pull/934))
- `-f httpx` and `-f aiohttp` cover the other two libraries a Python service calls out with, including a client or a session opened as a context manager. The Python binder now binds what `with X() as name` opens, and every name the adapter resolves goes through that binder. ([#935](https://github.com/nimbuscloud-ai/suss/pull/935))
- `-f net-http` covers Ruby's own HTTP client, in both the ways it is written: a module call such as `Net::HTTP.get(URI(...))`, and the longer form where a project builds a request object and sends it. `URI(...)` and `URI.parse(...)` belong to Ruby, so they sit in the value tables next to `File.join`. ([#936](https://github.com/nimbuscloud-ai/suss/pull/936))

### For contributors

**A pack says what it is, beside its own patterns.** `declares` on a pack gives its kind, the package it ships in, the libraries a project depends on for it to read anything, the sentence about what it reads, and any per-project config it needs. `suss init` reads that instead of a table in the CLI, and the pack tables on the [pack catalog](/packs/catalog) are generated from it by `npm run docs:packs`. Adding a pack used to mean three edits in three places, two of which failed quietly; `check:packs` now requires the declaration and `check:pack-tables` fails when the page has drifted from it. ([#952](https://github.com/nimbuscloud-ai/suss/pull/952))

**A package page reads like a package page.** What npm and jsdelivr render is the README, and several of ours had grown into design documents with no link back to the project. A README now says what the package does, how to install it, and what it produces, and the reference prose lives in `DESIGN.md` beside it, in the repository and out of the published tarball. `check:readmes` keeps every published package to that. ([#953](https://github.com/nimbuscloud-ai/suss/pull/953))

## 0.23.0 (2026-09-06)

0.23.0 makes a route report what the code around it responds with, in Ruby and in Python.

### A Rails action reports what its before_action filters respond with

A controller that writes `before_action :require_login` used to report only what the action's own body does, so a route behind a login check looked like it always returned 200.

Each filter method now gets a summary of its own, saying what it responds with and where it hands the request on, and every action it covers reports the two together: 401 under the filter's own test, and the action's outcomes under the negation of it. `only:`, `except:` and `skip_before_action` decide which actions a filter reaches, a filter written on `ApplicationController` reaches every controller that inherits it, and a `rescue_from ... with:` handler is reported on the paths that raise. Looking up a superclass by name follows Rails' autoloading now, so a base class in `app/controllers` is found; before this, only a file sitting directly under `app` was. ([#930](https://github.com/nimbuscloud-ai/suss/pull/930))

### A Python route reports what its dependencies, middleware and error handlers respond with

A FastAPI dependency that raises 401, an `@app.middleware("http")` that returns 429 and an `@app.exception_handler` that turns an error into a 500 used to be invisible from the route, and so did a flask-restx service's `@app.before_request` hook and `@api.errorhandler`.

Each now gets a summary of its own, `inspect` says which of them wrap the route, and the route's own transitions include theirs, each marked with where it came from. A dependency is read from the app or router construction, the decorator's `dependencies=[...]`, a parameter default and an `Annotated[...]` parameter alike, and a router's dependencies reach a route written on it from another file. A route whose whole body is one `return {"status": "ok"}` used to be reported without a response; it now reports the library's default status with that body. ([#923](https://github.com/nimbuscloud-ai/suss/pull/923))

## 0.22.4 (2026-09-06)

0.22.4 puts the behavior diff on a pull request, and pairs a handler with the OpenAPI document for its route.

### A GitHub Action posts the behavior diff on a pull request

Point a workflow at `nimbuscloud-ai/suss/.github/actions/inspect-diff@main` and it reads both sides of the pull request, runs `inspect --diff` over them, and posts one comment that it edits again on every push. The comment says which units changed behavior and how they changed, whether or not the pull request edited the lines they are on. It keeps both summary files as an artifact of the run.

The [action README](https://github.com/nimbuscloud-ai/suss/tree/main/.github/actions/inspect-diff) has a workflow to copy. Runs share suss's per-file cache, so reading the head costs about what the pull request touched, and if the workflow also runs when something lands on `main`, it reads each of those commits as it goes and a later pull request compares against what it already read. ([#916](https://github.com/nimbuscloud-ai/suss/pull/916))

### A handler is compared against the OpenAPI document for its route

A service with its own OpenAPI file and no client in the run used to come back from `suss check` as `Nothing was compared.`, with a note that the route was claimed by two files. The handler and the document are now paired on the route, so a status the code produces and the document does not declare is an error, and a response the document declares that no path produces is a warning. ([#915](https://github.com/nimbuscloud-ai/suss/pull/915))

### Fixes

- `inspect --diff` reports every caller of a route, and a narrowed branch as one line. Several clients of one route used to collapse to one entry, so a change to any of the others printed as no change; each client now pairs by its own name under the route, as `client:GET /pet/{petId}::getPetById`. A transition that kept its output and changed its guard prints as one `~` line with the guard before and the guard after. ([#914](https://github.com/nimbuscloud-ai/suss/pull/914), [#918](https://github.com/nimbuscloud-ai/suss/pull/918))
- Middleware and hooks the project builds itself reach the routes they wrap. A Hono middleware returned by a project factory such as `requireCaller({ header: "x-caller" })` used to be skipped, and a zod-openapi `defaultHook` given to the app constructor was never read, so every route's 401 or 400 was missing. A route's declared contract is compared against what the handler and its wrappers produce together, and a status spread into a route object's `responses` from a shared object is read as declared. ([#904](https://github.com/nimbuscloud-ai/suss/pull/904), [#906](https://github.com/nimbuscloud-ai/suss/pull/906), [#908](https://github.com/nimbuscloud-ai/suss/pull/908), [#909](https://github.com/nimbuscloud-ai/suss/pull/909))
- A Prisma implicit many-to-many has a boundary for its join table. `connect`, `disconnect` and `set` through such a relation used to go unrecorded, since the join table is not in the schema. ([#905](https://github.com/nimbuscloud-ai/suss/pull/905))

## 0.22.3 (2026-09-06)

0.22.3 gives a Rails action and a Python route one transition per branch, with the status each branch responds with.

### A Rails action reports what it responds with, on each branch

`render ..., status:`, `head` and `redirect_to` each set the status Rails sends, and an action that responds differently down two branches gets one transition per branch with the test that leads to it.

The routes file is read for `scope`, `namespace`, `controller:`, `path:`, nested and singular resources, and a bare verb inside a resource block. A helper an action calls by its bare name is followed into its own summary, and the methods Rails gives every controller are left off the effect list, so what remains is what the action reaches in the project. ([#881](https://github.com/nimbuscloud-ai/suss/pull/881), [#894](https://github.com/nimbuscloud-ai/suss/pull/894), [#895](https://github.com/nimbuscloud-ai/suss/pull/895))

### A Python route that raises reports the status it raises with

FastAPI's `HTTPException` and Flask's `abort` end a path with their status, so a route with a guard reports 404 under the guard and 200 under its negation. A SQLAlchemy session the handler takes as a parameter, builds with `Session()`, or gets from a helper is recognized, and a 2.0 `update(...).values(...)` is classified as a write. ([#884](https://github.com/nimbuscloud-ai/suss/pull/884), [#896](https://github.com/nimbuscloud-ai/suss/pull/896))

### For contributors

**A pack declares the calls that respond, and the adapter walks them.** `responseStatusCalls` on a Ruby `controllerActions` pattern or a Python route pattern says which calls end the request and where each takes its status. The adapter hands every one to the shared path engine as a terminal and builds one branch per path, the same walk the TypeScript adapter has always done, so a status reading and the effects that reach a branch come out per branch. `ambiguousReading` is gone from the Ruby adapter with nothing left to produce it. ([#895](https://github.com/nimbuscloud-ai/suss/pull/895), [#896](https://github.com/nimbuscloud-ai/suss/pull/896))

## 0.10.0 (2026-08-20)

0.10.0 spells a store, a bus and a metric the way OpenTelemetry's semantic conventions do, so a summary and a span say one boundary the same way.

### A store and a bus go by the name OpenTelemetry uses

A summary now says `postgresql` where it said `postgres`, `aws.dynamodb` where it said `dynamodb`, `aws_sqs` where it said `sqs`, and `aws.sns` where it said `sns`, which are the values a trace gives `db.system.name` and `messaging.system`. Summaries written before this read back with the new names, so nothing published has to be regenerated, and the format is at schema version 5.

Two things to update by hand: a suppression that says which bus (`bus:sqs order.placed` becomes `bus:aws_sqs order.placed`), and a `storageSystem` in pack config for `@suss/framework-sqlalchemy`, `@suss/framework-activerecord`, `@suss/framework-prisma` or `@suss/framework-drizzle`, where `postgres` becomes `postgresql`. ([#453](https://github.com/nimbuscloud-ai/suss/pull/453))

### A metric's measurement words are OpenTelemetry's

A summary now says `histogram` where it said `spread`, and `gauge`, `delta`, `cumulative` where it said `point`, `interval`, `sinceStart`. Those are the metrics data model's point kinds and aggregation temporalities, and Cloud Monitoring's own metric kinds spell the last three the same way. Summaries written before this read back with the new words, and the format is at schema version 6. Nothing needs updating by hand: no suppression rule or pack config spells these words. ([#472](https://github.com/nimbuscloud-ai/suss/pull/472))

### For contributors

**Each protocol says which of its words are OpenTelemetry's.** A boundary protocol module declares `semconv`, the attribute each identity field goes under, and `semconvAttributes(binding)` reads a binding as the attributes a span would state. A field is in that projection only when our value is the value a span gets, so `storage.accessPath`, a `"default"` scope and a `"*"` REST method stay out of it. Protocols nobody crosses at run time, `function-call` and `metric` among them, declare an empty mapping, and the compiler makes a new protocol answer the question. [Boundary semantics](/theory/boundary-semantics#where-the-words-come-from) has the table.

## 0.5.0 (2026-08-14)

0.5.0 follows a Python or Ruby handler into the database work behind it, and reports what each route's body does.

### Both languages classify database calls

`@suss/framework-sqlalchemy` and `@suss/framework-activerecord` compose onto whichever route pack a run already uses. Python matches a query by what the method behind the call says it returns, which reads through a project's own base class; Ruby matches by what the receiver's class inherits, which reads through `ApplicationRecord`.

A chain like `Model.query().filter_by(id=x).first()` is one read, saying which model, which rows (`selector`) and which columns (`fields`). A handler that hands off to a service function reports the call, and the service function's own summary reports the work, so `suss ask "what does GET /orders reach"` follows the call and `why does` says which function the work is in. ([#284](https://github.com/nimbuscloud-ai/suss/pull/284), [#287](https://github.com/nimbuscloud-ai/suss/pull/287), [#289](https://github.com/nimbuscloud-ai/suss/pull/289), [#292](https://github.com/nimbuscloud-ai/suss/pull/292))

### A Python route mounted through a shared framework package reports its path

The chain many production Flask services use, an entry file handing a loader object to a library function, the loader returning a written-out list of namespaces, a loop mounting whatever comes back, is followed the whole way. That took a class becoming a value containing its methods, an argument reaching the parameter it is passed to, and imports written inside functions being read. On two measured services every route now has its full path where none did.

### Fixes

- A Python route reports what its body does. Each return is a branch with its status and the conditions that reach it, and the calls a body makes are invocation effects with the conditions that gate each one. A route that declares no response keeps a transition anyway, so the work has somewhere to be recorded. ([#283](https://github.com/nimbuscloud-ai/suss/pull/283))
- Gap messages point at the thing. A mounted list declined over one unmatched entry says which entry, what it resolved to, and that the rest matched. A body the path engine declines keeps its route, path and method, and says what was declined, the budget cap included. ([#294](https://github.com/nimbuscloud-ai/suss/pull/294))
- A handler with a run of guards reports one transition where it reported many. Two paths that differ only over a branch they both pass through become one, in the engine, for every language. The two handlers that used to lose everything to the path budget no longer come near it.

### For contributors

**Every adapter runs the same fact contract.** `@suss/resolution` ships six executable cases stating how a fact has to be keyed, each adapter supplies its own source per case, and none declares a known gap. The kit caught three bugs on its first Ruby run that had already been fixed in Python and never carried across, and one mistake in itself.

**The rule profiler is the tool for slow extractions.** A CPU profile bottoms out at `unify` and `lookup` and cannot say which rule asked for the work; `profileEvaluationAsync` charges time and tuples to each rule. It found a join that derived 30k demand tuples to produce 224 rows, and an index that built a string out of every node id on every lookup. The measured extract went from 25.2s to 4.2s across three changes, and three plausible optimisations were measured slower and written down so nobody redoes them.

**Containment with inheritance is its own relation.** Deriving into `holdsProperty` turns a stated fact into a derived one, and the on-demand rewrite gates it behind demand nothing generates. `contains` reads `holdsProperty` and adds what a base class declares.

**A version bump no longer breaks the workspace.** `preparePublish` left sibling `devDependencies` pinned at the old version, so npm fetched them from the registry instead of linking the workspace. They are `*` now.

**A new package has a checklist.** The coverage list, the packages table, the doc counts, a LICENSE force-added past the gitignore rule, and a trusted publisher on npm before the release workflow can push it, bootstrapped with a prerelease under a non-latest tag.
