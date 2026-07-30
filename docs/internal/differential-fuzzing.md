# Differential Fuzzing

How suss mechanically verifies its own extraction fidelity. Lives in
`tools/differential` (`@suss/differential` — private workspace package,
never published). This document is the reference for what the harness
guarantees today, how to point it at another framework pack, what the
JSX/render-boundary extension looks like, and what carries over when a
second language adapter lands.

## Why this exists

The extraction algorithm's contract is two promises
([`extraction-algorithm.md`](../extraction-algorithm.md), "Correctness
principles"):

1. **Exhaustiveness** — every path through a function maps to a
   transition (or a declared gap).
2. **No false conditions** — a predicate reported on a transition
   actually gates that transition in source. Under-specifying (opaque)
   is allowed; fabricating is not.

Before this harness, violations were found by manually running the
extractor against external codebases and reading the output (that's
how D50, D51, and D53 were caught). The differential fuzzer automates
that discovery loop: if extraction and execution ever disagree on a
program the generators can express, the harness finds it, shrinks it,
and the counterexample becomes a permanent fixture. This is the
"machine-enforced correspondence between summary and source" invariant
made executable.

## Architecture

Four generic components and one target-specific seam:

```
generators.ts ──▶ program.ts DSL ──▶ renderBodyLines(program, target.renderTerminal)
                                        │                        │
                              target.renderModule        renderHandlerSource
                                        │                        │
                                extract.ts (real pipeline)   execute.ts (node:vm)
                                        │                        │
                                BehavioralSummary          ObservedResponse
                                        └──── differential.ts ────┘
                                          interpret.ts (3-valued)
                                                   │
                                       verdict per (program, request)
```

- **`program.ts`** — a tiny AST DSL for handler bodies: guards over
  `req.params/query/headers/body`, truthiness / equality / `in`
  conditions, `&&`/`||` composition, final respond / if-else /
  ternary, plus the gap-tier constructs (nested guards, loop guards).
  Framework-neutral: it never mentions Express.
- **`generators.ts`** — fast-check arbitraries over the DSL, tiered
  (see below).
- **`extract.ts`** — the real pipeline: one shared in-memory ts-morph
  project (bootstrap ~500ms, re-extract ~5–30ms), fresh adapter per
  program, the target's actual `PatternPack`.
- **`execute.ts` + `requests.ts`** — `node:vm` execution against a
  deterministic request battery: per observed field, the battery tries
  absent / `""` / a truthy value / every literal the program compares
  against; full cross product when small, seeded sample otherwise.
  Exactly one recorded response per execution, or it's a harness error
  (generator bug — never a finding).
- **`interpret.ts`** — a three-valued (Kleene) interpreter for
  `Predicate`/`ValueRef` against a concrete request. Abstention is
  load-bearing: opaque predicates, dependency/state/unresolved refs,
  method-call and awaited derivations all evaluate to `unknown`,
  never a guess. This module is deliberately standalone — it is the
  planned shared core for `suss corroborate` (WS-3).
- **`target.ts`** — the only place framework syntax lives. A
  `FuzzTarget` is: a `PatternPack`, a terminal renderer
  (`res.status(N).json(B)` vs `res.code(N).send(B)`), a module
  wrapper (registration form), and the vm response stub. Express and
  Fastify are wired; the sound-tier property runs against both, which
  is the standing proof the harness checks the *adapter*, not
  Express-isms.

## Adjudication semantics

For each (program, request): extract once, execute once, then evaluate
every transition's conditions under the interpreter.

| Situation | Verdict | Principle violated |
|---|---|---|
| A transition's conditions all evaluate **true**, its status is known, and it differs from the observed status | `falseClaim` | #2 — the summary asserted something about this execution and was wrong |
| No transition with true-or-unknown conditions admits the observed status, and the summary declares no gap | `uncovered` | #1 — observed behavior unaccounted for |
| Anything involving `unknown` conditions or unknown status | no verdict | abstention can neither falsify nor be falsified |

The judge never uses transition order or `isDefault` — each transition
is read as an independent claim ("when these conditions hold, this
output happens"), which is exactly how the checker and human readers
consume summaries.

## Tiers and the corpus protocol

- **Sound tier** (`SOUND_TIER`) — constructs extraction models
  faithfully. The property must hold; CI runs it with a fixed seed
  (override: `SUSS_FUZZ_SEED`, `SUSS_FUZZ_RUNS`). A counterexample
  here is an undocumented extraction bug: shrink it, fix it or file
  it, and pin it in `corpus.test.ts`.
- **Gap tiers** (`arbNestedGuard`, `arbLoopGuard`) — constructs whose
  unsoundness is *documented*. Their properties are inverted: the
  fuzzer is **required** to rediscover each gap within a bounded run.
  This keeps the documentation honest in both directions — the gap
  can't silently grow (sound tier would catch spillover) and can't
  silently close (the rediscovery test fails, telling you to promote
  the construct to the sound tier and flip its corpus entries to
  `clean`).
- **Corpus** (`corpus.test.ts`) — every shrunk counterexample pinned
  as a (program, request, verdict) triple. `gap:*` entries assert the
  known gap still reproduces; `fixed:*` entries are the earned
  regression suite.

Lifecycle of a gap: fuzzer finds mismatch → shrunk program lands as a
`gap:*` corpus entry (+ generator arm if it's a new construct) →
extraction rework closes it → rediscovery test + corpus entry fail →
entries flip to `clean`/`fixed:*`, construct joins the sound tier.

First session's results, for calibration: the two documented gaps
(nested-guard, loop-return) were rediscovered mechanically in seconds;
6,000 random sound-tier programs ran clean; and the fuzzer surfaced
one **new** bug — dynamic element-access indexes (`obj[key]`) encoded
as static reads (`indexAccess("key")`) — fixed the same day in the
adapter's `subjects.ts` (decision #54 in
[`status.md`](status.md)).

## Extending to another HTTP pack

Adding a target is deliberately small — one entry in `target.ts`:

1. **Terminal renderer** — how the pack's response terminals are
   spelled from a DSL `Terminal` (status + one-key JSON body).
2. **Module wrapper** — the registration form the pack's discovery
   matches (`router.get(...)`, `app.get(...)`, …). Keep the handler
   params named `(req, res)`: parameter names are user-chosen in real
   code, and keeping them stable means the DSL's conditions and the
   interpreter's env key don't vary per target.
3. **Response stub** — the chainable object the vm hands the handler;
   every terminating call records `{ status, body }` exactly once.
4. Add the target to `ALL_TARGETS` — the sound tier and determinism
   properties pick it up automatically.

Candidates already in-tree: Hono, NestJS-REST (needs a class-method
module wrapper), ts-rest (needs a `returnShape` terminal renderer —
`return { status, body }` instead of a `res` call — and a stub that
captures return values; the DSL's `Terminal` already carries
everything needed).

What does NOT need per-target work: the DSL, the generators, the
request battery, the interpreter, the adjudicator, the corpus
protocol.

## The JSX / render boundary (implemented — `src/jsx/`)

React components are the other extraction surface that matters for
confidence today (`@suss/framework-react`, decisions #33–#45). The
differential mechanism transferred with two seams changed — how
"execute" and "observe" work at a render boundary:

- **Program DSL** (`componentProgram.ts`). A `ComponentProgram`:
  destructured string props, guards (`return null` / `return <jsx/>`),
  and a JSX return tree with inline conditionals (`{cond && <X/>}`,
  `{cond ? <A/> : <B/>}`) — the constructs decisions #38/#42 claim to
  model. Renders to a `.tsx` module with a default-exported function
  component.
- **Extraction.** Identical to HTTP: in-memory project (`jsx` compiler
  option on) + the React pack. Claims live in the transitions'
  conditions (real `Predicate`s over props) and their outputs —
  `return null` claims "renders nothing"; `render` outputs claim a
  `RenderNode` tree (with `conditional` nodes carrying verbatim
  condition text, decision #38's v0 shape).
- **Execution** (`componentExecute.ts`). No react dependency: the TSX
  is transpiled with the TypeScript compiler (`ts.transpileModule`,
  classic `React.createElement` emit) and run in the vm with a stub
  `createElement` that builds a plain tree. The component is called
  with each props assignment from a deterministic battery; the
  returned stub tree (or `null`) is the observation.
- **Adjudication** (`componentJudge.ts`). Same two verdicts, different
  observable. Transition conditions evaluate through the shared
  interpreter (props env — enabled by the destructured-parameter fix
  below). Tree admissibility is conservative by construction: a claim
  commits to *certain* facts (root tag, element tags and texts outside
  any conditional) and allows *possible* facts (conditional branches);
  expression nodes make the observation unexplainable-checks moot.
  Missing certain structure, inadmissible observed structure, root-tag
  disagreement, and null-vs-render disagreement are proven mismatches;
  everything touched by a conditional or expression abstains. Running
  `parseConditionExpression` over conditional-node text (the #38
  follow-up) would upgrade those abstentions to real evaluations.
- **What carried over untouched:** the interpreter, the tier/corpus
  protocol, shrinking, the CI story.

Two findings from bringing it up:

1. **Destructured parameters resolved as `unresolved`** — `function
   C({ user })` produced conditions over `unresolved("user")` rather
   than `input("user")`, even though the input mapping lists each prop
   as an Input. Every prop-gated condition was therefore opaque to
   downstream consumers (decision #45's checker carried a source-text
   regex fallback to compensate). Fixed in `subjects.ts`: a binding
   element whose pattern hangs off a `ParameterDeclaration` is an
   input. This is what makes JSX adjudication's condition evaluation
   possible at all.
2. **The nested-guard gap manifests at the render boundary** — as
   predicted, since the guard machinery is shared:
   `if (o) { if (i) { return null; } }` leaves the final render
   transition claiming unconditional truth while execution returns
   null. Pinned as the JSX rediscovery milestone
   (`arbComponentProgramWithNestedGuard`) and a `gap:nested-guard`
   corpus entry — one extraction fix will flip the HTTP *and* JSX
   milestones together, which is exactly the cross-boundary
   confirmation the shared-machinery claim needed.

Not yet covered on the render side (candidates for the next
increment): event-handler sub-units (invoke recorded handler props
with a stub event; needs #42's invocation-effects on the claims
side), `useEffect` sub-units, fragments, custom-component children,
and `.map()` lists (documented-opaque today — they'd only exercise
abstention until extraction models them).

## Other languages

The plan's eventual Python adapter (status.md Phase 10) slots in the
same way, because the harness seams are the pipeline's seams:

- `RawCodeStructure` is the adapter boundary (decision #7) — a Python
  target supplies a DSL renderer that emits Flask/FastAPI-shaped
  source and an execution harness for it (a `python -c` subprocess
  instead of `node:vm`). Everything downstream of the summary — the
  interpreter, the adjudicator, the corpus — operates on serialized
  IR and does not change.
- The generators' construct set (guards, compound conditions,
  early returns) is language-generic by design; per-language arms
  cover syntax that doesn't exist in TS.

The rule of thumb the harness encodes: **one differential per
boundary-shape** (HTTP request/response, render, and later
message-consume), **one target per pack within it**.

## Running

```sh
# in tools/differential
npx vitest run                          # full suite, CI defaults (fixed seed)
SUSS_FUZZ_RUNS=500 npx vitest run src/differential.test.ts
SUSS_FUZZ_SEED=12345 npx vitest run     # reproduce a specific CI run
npx tsup && node longrun.mjs sound 1500 4 fastify   # exploratory, random seeds
```
