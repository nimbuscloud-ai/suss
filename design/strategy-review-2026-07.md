# Strategy review, July 2026

This measures the state of the project against its stated goals and
lays out the shortest path to external users that we can defend. It
covers where the architecture and philosophy stand and where the code
has drifted from the strategy. Then it gives a recommended order of
work, with the decisions that need to be made along the way. Every
claim cites the doc or package it comes from.

## Summary

The architecture is coherent, and the philosophy is now written down.
The intent layer gives suss a story that no neighboring tool has. The
strategic blocker is distribution, and capability is not the problem:
nothing is published, so every tutorial, README instruction and CI
snippet describes a product nobody can install. Close the loop that
exists first (publish, finish PRD coverage, and build one demo for a
named audience), and widen it afterwards with new packs, protocols and
adapters.

## What the project claims to be

`architecture.md`, `contracts.md`, `motivation.md` and the positioning
decision all describe suss as a **behavioral understanding platform**.
The summary is the product, and checkers, inspect and the intent layer
all consume it. It is explicitly not a linter. The long-term plan
(`backlog.md`, "the Jackson arc") goes from intent specs to workflow
intent, then to concept declarations, then to observation adapters.
Each step is a richer statement of *what was meant*, and each can be
checked against *what shipped*.

The scope split is settled. Open source owns primitives that work on a
single repo at a single moment. Features that span repos, time or a
whole organization are product scope.

## Philosophy: consistent, and now stated

These design principles come up again and again in the shipped code.
We list them so new work can be checked against them:

1. **The summary is the product.** Downstream tools consume the IR and
   never ASTs or source. Everything serializes.
2. **Severity follows epistemic character** (`contracts.md`). A
   derivation that violates a specification is an error. An
   observation is weaker evidence. Two specifications that disagree get
   a reconcile finding.
3. **Open vs closed specifications.** Intent docs declare the floor
   (what must exist), and code that goes beyond them gets an info
   finding. Schema contracts (OpenAPI) are closed lists, and code that
   goes beyond them is a violation.
4. **Pending vs broken.** A state declared before we could check it,
   such as an unlinked scenario or an unkeyable boundary, is valid and
   is reported at low severity. A malformed artifact is an error at
   load time. Nothing is ever skipped silently: checkers report what
   they checked and what they did not, as well as their findings.
5. **Degradation is explicit.** Opaque predicates, gaps and confidence
   levels say "we don't know" instead of making something up.
6. **Packs are data, the adapter owns the language, and runtimes own
   their built-ins.** The ownership rules are in `architecture.md`.
7. **Checkers are pure functions over the IR, and the CLI is where
   dispatch happens.** No checker depends on another.

All of these are true across the behavioural and intent layers today. The
known violations are listed as debts below. None of them conflicts
with the philosophy. Each one is work that isn't finished.

## Strategic issues, ranked

### 1. Distribution: the product cannot be installed

Every package is `"private": true` at version 0.0.1, with no
`publishConfig`. The README, both tutorials and the CI guide tell you
to run `npm install @suss/cli`, which fails. The only path that works
is to clone, build, and run `node packages/cli/dist/index.js`. Other
drift makes it worse: the petstore Makefile still calls the removed
`suss stub` command, and the README documents a `-i` flag that
`suss contract` doesn't have.

This blocks everything else. No demo, blog post or dogfood result can
turn into a user without a way to install. It is also the cheapest
item on this list, because the packages already have publish
metadata, licenses and READMEs.

Decisions needed: whether the npm scope is available (`@suss` may be
taken, so check and have a fallback), how to version (changesets or by
hand), and whether all 30 packages publish or only the ones consumers
use. We recommend all of them, because packs are how people extend
suss and they are already set up for publishing.

### 2. The wedge: who is the first user, doing what

Under the demo-gating rule, every feature needs a named beneficiary in
a named setting. The project supports three candidate wedges today:

- **(a) Frontend ↔ backend drift**, the anatomy-of-an-integration-bug
  story. We can demo it now with the petstore example and the Express
  and React fixtures. The audience is full-stack teams without shared
  types. The space around it is crowded, since typed clients and
  OpenAPI generators solve 80% of the problem.
- **(b) Checking AI-generated code against intent**, the intent layer's
  story. An agent writes code from a spec, and suss checks the
  structure to confirm the spec was satisfied, before review. The
  audience is teams running AI code generation at volume, including the
  agent harnesses themselves. Nobody does this yet. It is the
  "verification is the bottleneck" argument from the intent proposal,
  and the market is forming right now.
- **(c) Drift between packages inside monorepos**, using the dogfood
  machinery (packageExports and packageImport pairing). The audience is
  platform teams in large TypeScript monorepos. The pain exists, but we
  know about gaps in discovery (chains of member calls, namespace
  imports), and production code runs into them first.

We recommend **(b) as the headline and (a) as the on-ramp.** (b) is
the story that sets suss apart, and it fits the moment. (a) is the
five-minute demo where a team sees value before writing any intent.
(c) waits, because its extraction gaps make first impressions risky.
So finishing PRD coverage and the `suss infer` path for existing
codebases comes before any new framework pack.

### 3. Credibility: dogfood results are private

suss runs on itself in `scripts/dogfood.mjs`, with a committed report.
The runs on external code (Twenty, Saleor) are one-off local clones,
with no committed harness and no published results. The tool's pitch
is "we find drift you didn't know about", so the strongest marketing
artifact would be a reproducible run against a well-known open-source
codebase, with findings triaged into true positive, false positive and
gap. It would also tell us which recognizer and discovery fixes
matter, in the order production code shows us instead of the order we
guess.

### 4. Doc integrity: a drift tool whose docs drift

The README flag mismatch, the stale Makefile command, a draft tutorial
nothing links to, and (until this branch) a proposal doc describing a
schema that never shipped. Each is small, but together they undercut
the exact claim the product makes. Both fixes are cheap. Fix the
current drift now, and make #52 (suss checking its own intent specs
against its own CLI surface) the standing mechanism. The strategy memo
already commits to the story of the project catching its own docs
drifting.

### 5. Architecture debts (tracked, not blocking)

None of these block the wedge, and we have chosen a direction for each
one:

- **Suppressions don't cover intent findings.** `applySuppressions` is
  typed to the behavioural `Finding`, and decision 2 of the intent
  proposal says the pipeline works on the thin base. Generalize the
  matcher the first time someone needs to suppress an intent finding
  in practice.
- **Sync I/O in readers.** We follow one convention today: all
  contract readers are sync, and checkers are pure and correctly sync.
  That is fine for a batch CLI and wrong for a server, an LSP or a
  watch consumer. Convert the reader layer when such a consumer exists,
  and not before.
- **Module-level boundary keying.** Intent can declare function
  boundaries inside a repo that the keyer can't pair, and they are
  reported as `unkeyableBoundary`. This needs a design for normalizing
  paths, which #52 also needs.
- **Inspect is HTTP-centric and flat.** We agreed to collapse it to L0
  plus a graph query, but nobody has built it. It matters for
  positioning suss as a platform. Do it after the wedge demo, since
  inspect is the second thing a curious evaluator tries.
- **PatternPack's provider side has client patterns in it.** This is a
  known tension, with a threshold we wrote down: refactor at the fourth
  client pack.
- **Recognizer descent into nested arrows, and a scope primitive.** We
  tracked this from dogfooding on Twenty. The committed dogfood harness
  (issue 3) should set its priority, and intuition should not.

## Sequenced recommendation

Each step in this order makes the previous one visible to people
outside the project. We deliberately left out capability work that no
step depends on.

1. **Publish an alpha** (this blocks everything). Check the scope, set
   up changesets, add a CI release job, and publish `0.1.0-alpha`. In
   the same pass, fix the README `-i` flag and the petstore Makefile,
   and decide what happens to the draft tutorial.
2. **Finish intent v0.1**: the PRD coverage checker (#51) and the
   provenance downgrade. This completes the chain from PRD to system
   intent to code that the proposal's worked example already scripts.
3. **Ship the wedge demo**: one repo, a feature an agent wrote from a
   PRD, and `suss check --intent` failing before the fix and passing
   after it. That is the (b) story with the (a) demo inside it. Reuse
   the fastify-users worked example.
4. **Commit the external dogfood harness**, plus a triaged findings
   report for one target (Twenty is furthest along). Use its list of
   gaps to order the backlog.
5. **`suss infer` (v0.1.1)**: the on-ramp for existing codebases,
   which the demo will make people ask for ("I have 400 endpoints, I'm
   not hand-writing intent").

## Decision points needing a call

1. **Amending decision 4**: accept the CLI as the place where dispatch
   happens (the deviation is flagged in `proposals/intent-specs.md`),
   or build the library-level orchestrator the original text
   described.
2. **Wedge choice**: endorse (b) as the headline and (a) as the
   on-ramp, or reorder them.
3. **Publish scope and versioning**: all packages or only the ones
   consumers use, and changesets or versioning by hand.
4. **Draft tutorial** (`docs/guides/check-against-openapi.md`,
   currently untracked): finish it and add it to the docs nav during
   step 1, or drop it.
