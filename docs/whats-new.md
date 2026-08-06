# What's new

The latest round of changes, in two passes: what it means if you use suss, and what it means if you work on it.

## If you use suss

**A boundary the code does not name is a recorded fact.** `sqs.sendMessage({ QueueUrl: queueUrl })` names its queue at runtime, not in the source. suss used to drop sends like that or record them under an empty name that paired with nothing and confused everything downstream. Now the send is recorded with a `null` channel, and the unused-queue finding includes the count: "3 sends in scope name the queue at runtime and could target it" rather than a flat claim that nothing produces to the queue. An empty string no longer stands for a state: the channel field holds a name or `null`.

**A handler for every method pairs like one.** A route declared for every method (NestJS's `@All()`) records its method as `"*"`, and a client's `GET` against the same path pairs with it by agreement instead of failing to match a literal `ALL`.

**Summaries record their schema version.** Every summary file now has a `schemaVersion` field. Files written before the field existed still load; every parse entry point upgrades them on the way in.

**A cached run produces the same output as a cold one.** Two cache bugs are fixed: the extraction cache could return results from code that had changed, and a cached run could produce different summary names than the run that filled the cache.

**suss reads a deployment split across nested stacks.** A handler declared in a child template is found and named by the stack path that reaches it, a Lambda referenced through `Fn::GetAtt` resolves, and config reads are picked up in every spelling, including reads that happen when a module loads.

**A summary lists what a unit reads out of what it was given.** Each input (a parameter, a destructured field, a hook return) now also records the property paths the unit reads from it, so a reader can see that a handler uses `body.status` without opening the code.

## If you contribute to suss

**One protocol, one module.** Each boundary semantics variant lives in its own file under `packages/ir-core/src/semantics/`, declaring its schema and its behavior: what identifies a boundary, what buckets two sides for pairing, and what agreement means inside a bucket. A registry composes them with a compile-time completeness check, and the checker's pairing engine dispatches through it. Adding a boundary type means adding a module, not editing the pairing engine.

**The checker sits under the fuzzer too.** The differential fuzzer used to verify extraction only: generate a random program, extract it, execute it, compare. It now also runs the checker over every generated scenario and fails the build when a finding contradicts what execution shows. Gaps it finds are pinned in a permanent corpus, and a fixed gap flips its pin into a regression test.

**Metadata namespaces are becoming schemas.** The metadata a contract reader writes and a checker reads back used to be a convention held up by hand-written casts on both sides. The first namespace (`messageBus`) now ships as one schema both sides import. Writes are strict and throw next to their cause. Reads validate field by field, so one stale field in an old artifact drops alone instead of taking the whole namespace down with it. The remaining namespaces follow the same shape.

**Four working proposals are in the tree.** `docs/internal/proposals/` holds the programs the last dispatched review distilled: typed claims, one primitive per concept, resolution in context, and check the checker. Each says what it replaces and lands in slices.
