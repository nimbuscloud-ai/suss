# Strategy review, July 2026

State of the project measured against its stated goals, and the
shortest defensible path to external users. It goes through where the
architecture and philosophy stand, where the code diverges from the
strategy, and then a sequenced recommendation with explicit decision
points. Everything here cites the doc or package it comes from.

## Verdict in three sentences

The architecture is coherent and the philosophy is now written down;
the intent layer gives suss a differentiated story no adjacent tool
has. What blocks us strategically is distribution rather than
capability: nothing is published, so every tutorial, README
instruction, and CI snippet describes a product no one can install. Close the loop that
exists (publish + finish PRD coverage + one audience-named demo)
before widening it (new packs, new protocols, new adapters).

## What the project claims to be

From `architecture.md`, `contracts.md`, `motivation.md`, and the
positioning decision: a **behavioral understanding platform**. The
summary is the product; checkers, inspect, and the intent layer are
consumers of it. Explicitly not a linter. The long-term arc
(`backlog.md`, "the Jackson arc") runs intent specs → workflow
intent → concept declarations → observation adapters: progressively
richer statements of *what was meant*, each checkable against *what
shipped*.

The scope split is settled: OSS owns single-repo, single-moment
primitives; cross-repo, temporal, and org-level features are product
scope.

## Philosophy: consistent, and now stated

These design principles recur across the shipped code. They are worth
naming because new work should be checked against them:

1. **The summary is the product.** Downstream tools consume IR, never
   ASTs or source. Everything serializes.
2. **Severity follows epistemic character** (`contracts.md`): a
   derivation that violates a specification is an error, an
   observation is weaker, and two specifications that disagree get a
   reconcile.
3. **Open vs closed specifications.** Intent docs declare the floor
   (what must exist), and code that exceeds them is info. Schema
   contracts (OpenAPI) are closed enumerations, and code that exceeds
   them is a violation.
4. **Pending vs broken.** A state declared before we could check it
   (unlinked scenario, unkeyable boundary) is valid and gets surfaced
   at low severity, while a malformed artifact is a load-time error.
   Nothing is ever silently skipped: checkers report checked and
   unchecked accounting, not findings alone.
5. **Degradation is explicit.** Opaque predicates, gaps, and
   confidence levels say "we don't know" rather than fabricating.
6. **Packs are data; the adapter owns the language; runtimes own
   their built-ins.** Ownership rules in `architecture.md`.
7. **Checkers are pure IR-only functions; the CLI is the
   dispatch point.** No checker depends on another.

All of these are true across the behavioural and intent layers today.
The known violations are listed as debts below. None of them are
philosophical conflicts; every one is unfinished mechanics.

## Strategic issues, ranked

### 1. Distribution: the product cannot be installed

Every package is `"private": true`, version 0.0.1, no
`publishConfig`. The README, both tutorials, and the CI guide
instruct `npm install @suss/cli`, which fails. The only working
path is clone + build + `node packages/cli/dist/index.js`. Secondary
drift compounds it: the petstore Makefile still calls the removed
`suss stub` command, and the README documents a `-i` flag `suss
contract` doesn't have.

This gates everything else. No demo, blog post, or dogfood result
converts into a user without an install path. It is also the
cheapest item on this list: the packages already have publish
metadata, licenses, and READMEs.

Decisions needed: npm scope availability (`@suss` may be taken;
verify, and have a fallback), versioning workflow (changesets vs
manual), and whether all 30 packages publish or only the consumer
surface (recommendation: all, because packs are the extension story
and they are already set up for it).

### 2. The wedge: who is the first user, doing what

Per the demo-gating rule every feature needs a named beneficiary in a
named setting. The project supports three candidate wedges today:

- **(a) Frontend ↔ backend drift**: the anatomy-of-an-integration-bug
  story. We can demo it now (petstore example, Express/React
  fixtures). Audience: full-stack teams without shared types. The
  adjacent space is crowded (typed clients and OpenAPI generators
  solve the 80% case).
- **(b) Intent → code verification for AI-generated code**: the
  intent layer's story. An agent writes code from a spec, and suss
  checks structurally that the spec was satisfied, before review.
  Audience: teams running AI codegen at volume (including agent
  harnesses themselves). No incumbent does this. It is the
  "verification is the bottleneck" argument from the intent proposal,
  and the market is forming right now.
- **(c) Package-boundary drift inside monorepos**: the dogfood
  machinery (packageExports / packageImport pairing). Audience:
  platform teams in large TS monorepos. The pain exists, but
  discovery gaps (member-call chains, namespace imports) are known
  and bite production code first.

Recommendation: **(b) as the headline, (a) as the on-ramp.** (b) is
the differentiated story and matches the moment. (a) is the
five-minute demo that doesn't require a team to author intent before
seeing value. (c) waits, because its extraction gaps make first
impressions risky. That means finishing PRD coverage and the `suss
infer` brownfield path outranks any new framework pack.

### 3. Credibility: dogfood results are private

Suss-on-suss runs in `scripts/dogfood.mjs` with a committed report.
External runs (Twenty, Saleor) are ad-hoc local clones with no
committed harness or published results. For a tool whose pitch is
"we find drift you didn't know about," the strongest marketing
artifact is a reproducible run against a known open-source codebase
with findings triaged (found-real / false-positive / gap). It would
also drive the recognizer and discovery fixes that matter, in the
order production code shows rather than the order we guess.

### 4. Doc integrity: a drift tool whose docs drift

The README flag mismatch, the stale Makefile command, an unreferenced
draft tutorial, and (until this branch) a proposal doc describing a
schema that never shipped. Each one is small, but together they
undermine the exact claim the product makes. Two responses, both
cheap: fix
the current drift now, and make #52 (self-dogfood: suss's own intent
specs against its own CLI surface) the standing mechanism. The
project catching its own docs drifting is the recursive story the
strategy memo already commits to.

### 5. Architecture debts (tracked, not blocking)

None of these block the wedge, and we have decided a direction for
each one:

- **Suppressions don't cover intent findings**: `applySuppressions`
  is typed to the behavioural `Finding`, and decision 2 of the intent
  proposal says the pipeline operates on the thin base. Generalize
  the matcher when someone first needs to suppress an intent finding
  in anger.
- **Sync I/O in readers**: we follow one convention today (all
  contract readers are sync, and checkers are pure and correctly
  sync). It is fine for a batch CLI and wrong for a server, an LSP,
  or a watch consumer. Convert the reader layer when such a consumer
  exists, not before.
- **Module-level boundary keying**: intent can declare intra-repo
  function boundaries the keyer can't pair (surfaced as
  `unkeyableBoundary`). This needs a design for normalizing paths,
  which is also part of what #52 needs.
- **Inspect is HTTP-centric and flat**: we agreed on collapsing to
  L0 plus graph query, but nobody has built it. It matters for the
  "platform" positioning. Do it after the wedge demo, since inspect
  is the second thing a curious evaluator plays with.
- **PatternPack's provider side has client patterns in it**: a known
  tension, with a written-down threshold (refactor at the fourth
  client pack).
- **Recognizer descent into nested arrows / scope primitive**: we
  tracked this from Twenty dogfooding. The priority for fixing it
  should come from the committed dogfood harness (issue 3) rather
  than from intuition.

## Sequenced recommendation

The order is chosen so each step turns the previous one into
something people outside can see. Capability work that no step pulls
on is deliberately left out.

1. **Publish alpha** (gate for everything). Scope check, changesets,
   CI release job, `0.1.0-alpha`. Fix README `-i` flag, petstore
   Makefile, and decide the draft tutorial's fate in the same pass.
2. **Finish intent v0.1**: PRD coverage checker (#51) + provenance
   downgrade. This completes the PRD → system intent → code chain
   the proposal's worked example already scripts.
3. **Ship the wedge demo**: one repo, agent-written feature from a
   PRD, `suss check --intent` failing before the fix and passing
   after: the (b) story with the (a) demo inside it. Reuse the
   fastify-users worked example.
4. **Commit the external dogfood harness** + a triaged findings
   report for one target (Twenty is furthest along). Feed its gap
   list into the backlog ordering.
5. **`suss infer` (v0.1.1)**: the brownfield on-ramp, which the
   demo will make people ask for ("I have 400 endpoints, I'm not
   hand-writing intent").

## Decision points needing a call

1. **Decision 4 amendment**: accept the CLI as the dispatch point
   (deviation flagged in `proposals/intent-specs.md`), or build
   the library-level orchestrator the original text described.
2. **Wedge choice**: endorse (b)-headline / (a)-on-ramp, or
   reorder.
3. **Publish scope + versioning**: all packages vs consumer
   surface; changesets vs manual.
4. **Draft tutorial** (`docs/tutorial/pair-frontend-backend.md`,
   currently untracked): finish and wire into the docs nav during
   step 1, or drop.
