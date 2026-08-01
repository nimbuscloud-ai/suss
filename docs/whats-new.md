# What's new

The latest round of changes, in two passes: what it means if you use suss, and what it means if you work on it.

## If you use suss

**A gap now says whose problem it is.** Two kinds, and the checker treats them differently. An `unhandledCase` is about the code: the contract declares a 500 the handler never produces, or the handler produces a 418 the contract never declared. That comes out as a contract violation at error severity. An `unreadOutcome` is about the reading: a `return` matched none of the terminal shapes the pack looks for. That comes out at info, because the handler may be answering correctly in a shape nobody taught the pack. Confidence follows the same signal. One return suss could not read drops the summary to `low`, where counting predicates used to score it `high`.

**More frameworks read out of the box.** Nineteen packs ship. Hono, Next.js and Drizzle joined since the last round, alongside Express, Fastify, ts-rest, NestJS REST and GraphQL, Apollo Server, AWS Lambda, React, React Router, fetch, axios, Apollo Client, Prisma, SQS, EventBridge and the Node runtime surface. [Packages and packs](/reference/packages) has the table.

**GraphQL operations can come from files.** A repo that keeps its queries in `.graphql` documents no longer needs its call sites traced:

```bash
suss contract --from graphql schema.graphql -o summaries/schema.json
suss contract --from graphql-documents src/queries -o summaries/operations.json
suss check --dir summaries/
```

Each operation becomes a client-kind summary and pairs against the resolvers the same way a traced call site does. Fragment spreads are inlined across the whole read set.

**Summaries state conditions that match the code.** Nested guard clauses, returns inside loops, and early exits in `else` branches used to produce a transition whose conditions didn't line up. The condition engine was rebuilt around one rule: every path through a function becomes its own transition, carrying exactly the conditions that gate it. Where a fact isn't statically knowable (did the loop exit early? which statement threw?), the summary says so instead of guessing.

**Boundaries show what they reach.** A handler that calls a helper that calls `audit.log` carries that fact on the handler itself, as `metadata.effectsClosure`. Each entry is flagged direct or inherited from a callee. You can see what a route depends on without walking the call chain.

**There's a new experimental command, `suss corroborate`.** It extracts as usual, then runs each handler in a sandbox with inputs built from the handler's own conditions, and checks whether the code does what the summary claims. Claims come back *observed*, *refuted* with the exact input that broke them, or *untested*. It sits behind an `--experimental` flag while the scope is narrow: Express and Fastify handlers with literal status codes. See the [CLI reference](reference/cli.md).

## If you contribute to suss

**One condition engine.** The path engine (`paths/pathConditions.ts`) enumerates entry-to-terminal paths over the whole structured statement language: `if`/`else`, `switch`, loops, `try`/`catch`, `break`/`continue`. The collectors it replaced are deleted. On the few shapes the engine declines (labeled statements, exiting `finally` blocks, a handful of `switch` edge cases), transitions degrade to their enclosure conditions plus an explicit "unmodeled control flow" marker, so they abstain rather than assert something unfounded. [`extraction-algorithm.md`](extraction-algorithm.md) describes the engine as it stands.

**Whole-program analyses are rules over facts.** Extraction emits small facts ("A calls B", "B carries this effect", "C throws this") into one shared database per run, and short declarative rules derive the answers: reachability, transitive re-throw sources, per-boundary effect closures. The engine is `@suss/datalog`, small and dependency-free. Termination and stratification are its problem, proven once; a new analysis is a set of facts plus a few rules, reviewable as data. The rules never touch the AST, so a future second-language adapter only has to emit the same facts to inherit every analysis. [`internal/facts-and-rules.md`](internal/facts-and-rules.md) is the working manual, including the checklist for adding an analysis.

**Resolution rules moved into their own package.** `@suss/resolution` holds the rules for following a value to the function it comes down to, and nothing else. No parser, no language, no files. They compose one hop at a time, so a factory handing off to another factory, or a barrel re-exporting a wrapper, resolves without a rule naming that shape. An adapter reads source into facts and inherits the lot. When an answer comes back empty, suspect the facts before the rules.

**Nothing here is taken on faith.** A differential fuzzer (`tools/differential`) generates thousands of random handler programs and React components, extracts them through the pipeline, executes them, and fails the build if a summary ever claims something execution disproves. Every soundness gap it has found is pinned in a permanent corpus, and every gap that gets fixed flips its pin into a regression test. [`internal/differential-fuzzing.md`](internal/differential-fuzzing.md) has the full protocol.
