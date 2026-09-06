---
title: What is new in suss
description: The latest round of changes, first what they mean if you use suss and then what they mean if you work on it.
---

# What's new

The latest round of changes, in two passes: what it means if you use suss, and what it means if you work on it.

## If you use suss

**A Rails action reports what it responds with, on each branch.** `render ..., status:`, `head` and `redirect_to` each set the status Rails sends, and an action that responds differently down two branches gets one transition per branch with the test that leads to it. The routes file is read for `scope`, `namespace`, `controller:`, `path:`, nested and singular resources, and a bare verb inside a resource block. A helper an action calls by its bare name is followed into its own summary, and the methods Rails gives every controller are left off the effect list, so what remains is what the action reaches in the project.

**A Python route that raises reports the status it raises with.** FastAPI's `HTTPException` and Flask's `abort` end a path with their status, so a route with a guard reports 404 under the guard and 200 under its negation. A SQLAlchemy session the handler takes as a parameter, builds with `Session()`, or gets from a helper is recognized, and a 2.0 `update(...).values(...)` is classified as a write.

**A metric's measurement words are OpenTelemetry's.** A summary now says `histogram` where it said `spread`, and `gauge`, `delta`, `cumulative` where it said `point`, `interval`, `sinceStart`. Those are the metrics data model's point kinds and aggregation temporalities, and Cloud Monitoring's own metric kinds spell the last three the same way. Summaries written before this read back with the new words, and the format is at schema version 6. Nothing needs updating by hand: no suppression rule or pack config spells these words.

**A store and a bus go by the name OpenTelemetry uses.** A summary now says `postgresql` where it said `postgres`, `aws.dynamodb` where it said `dynamodb`, `aws_sqs` where it said `sqs`, and `aws.sns` where it said `sns`, which are the values a trace gives `db.system.name` and `messaging.system`. Summaries written before this read back with the new names, so nothing published has to be regenerated, and the format is at schema version 5. Two things to update by hand: a suppression naming a bus (`bus:sqs order.placed` becomes `bus:aws_sqs order.placed`), and a `storageSystem` in pack config for `@suss/framework-sqlalchemy`, `@suss/framework-activerecord`, `@suss/framework-prisma`, or `@suss/framework-drizzle`, where `postgres` becomes `postgresql`.

**A Python route mounted through a shared framework package reports its path.** The chain many production Flask services use, an entry file handing a loader object to a library function, the loader returning a written-out list of namespaces, a loop mounting whatever comes back, is followed the whole way. That took a class becoming a value containing its methods, an argument reaching the parameter it is passed to, and imports written inside functions being read. On two measured services every route now has its full path where none did.

**A Python route reports what its body does.** Each return is a branch with its status and the conditions that reach it, and the calls a body makes are invocation effects with the conditions that gate each one. A route that declares no response keeps a transition anyway, so the work has somewhere to be recorded.

**Both languages classify database calls.** `@suss/framework-sqlalchemy` and `@suss/framework-activerecord` compose onto whichever route pack a run already uses. Python matches a query by what the method behind the call says it returns, which reads through a project's own base class; Ruby matches by what the receiver's class inherits, which reads through `ApplicationRecord`. A chain like `Model.query().filter_by(id=x).first()` is one read, saying which model, which rows (`selector`) and which columns (`fields`). A handler that hands off to a service function reports the call, and the service function's own summary reports the work, so `suss ask "what does GET /orders reach"` follows the call and `why does` says which function the work is in.

**Gap messages point at the thing.** A mounted list declined over one unmatched entry says which entry, what it resolved to, and that the rest matched. A body the path engine declines keeps its route, path and method, and says what was declined, the budget cap included.

**A handler with a run of guards reports one transition where it reported many.** Two paths that differ only over a branch they both pass through become one, in the engine, for every language. The two handlers that used to lose everything to the path budget no longer come near it.

## If you contribute to suss

**A pack declares the calls that respond, and the adapter walks them.** `responseStatusCalls` on a Ruby `controllerActions` pattern or a Python route pattern says which calls end the request and where each takes its status. The adapter hands every one to the shared path engine as a terminal and builds one branch per path, the same walk the TypeScript adapter has always done, so a status reading and the effects that reach a branch come out per branch. `ambiguousReading` is gone from the Ruby adapter with nothing left to produce it.

**Each protocol says which of its words are OpenTelemetry's.** A boundary protocol module declares `semconv`, the attribute each identity field goes under, and `semconvAttributes(binding)` reads a binding as the attributes a span would state. A field is in that projection only when our value is the value a span gets, so `storage.accessPath`, a `"default"` scope, and a `"*"` REST method stay out of it. Protocols nobody crosses at run time, `function-call` and `metric` among them, declare an empty mapping, and the compiler makes a new protocol answer the question. [Boundary semantics](/boundary-semantics#where-the-words-come-from) has the table.

**Every adapter runs the same fact contract.** `@suss/resolution` ships six executable cases stating how a fact has to be keyed, each adapter supplies its own source per case, and none declares a known gap. The kit caught three bugs on its first Ruby run that had already been fixed in Python and never carried across, and one mistake in itself.

**The rule profiler is the tool for slow extractions.** A CPU profile bottoms out at `unify` and `lookup` and cannot say which rule asked for the work; `profileEvaluationAsync` charges time and tuples to each rule. It found a join that derived 30k demand tuples to produce 224 rows, and an index that built a string out of every node id on every lookup. The measured extract went from 25.2s to 4.2s across three changes, and three plausible optimisations were measured slower and written down so nobody redoes them.

**Containment with inheritance is its own relation.** Deriving into `holdsProperty` turns a stated fact into a derived one and the on-demand rewrite gates it behind demand nothing generates. `contains` reads `holdsProperty` and adds what a base class declares.

**A version bump no longer breaks the workspace.** `preparePublish` left sibling `devDependencies` pinned at the old version, so npm fetched them from the registry instead of linking the workspace. They are `*` now.

**A new package has a checklist.** The coverage list, the packages table, the doc counts, a LICENSE force-added past the gitignore rule, and a trusted publisher on npm before the release workflow can push it, bootstrapped with a prerelease under a non-latest tag.
