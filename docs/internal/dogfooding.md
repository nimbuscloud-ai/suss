# Dogfooding: suss on suss

What happens when you run suss against its own source. The goal
isn't a shipping report — it's the "sit in the user's chair"
exercise of asking "I have a TypeScript codebase, I want
summaries, what happens?"

This doc captures what worked, what didn't, and what the
experience surfaces about the pack interface. The reproducer
lives in [`scripts/dogfood.mjs`](https://github.com/nimbuscloud-ai/suss/blob/main/scripts/dogfood.mjs); run it
with `node scripts/dogfood.mjs` (after `npm run build`).

## Setup

The script uses the programmatic adapter (not the CLI) because
half the value is feeling the in-process API. It runs three
experiments, each pointed at a different workspace:

- **`packages/checker`** — a pure-TypeScript utility module
  surface. No framework, no web server, just functions exported
  from a library.
- **`packages/cli`** — argv-dispatch + command runners. The
  closest thing suss has to an "entry point" shape.
- **`packages/framework/apollo`** — a pack definition. Declarative
  data, one factory function.

Each experiment runs a hand-rolled dogfood pack — `namedExport`
discovery with a list of "likely function names" (`checkAll`,
`checkPair`, `pairSummaries`, …). No existing shipped pack matches
suss's internals, so the pack is built inline in the script.

## What I saw

### Pure-TS library surface (`@suss/checker`)

Six summaries emerged. Confidence `high` on all of them; zero
opaque predicates across four conditions:

```
- handler pairGraphqlOperations  (2 transitions, 1 input)
- handler checkPair              (1 transition,  2 inputs)
- handler checkAll               (1 transition,  1 input)
- handler pairSummaries          (1 transition,  1 input)
- handler pairGraphqlOperations  (2 transitions, 1 input)   ← duplicate
- handler pairSummaries          (1 transition,  1 input)   ← duplicate
```

The analysis worked — functions were discovered, branches were
tracked, terminals were captured. Two duplicates appeared because
the `namedExport` matcher found each function at both its
originating module AND the barrel re-export in `index.ts`. The
adapter's dedup key (function node + kind) doesn't collapse them
because they're *different* function nodes (re-exports are
separate symbols).

**Finding 1 — re-export dedup.** The adapter's dedup key is
`(startOffset, endOffset, kind)`. Re-exports point at the original
function so offsets match, but `getExportedDeclarations` yields
both the re-export site AND the original; our namedExport walk
visits each. Fix would be to dedupe by the resolved symbol
identity (the underlying declaration), not the re-export location.

### CLI dispatch (`@suss/cli`)

Zero summaries. None of the canned names (`checkAll`, `checkPair`,
…) appear in the CLI. The CLI's surface is `runCli(argv)` plus
internal command handlers (`check`, `extract`, `inspect`, `stub`,
`run`) — all shapes our dogfood pack didn't look for.

**Finding 2 — `namedExport` requires knowing the names.** A pack
author has to enumerate entry-point names up front. That works
for framework conventions (ts-rest's `loader`/`action`, Apollo's
`ApolloServer`), but falls flat on arbitrary libraries where the
"interesting" functions aren't conventionally named.

The gap is: "discover every exported function." A new
`DiscoveryMatch` variant — `allExports` or a regex over export
names — would fill it. That's small scope; open question is
whether it's useful beyond dogfooding or whether it surfaces so
much noise that it's counterproductive.

### Pack data (`@suss/framework-apollo`)

One summary: the `apolloFramework()` factory. The pack's
declarative `discovery` / `terminals` / `inputMapping` data
produces no code units because it's data, not code. Expected, but
revealing.

**Finding 3 — declarative-data modules are invisible.** suss
models *function-shaped code at boundaries*. A pack definition has
no runtime-scheduling surface suss can recognise. That's correct!
But it means 5 out of 19 workspace packages (the packs
themselves) produce near-nothing under analysis. A downstream
tool that wanted "every unit in the repo" couldn't use suss to
enumerate them.

## What this tells us

### The current pack story is framework-first by design

suss's packs describe boundaries — where your code meets the
outside world. Pure-library modules and declarative-data modules
don't have boundaries in that sense; they're internal
implementation. The ts-rest pack knows about `.router(...)`; the
React pack knows about JSX + `useEffect`; there's no
"arbitrary TS function" pack because every exported function
isn't structurally a boundary.

That framing is the right one for the tool's positioning
(behavioral understanding at boundaries), but it does mean:

- **The "discover every function" use case is out of scope by
  construction.** Documentation-generation tooling that wants
  function-level summaries for a library would need to bring
  its own pack. suss's API and IR support this (the adapter
  handles `namedExport`; the summary format is kind-agnostic);
  what's missing is the "allExports" / regex-named discovery
  primitive.

- **Packs validate themselves by being invisible to the tool.**
  That's actually a useful property — a pack that produces no
  summaries against real framework code means something's wrong
  with the pack. Against suss's own code, though, it means the
  pack is correctly doing nothing.

### The adapter is mostly sound; the pack surface has ergonomic gaps

The three findings above cluster into two categories:

| Category         | Example                                           | Priority |
|------------------|---------------------------------------------------|----------|
| Semantic gap     | Re-export dedup by resolved symbol                | medium   |
| Pack ergonomics  | No "all exports" or regex-named discovery         | low      |
| Framing limit    | Declarative-data modules have no summaries        | wontfix  |

The first one is a concrete code change with a clear test (a
module that re-exports a function should yield one summary, not
two). The second one is a feature wish. The third is a property.

### The in-process API felt clean

Building an ad-hoc pack inline, constructing the adapter, calling
`extractAll()` — the API read naturally. The only rough edge was
the `PatternPack` type's required `languages` / `discovery` /
`terminals` / `inputMapping` fields, which all need to be
provided even for a dogfood pack that doesn't care about several
of them. Defaults on the pack type (or a `partialPack` builder)
would reduce the boilerplate.

## What didn't go wrong

Things I expected to see and didn't:

- **No opaque predicates in the checker surface.** Every
  condition the analyzer encountered decomposed cleanly. That
  includes comparisons, property accesses, and calls —
  confidence `high` across all six summaries. Not a guarantee;
  the checker's code uses shapes suss already understands.
- **No crashes on re-exports, barrel files, or type-only
  imports.** The ts-morph-backed discovery is resilient to
  import patterns we didn't explicitly design for.
- **Fast.** Three full-workspace extractions in under a second.
  No performance surprises.

## Follow-ups tracked

Not landing these in this dogfood pass; they go on the backlog:

1. Fix re-export dedup by resolved symbol (Finding 1)
2. Add `allExports` / regex-named `DiscoveryMatch` (Finding 2)
3. Document the "packs are framework-specific" framing
   prominently enough that users don't expect arbitrary-library
   coverage (Finding 3 — partly a docs fix, partly a scope
   statement)
4. Consider defaults for `PatternPack` to reduce scaffolding
   friction for ad-hoc usage (ergonomic)

Each is small; none blocks the primary arc. The exercise worked —
using the tool against its own source surfaced things the unit
tests wouldn't, and all three findings are concrete.
