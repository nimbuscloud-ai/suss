# What's new

The latest round of changes, in two passes: what it means if you use suss, and what it means if you work on it.

## If you use suss

**A store and a bus go by the name OpenTelemetry uses.** A summary now says `postgresql` where it said `postgres`, `aws.dynamodb` where it said `dynamodb`, `aws_sqs` where it said `sqs`, and `aws.sns` where it said `sns`, which are the values a trace gives `db.system.name` and `messaging.system`. Summaries written before this read back with the new names, so nothing published has to be regenerated, and the format is at schema version 5. Two things to update by hand: a suppression naming a bus (`bus:sqs order.placed` becomes `bus:aws_sqs order.placed`), and a `storageSystem` in pack config for `@suss/framework-sqlalchemy`, `@suss/framework-activerecord`, `@suss/framework-prisma`, or `@suss/framework-drizzle`, where `postgres` becomes `postgresql`.

**A Python route mounted through a shared framework package reports its path.** The chain many production Flask services use, an entry file handing a loader object to a library function, the loader returning a written-out list of namespaces, a loop mounting whatever comes back, is followed the whole way. That took a class becoming a value containing its methods, an argument reaching the parameter it is passed to, and imports written inside functions being read. On two measured services every route now has its full path where none did.

**A Python route reports what its body does.** Each return is a branch with its status and the conditions that reach it, and the calls a body makes are invocation effects with the conditions that gate each one. A route that declares no response keeps a transition anyway, so the work has somewhere to be recorded.

**Both languages classify database calls.** `@suss/framework-sqlalchemy` and `@suss/framework-activerecord` compose onto whichever route pack a run already uses. Python matches a query by what the method behind the call says it returns, which reads through a project's own base class; Ruby matches by what the receiver's class inherits, which reads through `ApplicationRecord`. A chain like `Model.query().filter_by(id=x).first()` is one read, saying which model, which rows (`selector`) and which columns (`fields`). A handler that hands off to a service function reports the work that function does, and `origin` on the effect says where it happens so a reader can go there.

**Gap messages point at the thing.** A mounted list declined over one unmatched entry says which entry, what it resolved to, and that the rest matched. A body the path engine declines keeps its route, path and method, and says what was declined, the budget cap included.

**A handler with a run of guards reports one transition where it reported many.** Two paths that differ only over a branch they both pass through become one, in the engine, for every language. The two handlers that used to lose everything to the path budget no longer come near it.

## If you contribute to suss

**Each protocol says which of its words are OpenTelemetry's.** A boundary protocol module declares `semconv`, the attribute each identity field goes under, and `semconvAttributes(binding)` reads a binding as the attributes a span would state. A field is in that projection only when our value is the value a span gets, so `storage.accessPath`, a `"default"` scope, and a `"*"` REST method stay out of it. Protocols nobody crosses at run time, `function-call` and `metric` among them, declare an empty mapping, and the compiler makes a new protocol answer the question. [Boundary semantics](/boundary-semantics#where-the-words-come-from) has the table.

**Every adapter runs the same fact contract.** `@suss/resolution` ships six executable cases stating how a fact has to be keyed, each adapter supplies its own source per case, and none declares a known gap. The kit caught three bugs on its first Ruby run that had already been fixed in Python and never carried across, and one mistake in itself.

**The rule profiler is the tool for slow extractions.** A CPU profile bottoms out at `unify` and `lookup` and cannot say which rule asked for the work; `profileEvaluationAsync` charges time and tuples to each rule. It found a join that derived 30k demand tuples to produce 224 rows, and an index that built a string out of every node id on every lookup. The measured extract went from 25.2s to 4.2s across three changes, and three plausible optimisations were measured slower and written down so nobody redoes them.

**Containment with inheritance is its own relation.** Deriving into `holdsProperty` turns a stated fact into a derived one and the on-demand rewrite gates it behind demand nothing generates. `contains` reads `holdsProperty` and adds what a base class declares.

**A version bump no longer breaks the workspace.** `preparePublish` left sibling `devDependencies` pinned at the old version, so npm fetched them from the registry instead of linking the workspace. They are `*` now.

**A new package has a checklist.** The coverage list, the packages table, the doc counts, a LICENSE force-added past the gitignore rule, and a trusted publisher on npm before the release workflow can push it, bootstrapped with a prerelease under a non-latest tag.
