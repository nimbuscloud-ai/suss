# What's new

The latest round of changes, in two passes: what it means if you use suss, and what it means if you work on it.

## If you use suss

Three things changed, all in the direction of summaries you can trust more.

**Summaries are more honest and more complete.** suss used to occasionally state a condition that wasn't quite right — nested guard clauses, returns inside loops, and early exits in `else` branches could produce a transition whose conditions didn't match the code. The condition engine was rebuilt around a simple rule: every real path through a function becomes its own transition, with exactly the conditions that gate it. Where a fact isn't statically knowable (did the loop exit early? which statement threw?), the summary now says "can't tell" instead of guessing. Honest abstention over confident error, everywhere.

**Boundaries now show what they ultimately touch.** A handler that calls a helper that calls `audit.log` now carries that fact on the handler itself, as `metadata.effectsClosure` — every side effect reachable behind the boundary, with a flag for whether it's direct or inherited from a callee. You can see what a route really depends on without walking the call chain yourself.

**There's a new experimental command: `suss corroborate`.** It extracts as usual, then actually runs each handler in a sandbox with inputs built from the handler's own conditions, and checks whether the code does what the summary claims. Claims come back *observed*, *refuted* (with the exact input that broke them), or *untested*. It's behind an `--experimental` flag while the scope is narrow — Express/Fastify handlers with literal status codes. See the [CLI reference](reference/cli.md) for details.

## If you contribute to suss

Two structural changes shape how the codebase works now.

**One condition engine.** The path engine (`paths/pathConditions.ts`) enumerates entry-to-terminal paths over the whole structured statement language — `if`/`else`, `switch`, loops, `try`/`catch`, `break`/`continue`. The old collectors it replaced are deleted, not kept as a fallback: on the rare shapes the engine declines (labeled statements, exiting `finally` blocks, a few `switch` edge cases), transitions degrade to their enclosure conditions plus an explicit "unmodeled control flow" marker rather than falling back to code that was sometimes wrong. [`extraction-algorithm.md`](extraction-algorithm.md) describes the engine as it is today.

**Whole-program analyses are rules over facts, not hand-written loops.** Extraction emits small facts — "A calls B", "B carries this effect", "C throws this" — into one shared database per run, and short declarative rules (a tiny Datalog engine, `@suss/datalog`) derive the answers: reachability, transitive re-throw sources, per-boundary effect closures. Termination and stratification are the engine's problem, proven once; a new analysis is a set of facts plus a few rules, reviewable as data. The rules never touch the AST — which also means a future second-language adapter only has to emit the same facts to inherit every analysis. [`internal/facts-and-rules.md`](internal/facts-and-rules.md) is the working manual, including the checklist for adding an analysis.

None of this is taken on faith. A differential fuzzer (`tools/differential`) generates thousands of random handler programs and React components, extracts them through the real pipeline, executes them, and fails the build if a summary ever claims something execution disproves. Every soundness gap it has found is pinned in a permanent corpus; every gap that gets fixed flips its pin into a regression test. [`internal/differential-fuzzing.md`](internal/differential-fuzzing.md) has the full protocol.
