# Differential Fuzzing

How suss mechanically verifies its own extraction fidelity. Lives in
`tools/differential` (`@suss/differential`, a private workspace package,
never published). This document is the reference for what the harness
guarantees today, how to point it at another framework pack, what the
JSX/render-boundary extension looks like, and what carries over when a
second language adapter lands.

## Why this exists

The extraction algorithm's contract is two promises
([`extraction-algorithm.md`](../extraction-algorithm.md), "Correctness
principles"):

1. **Exhaustiveness**: every path through a function maps to a
   transition (or a declared gap).
2. **No false conditions**: a predicate reported on a transition
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
                                extract.ts (full pipeline)   execute.ts (node:vm)
                                        │                        │
                                BehavioralSummary          ObservedResponse
                                        └──── differential.ts ────┘
                                          interpret.ts (3-valued)
                                                   │
                                       verdict per (program, request)
```

- **`program.ts`**: a tiny AST DSL for handler bodies. Guards over
  `req.params/query/headers/body`, truthiness / equality / `in`
  conditions, `&&`/`||` composition, final respond / if-else /
  ternary, plus the gap-tier constructs (nested guards, loop guards).
  Framework-neutral: it never mentions Express.
- **`generators.ts`**: fast-check arbitraries over the DSL, tiered
  (see below).
- **`extract.ts`**: the full pipeline. One shared in-memory ts-morph
  project (bootstrap ~500ms, re-extract ~5 to 30ms), fresh adapter per
  program, the target's actual `PatternPack`.
- **`execute.ts` + `requests.ts`**: `node:vm` execution against a
  deterministic request battery. Per observed field, the battery tries
  absent / `""` / a truthy value / every literal the program compares
  against; full cross product when small, seeded sample otherwise.
  Exactly one recorded response per execution, or it's a harness error
  (a generator bug, never a finding).
- **`interpret.ts`**: a three-valued (Kleene) interpreter for
  `Predicate`/`ValueRef` against a concrete request. Abstention is
  deliberate: opaque predicates, dependency/state/unresolved refs,
  method-call and awaited derivations all evaluate to `unknown`,
  never a guess. This module is deliberately standalone: it is the
  planned shared core for the planned `suss corroborate`.
- **`target.ts`**: the only place framework syntax lives. A
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
| A transition's conditions all evaluate **true**, its status is known, and it differs from the observed status | `falseClaim` | #2: the summary asserted something about this execution and was wrong |
| No transition with true-or-unknown conditions admits the observed status, and the summary declares no gap | `uncovered` | #1: observed behavior unaccounted for |
| Anything involving `unknown` conditions or unknown status | no verdict | abstention can neither falsify nor be falsified |

The judge never uses transition order or `isDefault`: each transition
is read as an independent claim ("when these conditions hold, this
output happens"), which is exactly how the checker and human readers
consume summaries.

## Tiers and the corpus protocol

- **Sound tier** (`SOUND_TIER`): constructs extraction models
  faithfully. The property must hold; CI runs it with a fixed seed
  (override: `SUSS_FUZZ_SEED`, `SUSS_FUZZ_RUNS`). A counterexample
  here is an undocumented extraction bug: shrink it, fix it or file
  it, and pin it in `corpus.test.ts`.
- **Gap tiers**: constructs whose unsoundness is *documented* run
  inverted properties: the fuzzer is **required** to rediscover each
  gap within a bounded run. This keeps the documentation accurate in
  both directions: the gap can't silently grow (sound tier would
  catch spillover) and can't silently close (the rediscovery test
  fails, telling you to promote the construct to the sound tier and
  flip its corpus entries to `clean`). The nested-guard and
  loop-return tiers went through this full lifecycle: rediscovered
  mechanically, then closed by the CFG path engine (status.md decision
  #56), at which point both boundaries' milestones flipped together
  and the constructs joined the sound tier: `arbNestedGuard` /
  `arbLoopGuard` now run as "promoted constructs stay sound"
  properties. As of the cutover there are **no open gap tiers**.
- **Corpus** (`corpus.test.ts`): every shrunk counterexample pinned
  as a (program, request, verdict) triple. `gap:*` entries assert the
  known gap still reproduces; `fixed:*` entries are the earned
  regression suite.

Lifecycle of a gap: fuzzer finds mismatch → shrunk program lands as a
`gap:*` corpus entry (+ generator arm if it's a new construct) →
extraction rework closes it → rediscovery test + corpus entry fail →
entries flip to `clean`/`fixed:*`, construct joins the sound tier.

First session's results, for calibration: the two documented gaps
(nested-guard, loop-return) were rediscovered mechanically in seconds;
6,000 random sound-tier programs ran without a finding; and the fuzzer
surfaced one **new** bug, dynamic element-access indexes (`obj[key]`)
encoded as static reads (`indexAccess("key")`), fixed the same day in
the adapter's `subjects.ts` (decision #54 in [`status.md`](status.md)).
One session later the CFG path engine closed both documented gaps
(decision #56) and the corpus lifecycle completed its first full
cycle: find → pin as `gap:*` → fix → flip to `fixed:*` regression.

## Extending to another HTTP pack

Adding a target is deliberately small, one entry in `target.ts`:

1. **Terminal renderer**: how the pack's response terminals are
   spelled from a DSL `Terminal` (status + one-key JSON body).
2. **Module wrapper**: the registration form the pack's discovery
   matches (`router.get(...)`, `app.get(...)`, …). Keep the handler
   params named `(req, res)`: parameter names are user-chosen in
   application code, and keeping them stable means the DSL's conditions
   and the interpreter's env key don't vary per target.
3. **Response stub**: the chainable object the vm hands the handler;
   every terminating call records `{ status, body }` exactly once.
4. Add the target to `ALL_TARGETS`; the sound tier and determinism
   properties pick it up automatically.

Candidates already in-tree: Hono, NestJS-REST (needs a class-method
module wrapper), ts-rest (needs a `returnShape` terminal renderer,
`return { status, body }` instead of a `res` call, and a stub that
captures return values; the DSL's `Terminal` already carries
everything needed).

What does NOT need per-target work: the DSL, the generators, the
request battery, the interpreter, the adjudicator, the corpus
protocol.

## The JSX / render boundary (implemented, `src/jsx/`)

React components are the other extraction surface that matters for
confidence today (`@suss/framework-react`, decisions #33 to #45). The
differential mechanism transferred with two seams changed (how
"execute" and "observe" work at a render boundary):

- **Program DSL** (`componentProgram.ts`). A `ComponentProgram`:
  destructured string props, guards (`return null` / `return <jsx/>`),
  and a JSX return tree with inline conditionals (`{cond && <X/>}`,
  `{cond ? <A/> : <B/>}`), the constructs decisions #38/#42 claim to
  model. Renders to a `.tsx` module with a default-exported function
  component.
- **Extraction.** Identical to HTTP: in-memory project (`jsx` compiler
  option on) + the React pack. Claims live in the transitions'
  conditions (structured `Predicate`s over props) and their outputs:
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
  interpreter (props env, enabled by the destructured-parameter fix
  below). Tree admissibility is conservative by construction: a claim
  commits to *certain* facts (root tag, element tags and texts outside
  any conditional) and allows *possible* facts (conditional branches);
  expression nodes make the observation unexplainable-checks moot.
  Missing certain structure, inadmissible observed structure, root-tag
  disagreement, and null-vs-render disagreement are proven mismatches;
  everything touched by a conditional or expression abstains. Running
  `parseConditionExpression` over conditional-node text (the #38
  follow-up) would upgrade those abstentions to definite evaluations.
- **What carried over untouched:** the interpreter, the tier/corpus
  protocol, shrinking, the CI story.

Two findings from bringing it up:

1. **Destructured parameters resolved as `unresolved`**: `function
   C({ user })` produced conditions over `unresolved("user")` rather
   than `input("user")`, even though the input mapping lists each prop
   as an Input. Every prop-gated condition was therefore opaque to
   downstream consumers (decision #45's checker carried a source-text
   regex fallback to compensate). Fixed in `subjects.ts`: a binding
   element whose pattern hangs off a `ParameterDeclaration` is an
   input. This is what makes JSX adjudication's condition evaluation
   possible at all.
2. **The nested-guard gap manifested at the render boundary**, as
   predicted, since the guard machinery is shared:
   `if (o) { if (i) { return null; } }` left the final render
   transition claiming unconditional truth while execution returned
   null. Pinned as the JSX rediscovery milestone
   (`arbComponentProgramWithNestedGuard`) and a `gap:nested-guard`
   corpus entry. When the CFG path engine landed, the HTTP *and* JSX
   milestones flipped together off that one adapter change, exactly
   the cross-boundary confirmation the shared-machinery claim needed.
   Both entries are now `fixed:*` regressions.

Not yet covered on the render side (candidates for the next
increment): event-handler sub-units (invoke recorded handler props
with a stub event; needs #42's invocation-effects on the claims
side), `useEffect` sub-units, fragments, custom-component children,
and `.map()` lists (documented-opaque today; they'd only exercise
abstention until extraction models them).

## Other languages

The Python target (implemented, `src/python/`) is the first
second-language differential, adjudicating what the v0 Python
adapter actually claims: boundary declarations, not condition-gated
transitions. Its seams:

- **Program DSL + generators** (`pythonProgram.ts`,
  `pythonGenerators.ts`). Specs cover the shapes the shipped
  flask-restx and fastapi packs read (decorated resource classes
  behind a direct import or a project wrapper module; decorated
  functions on the app or on mounted routers, with `response_model`
  / `status_code` and prefix composition) and the shapes those packs
  document as abstentions: a non-literal path, a computed prefix, a
  reassigned router variable, a router mounted twice or never or
  onto another router. Rendering emits the program's files plus one
  intent per route saying where the running app serves it and which
  tier the shape sits in.
- **Extraction** runs the same pipeline `suss extract` runs for
  Python (tree-sitter, binder, router index, the shipped pack) over
  the same files on disk the runtime side imports.
- **Observation** (`pythonObserve.ts`) shells out to python3 (the CI
  image's or the developer's own, never anything shipped) and asks
  the frameworks themselves what is served (flask's `url_map`,
  fastapi's route table), probing each route once with a well-formed
  request. One interpreter process observes a whole batch, since
  importing the frameworks dominates per-program cost.
- **Adjudication** (`pythonJudge.ts`) keeps the protocol: a claimed
  method+path the app does not serve, or a declared literal status a
  probe contradicts, is `falseClaim`; a served route nothing claims
  or abstains over is `uncovered`; abstention is never a finding and
  is reported as the run's cost metric (the abstention rate). Its
  first catch: a non-literal `status_code=` keyword plus a return
  annotation made the adapter fabricate a literal-200 claim the
  running app contradicted; the adapter now abstains there.

Per-pull-request CI holds the static half only
(`pythonExtraction.test.ts`: claim-tier shapes extract their served
path, abstention-tier shapes extract no path claim, same promotion
protocol as the shape tiers). The full differential runs in the fuzz
workflow via `fuzzPython.mjs`, which installs the target frameworks
from `python/requirements.txt`.

The rule of thumb the harness encodes: **one differential per
boundary-shape** (HTTP request/response, render, and later
message-consume), **one target per pack within it**.

## Shapes: how a unit is written, bound, reached, and announced
(`src/shape/`)

The handler and component DSLs vary what happens *inside* a unit. The
shape generator varies everything around it, because that is where the
bugs of the last few weeks came from: a concise arrow, a value read off
a property, a component exported twice, a reassigned binding. None of
those are about what the code does, and none of them can be drawn from
a DSL that only describes a body.

Five dimensions, drawn independently and combined:

| Dimension | Values |
|---|---|
| How the function is written | declaration, function expression, concise arrow, block arrow, method, async, overloaded |
| How the binding is formed | `const`, `let` assigned once, `let` reassigned, `var`, destructured, with a default |
| How the value reaches its use | direct, through a name, a property, an array index, a call's return, a factory's object argument, an alias, a parameter, an import, a barrel, two barrels |
| What the function hands back | a response, a returned response, a value typed by a library type |
| How the boundary is announced | a registration call (Express, Fastify), an export name, a default export, both, an alias, a barrel, a class decorator (NestJS), a project decorator that wraps it, `applyDecorators` |

A draw whose dimensions do not fit is repaired rather than thrown away
(a concise arrow keeps the response its body ends on and drops the
guards it cannot hold), so per-dimension coverage stays close to
uniform. `isValidShape` is the predicate that says which combinations
mean something, and the tests hold it.

### Three oracles

Execution alone cannot see most shape bugs, because a shape does not
change what the program does. Two more join it:

- **Execution**, unchanged from the handler differential. A transition
  whose conditions hold promised a status the run did not produce.
  Catches a reassigned binding, since the run takes the second
  assignment and the summary reports the first.
- **Invariants** (`invariants.ts`), what a summary set has to be true
  of whatever the program says. A boundary that was announced and not
  summarized, one summarized twice, two summaries collapsing onto one
  identity, a boundary with no key to pair on, a summary that says
  nothing at high confidence, a summary past a quarter of a megabyte.
  Each is a named check, and the name is what a failure reports.
- **Equivalence** (`equivalence.ts`), the generator renders the same
  behavior twice, once as drawn and once in the plainest spelling, and
  the two summaries have to agree on everything except where they sit
  in source. This is the one execution cannot substitute for: a
  spelling that quietly loses a claim still runs fine and still
  produces a well-formed summary.

### Minimization

fast-check shrinks the body and leaves the dimensions where the draw
put them, which is not enough to see *why* a program failed.
`minimize.ts` walks each dimension back toward its plainest value and
keeps the change whenever the same finding survives, so what a failure
prints is the shortest program in the space that still shows it,
usually six lines. A finding is identified by its oracle plus the
invariant name or the path that disagreed, so minimization cannot
wander off onto a different bug.

`longrunShape.mjs` also runs one program per dimension value with every
other dimension at its plainest. The sample says how often a shape
fails; that table says which dimension is why.

### What a scheduled run does with what it finds

Every bug the fuzzer finds today is written down in `knownBugs.ts`,
with the dimension value that produces it and a sentence saying what is
wrong. Two readers use that list. The pinned tests assert each bug still
reproduces, so fixing one breaks a test and the failure says to promote
the dimension value. `longFuzz.mjs`, which the schedule runs, fails on a
finding whose signature is not in the list and on a pinned bug that
stopped reproducing. A nightly that writes into a log and returns
success is a nightly nobody reads, so this one exits non-zero and prints
the minimized program.

### Tiers

Same protocol as the handler differential. The sound tier is the
dimension values extraction handles today and must stay silent. Every
value that fails has an entry in `shape.test.ts` naming the finding it
produces and a sentence saying what is wrong; when someone fixes it the
entry fails and says to move the value into the sound tier.

## Running

```sh
# in tools/differential
npx vitest run                          # full suite, CI defaults (fixed seed)
SUSS_FUZZ_RUNS=500 npx vitest run src/differential.test.ts
SUSS_FUZZ_SEED=12345 npx vitest run     # reproduce a specific CI run
npx tsup && node longrun.mjs sound 1500 4 fastify   # exploratory, random seeds
npx tsup && node longrunShape.mjs both 500          # shapes: coverage, attribution, minimized findings
```

Every suite runs on every pull request under `npm run test`, at a fixed
seed. The whole shape suite takes about eight seconds; 4,500 sound-tier
shapes take under a minute, which is what `.github/workflows/fuzz.yml`
runs on demand and nightly with random seeds.
