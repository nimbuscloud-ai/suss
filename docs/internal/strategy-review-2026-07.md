# Strategy review — July 2026

State of the project measured against its stated goals, and the
shortest defensible path to external users. Structure: where the
architecture and philosophy stand, where the code diverges from the
strategy, and a sequenced recommendation with explicit decision
points. Everything here cites the doc or package it comes from.

## Verdict in three sentences

The architecture is coherent and the philosophy is now written down;
the intent layer gives suss a differentiated story no adjacent tool
has. The blocking strategic problem is distribution, not capability:
nothing is published, so every tutorial, README instruction, and CI
snippet describes a product no one can install. Close the loop that
exists (publish + finish PRD coverage + one audience-named demo)
before widening it (new packs, new protocols, new adapters).

## What the project claims to be

From `architecture.md`, `contracts.md`, `motivation.md`, and the
positioning decision: a **behavioral understanding platform** — the
summary is the product; checkers, inspect, and the intent layer are
consumers of it. Explicitly not a linter. The long-term arc
(`backlog.md`, "the Jackson arc") runs intent specs → workflow
intent → concept declarations → observation adapters: progressively
richer statements of *what was meant*, each checkable against *what
shipped*.

The scope split is settled: OSS owns single-repo, single-moment
primitives; cross-repo, temporal, and org-level features are product
scope.

## Philosophy — consistent, and now stated

The design principles that recur across the shipped code, worth
naming because new work should be checked against them:

1. **The summary is the product.** Downstream tools consume IR, never
   ASTs or source. Everything serializes.
2. **Severity follows epistemic character** (`contracts.md`):
   derivation violating a specification is an error; observations
   are weaker; two specifications disagreeing is a reconcile.
3. **Open vs closed specifications.** Intent docs declare the floor
   (what must exist) — code exceeding them is info. Schema contracts
   (OpenAPI) are closed enumerations — exceeding them is a violation.
4. **Pending vs broken.** Declared-ahead-of-capability states
   (unlinked scenario, unkeyable boundary) are valid and surfaced at
   low severity; malformed artifacts are load-time errors. Nothing is
   ever silently skipped — checkers report checked / unchecked
   accounting, not just findings.
5. **Degradation is explicit.** Opaque predicates, gaps, and
   confidence levels say "we don't know" rather than fabricating.
6. **Packs are data; the adapter owns the language; runtimes own
   their built-ins.** Ownership rules in `architecture.md`.
7. **Checkers are pure IR-only functions; the CLI is the
   orchestration seam.** No checker depends on another.

These hold across the behavioural and intent layers today. The known
violations are listed as debts below — none are philosophical
conflicts, all are unfinished mechanics.

## Strategic issues, ranked

### 1. Distribution: the product cannot be installed

Every package is `"private": true`, version 0.0.1, no
`publishConfig`. The README, both tutorials, and the CI guide
instruct `npm install @suss/cli` — which fails. The only working
path is clone + build + `node packages/cli/dist/index.js`. Secondary
drift compounds it: the petstore Makefile still calls the removed
`suss stub` command, and the README documents a `-i` flag `suss
contract` doesn't have.

This gates everything else. No demo, blog post, or dogfood result
converts into a user without an install path. It is also the
cheapest item on this list: the packages already carry publish
metadata, licenses, and READMEs.

Decisions needed: npm scope availability (`@suss` may be taken —
verify, have a fallback), versioning workflow (changesets vs manual),
and whether all 30 packages publish or only the consumer surface
(recommendation: all — packs are the extension story and they're
already shaped for it).

### 2. The wedge: who is the first user, doing what

Per the demo-gating rule every feature needs a named beneficiary in a
named setting. The project supports three candidate wedges today:

- **(a) Frontend ↔ backend drift** — the anatomy-of-an-integration-bug
  story. Demoable now (petstore example, Express/React fixtures).
  Audience: full-stack teams without shared types. Crowded adjacent
  space (typed clients, OpenAPI generators solve the 80% case).
- **(b) Intent → code verification for AI-generated code** — the
  intent layer's story: agent writes code from a spec; suss checks
  the spec was satisfied, structurally, before review. Audience:
  teams running AI codegen at volume (including agent harnesses
  themselves). No incumbent does this; it's the "verification is the
  bottleneck" argument from the intent proposal, and the market is
  forming right now.
- **(c) Package-boundary drift inside monorepos** — the dogfood
  machinery (packageExports / packageImport pairing). Audience:
  platform teams in large TS monorepos. Real pain, but discovery
  gaps (member-call chains, namespace imports) are known and bite
  production code first.

Recommendation: **(b) as the headline, (a) as the on-ramp.** (b) is
the differentiated story and matches the moment; (a) is the
five-minute demo that doesn't require a team to author intent before
seeing value. (c) waits — its extraction gaps make first impressions
risky. Consequence: finishing PRD coverage and the `suss infer`
brownfield path outranks any new framework pack.

### 3. Credibility: dogfood results are private

Suss-on-suss runs in `scripts/dogfood.mjs` with a committed report;
external runs (Twenty, Saleor) are ad-hoc local clones with no
committed harness or published results. For a tool whose pitch is
"we find drift you didn't know about," the strongest marketing
artifact is a reproducible run against a known open-source codebase
with real findings triaged (found-real / false-positive / gap). That
artifact also drives the recognizer/discovery fixes that matter,
in priority order observed from real code rather than speculation.

### 4. Doc integrity: a drift tool whose docs drift

The README flag mismatch, the stale Makefile command, an unreferenced
draft tutorial, and (until this branch) a proposal doc describing a
schema that never shipped. Individually trivial; collectively they
undermine the exact claim the product makes. Two responses, both
cheap: fix the current drift now, and make #52 (self-dogfood: suss's
own intent specs against its own CLI surface) the standing mechanism
— the project catching its own docs drifting is the recursive story
the strategy memo already commits to.

### 5. Architecture debts (tracked, not blocking)

None of these gate the wedge; all have a decided direction:

- **Suppressions don't cover intent findings** — `applySuppressions`
  is typed to the behavioural `Finding`; decision 2 of the intent
  proposal says the pipeline operates on the thin base. Generalize
  the matcher when intent findings first need suppressing in anger.
- **Sync I/O in readers** — consistent convention today (all
  contract readers are sync; checkers are pure and correctly sync),
  fine for a batch CLI, wrong for a server/LSP/watch consumer.
  Convert the reader layer when such a consumer exists, not before.
- **Module-level boundary keying** — intent can declare intra-repo
  function boundaries the keyer can't pair (surfaced as
  `unkeyableBoundary`). Needs a path-normalization design; also what
  #52 partially needs.
- **Inspect is HTTP-centric and flat** — the L0-collapse + graph
  query direction is agreed but unbuilt. Matters for the "platform"
  positioning; sequence after the wedge demo, since inspect is the
  surface a curious evaluator plays with second.
- **PatternPack provider-shape carrying client patterns** — known
  tension, documented threshold (refactor at the fourth client pack).
- **Recognizer descent into nested arrows / scope primitive** —
  tracked from Twenty dogfooding; fix priority should come from the
  committed dogfood harness (issue 3), not intuition.

## Sequenced recommendation

Order chosen so each step converts the previous one into something
externally visible; capability work that no step pulls on is
deliberately absent.

1. **Publish alpha** (gate for everything). Scope check, changesets,
   CI release job, `0.1.0-alpha`. Fix README `-i` flag, petstore
   Makefile, and decide the draft tutorial's fate in the same pass.
2. **Finish intent v0.1**: PRD coverage checker (#51) + provenance
   downgrade. This completes the PRD → system intent → code chain
   the proposal's worked example already scripts.
3. **Ship the wedge demo**: one repo, agent-written feature from a
   PRD, `suss check --intent` failing before the fix and passing
   after — the (b) story with the (a) demo inside it. Reuse the
   fastify-users worked example.
4. **Commit the external dogfood harness** + a triaged findings
   report for one target (Twenty is furthest along). Feed its gap
   list into the backlog ordering.
5. **`suss infer` (v0.1.1)** — the brownfield on-ramp, which the
   demo will make people ask for ("I have 400 endpoints, I'm not
   hand-writing intent").

## Decision points needing a call

1. **Decision 4 amendment** — accept the CLI as the orchestration
   seam (deviation flagged in `proposals/intent-specs.md`), or build
   the library-level orchestrator the original text described.
2. **Wedge choice** — endorse (b)-headline / (a)-on-ramp, or
   reorder.
3. **Publish scope + versioning** — all packages vs consumer
   surface; changesets vs manual.
4. **Draft tutorial** (`docs/tutorial/pair-frontend-backend.md`,
   currently untracked) — finish and wire into the docs nav during
   step 1, or drop.
