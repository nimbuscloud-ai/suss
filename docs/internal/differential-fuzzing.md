# Differential Fuzzing

How suss mechanically verifies its own extraction fidelity. The harness
lives in `tools/differential` (`@suss/differential`, a private workspace
package we never publish). Here you will find what the harness
guarantees today, how to point it at another framework pack, what the
JSX/render-boundary extension looks like, and what we get to keep when a
second language adapter lands.

## Why this exists

The extraction algorithm makes two promises
([`extraction-algorithm.md`](../extraction-algorithm.md), "Correctness
principles"):

1. **Exhaustiveness**: every path through a function maps to a
   transition (or to a declared gap).
2. **No false conditions**: a predicate reported on a transition
   really does gate that transition in the source. Saying too little
   (an opaque predicate) is allowed. Making something up is not.

Before this harness, we found violations by running the extractor
against external codebases by hand and reading the output (that's
how D50, D51, and D53 were caught). The differential fuzzer automates
that discovery loop: if extraction and execution ever disagree on a
program the generators can express, the harness finds it, shrinks it,
and the counterexample becomes a permanent fixture. This is what makes
the "machine-enforced correspondence between summary and source"
invariant executable.

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

- **`program.ts`**: a tiny AST DSL for handler bodies. It has guards
  over `req.params/query/headers/body`, truthiness / equality / `in`
  conditions, `&&`/`||` composition, a final respond / if-else /
  ternary, and the gap-tier constructs (nested guards, loop guards).
  It is framework-neutral and never mentions Express.
- **`generators.ts`**: fast-check arbitraries over the DSL, split into
  tiers (see below).
- **`extract.ts`**: the full pipeline. It uses one shared in-memory
  ts-morph project (bootstrap ~500ms, re-extract ~5 to 30ms), a fresh
  adapter for each program, and the target's actual `PatternPack`.
- **`execute.ts` + `requests.ts`**: these run the program in `node:vm`
  against a deterministic battery of requests. For each field the
  program reads, the battery tries the field absent, `""`, a truthy
  value, and every literal the program compares it against. It takes
  the full cross product when that is small and a seeded sample
  otherwise. Each execution has to record exactly one response;
  anything else is a harness error (a generator bug, never a finding).
- **`interpret.ts`**: a three-valued (Kleene) interpreter that
  evaluates a `Predicate`/`ValueRef` against a concrete request. It
  abstains on purpose: an opaque predicate, a dependency, state or
  unresolved ref, and anything derived from a method call or an await
  all evaluate to `unknown` rather than to a guess. We kept the module
  free of dependencies on the rest of the harness on purpose, because
  it is meant to be the shared core of the planned `suss corroborate`.
- **`target.ts`**: the only place framework syntax lives. A
  `FuzzTarget` is a `PatternPack`, a terminal renderer
  (`res.status(N).json(B)` versus `res.code(N).send(B)`), a module
  wrapper (the registration form), and the vm response stub. Express
  and Fastify are both wired up, and the sound-tier property runs
  against both, which is the standing proof that the harness checks
  the *adapter* rather than quirks of Express.

## Adjudication semantics

For each (program, request): extract once, execute once, then evaluate
every transition's conditions under the interpreter.

| Situation | Verdict | Principle violated |
|---|---|---|
| A transition's conditions all evaluate **true**, its status is known, and it differs from the observed status | `falseClaim` | #2: the summary asserted something about this execution and was wrong |
| No transition with true-or-unknown conditions admits the observed status, and the summary declares no gap | `uncovered` | #1: observed behavior unaccounted for |
| Anything involving `unknown` conditions or unknown status | no verdict | abstention can neither falsify nor be falsified |

The judge never uses transition order or `isDefault`. It reads each
transition as an independent claim ("when these conditions hold, this
output happens"), which is exactly how the checker and human readers
read a summary.

## Tiers and the corpus protocol

- **Sound tier** (`SOUND_TIER`): the constructs extraction models
  faithfully. The property has to pass, and CI runs it with a fixed
  seed (override it with `SUSS_FUZZ_SEED`, `SUSS_FUZZ_RUNS`). A
  counterexample here is an extraction bug nobody wrote down, so
  shrink it, fix it or file it, and pin it in `corpus.test.ts`.
- **Gap tiers**: constructs whose unsoundness we have *written down*
  run inverted properties, where the fuzzer is **required** to
  rediscover each gap within a bounded run. That keeps the
  documentation accurate in both directions. The gap can't quietly
  grow, because the sound tier would catch the spillover, and it can't
  quietly close, because the rediscovery test then fails and tells you
  to promote the construct to the sound tier and flip its corpus
  entries to `clean`. The nested-guard and loop-return tiers went
  through that whole lifecycle. The fuzzer rediscovered them
  mechanically, then the CFG path engine closed them (status.md
  decision #56), and at that point the milestones on both boundaries
  flipped together and the constructs joined the sound tier.
  `arbNestedGuard` and `arbLoopGuard` now run as "promoted constructs
  stay sound" properties. Since that cutover there are **no open gap
  tiers**.
- **Corpus** (`corpus.test.ts`): we pin every shrunk counterexample
  as a (program, request, verdict) triple. A `gap:*` entry asserts
  that the known gap still reproduces, and the `fixed:*` entries are
  the regression suite we earned.

Lifecycle of a gap: fuzzer finds mismatch → shrunk program lands as a
`gap:*` corpus entry (+ generator arm if it's a new construct) →
extraction rework closes it → rediscovery test + corpus entry fail →
entries flip to `clean`/`fixed:*`, construct joins the sound tier.

The first session's results, to calibrate against: the fuzzer
rediscovered the two written-down gaps (nested-guard, loop-return)
mechanically, in seconds. 6,000 random sound-tier programs ran without
a finding. And the fuzzer turned up one **new** bug: the extractor was
encoding a dynamic element-access index (`obj[key]`) as a static read
(`indexAccess("key")`). We fixed that the same day in the adapter's
`subjects.ts` (decision #54 in [`status.md`](status.md)). One session
later the CFG path engine closed both written-down gaps (decision #56)
and the corpus lifecycle finished its first full cycle: find → pin as
`gap:*` → fix → flip to `fixed:*` regression.

## Extending to another HTTP pack

Adding a target is deliberately small, one entry in `target.ts`:

1. **Terminal renderer**: how the pack's response terminals are
   spelled from a DSL `Terminal` (status + one-key JSON body).
2. **Module wrapper**: the registration form the pack's discovery
   matches (`router.get(...)`, `app.get(...)`, …). Keep the handler
   params named `(req, res)`: parameter names are user-chosen in
   application code, and keeping them stable means the DSL's conditions
   and the interpreter's env key don't vary per target.
3. **Response stub**: the chainable object the vm hands the handler.
   Every terminating call on it records `{ status, body }` exactly once.
4. Add the target to `ALL_TARGETS`. The sound tier and the determinism
   properties then pick it up on their own.

Candidates already in-tree: Hono, NestJS-REST (which needs a
class-method module wrapper), and ts-rest (which needs a `returnShape`
terminal renderer, `return { status, body }` instead of a `res` call,
and a stub that captures return values; the DSL's `Terminal` already
contains everything it needs).

What does NOT need per-target work: the DSL, the generators, the
request battery, the interpreter, the adjudicator, the corpus
protocol.

## The JSX / render boundary (implemented, `src/jsx/`)

React components are the other extraction surface that matters for
confidence today (`@suss/framework-react`, decisions #33 to #45). We
moved the differential mechanism over and only had to change two
seams: what "execute" and "observe" mean at a render boundary.

- **Program DSL** (`componentProgram.ts`). A `ComponentProgram` has
  destructured string props, guards (`return null` / `return <jsx/>`),
  and a JSX return tree with inline conditionals (`{cond && <X/>}`,
  `{cond ? <A/> : <B/>}`), which are the constructs decisions #38 and
  #42 claim to model. It renders to a `.tsx` module with a
  default-exported function component.
- **Extraction.** This works the same way it does for HTTP: an
  in-memory project with the `jsx` compiler option on, plus the React
  pack. The claims are in the transitions' conditions (structured
  `Predicate`s over props) and in their outputs. A `return null`
  claims "this renders nothing", and a `render` output claims a
  `RenderNode` tree, whose `conditional` nodes contain the condition
  text word for word, which is the v0 form decision #38 settled on.
- **Execution** (`componentExecute.ts`). There is no dependency on
  react. We transpile the TSX with the TypeScript compiler
  (`ts.transpileModule`, classic `React.createElement` emit) and run
  it in the vm with a stub `createElement` that builds a plain tree.
  We call the component with each set of props from a deterministic
  battery, and the stub tree it returns (or `null`) is the observation.
- **Adjudication** (`componentJudge.ts`). The two verdicts are the
  same and only the observable differs. Transition conditions go
  through the shared interpreter, over an environment of props, which
  the destructured-parameter fix below made possible. Deciding
  whether a tree is admissible is conservative by construction: a
  claim commits to the facts that are *certain* (the root tag, and the
  tags and texts of elements outside any conditional) and allows the
  facts that are *possible* (the branches of a conditional). An
  expression node makes the checks for an unexplainable observation
  moot. Missing certain structure, observed structure that is not
  admissible, a root tag that disagrees, and a null where a render was
  claimed are all proven mismatches, and anything a conditional or an
  expression touches abstains. Running `parseConditionExpression` over
  the text of a conditional node (the #38 follow-up) would turn those
  abstentions into definite evaluations.
- **What carried over untouched:** the interpreter, the tier/corpus
  protocol, shrinking, the CI story.

Two findings from bringing it up:

1. **Destructured parameters came out as `unresolved`**: `function
   C({ user })` produced conditions over `unresolved("user")` rather
   than `input("user")`, even though the input mapping lists each prop
   as an Input. Every prop-gated condition was therefore opaque to
   anything downstream, and the checker in decision #45 had a regex
   fallback over the source text to compensate. We fixed it in
   `subjects.ts`: a binding element whose pattern hangs off a
   `ParameterDeclaration` is an input. Without that fix, JSX
   adjudication could not evaluate a condition at all.
2. **The nested-guard gap showed up at the render boundary**, as we
   predicted it would, since the guard machinery is shared.
   `if (o) { if (i) { return null; } }` left the final render
   transition claiming it applied unconditionally while execution
   returned null. We pinned it as the JSX rediscovery milestone
   (`arbComponentProgramWithNestedGuard`) and a `gap:nested-guard`
   corpus entry. When the CFG path engine landed, that one adapter
   change flipped the HTTP *and* the JSX milestone together, which is
   exactly the cross-boundary confirmation the shared-machinery claim
   needed. Both entries are now `fixed:*` regressions.

Some things on the render side are not covered yet, and they are the
candidates for the next increment: event-handler sub-units (call the
recorded handler props with a stub event, which needs the invocation
effects from #42 on the claims side), `useEffect` sub-units,
fragments, children that are custom components, and `.map()` lists
(which we have written down as opaque today, so they would only
exercise abstention until extraction models them).

## Other languages

The Python target (implemented, `src/python/`) is the first
differential for a second language. It judges what the v0 Python
adapter actually claims, which is boundary declarations rather than
condition-gated transitions. Its seams:

- **Program DSL + generators** (`pythonProgram.ts`,
  `pythonGenerators.ts`). The specs cover the shapes the shipped
  flask-restx and fastapi packs read (a decorated resource class
  behind a direct import, a project wrapper module, or a namespace
  mounted with `add_namespace`; decorated functions on the app or on
  a mounted router, with `response_model` / `status_code` and prefix
  composition). They also cover the shapes those packs say they
  abstain on: a non-literal path, a computed prefix, a namespace with
  no path of its own or a mount that overrides it, a reassigned
  router or namespace variable, and one mounted twice or never or
  onto another router. Rendering writes out the program's files plus
  one intent per route, saying where the running app serves it and
  which tier its shape belongs to.

  Both frameworks get the same dimensions, and the reason is a bug
  that stayed hidden. The flask-restx arm once always mounted its
  namespace at `"/"`, so no generated program could tell the
  difference between composing a namespace path and ignoring it, and
  a whole class of wrong path went unmeasured while the runs reported
  no findings. A dimension the generator cannot vary is a dimension
  the differential cannot see.
- **Extraction** runs the same pipeline `suss extract` runs for
  Python (tree-sitter, binder, router index, the shipped pack) over
  the same files on disk the runtime side imports.
- **Observation** (`pythonObserve.ts`) shells out to python3 (the CI
  image's or the developer's own, never anything shipped) and asks
  the frameworks themselves what is served (flask's `url_map`,
  fastapi's route table), probing each route once with a well-formed
  request. One interpreter process observes a whole batch, because
  importing the frameworks is most of the cost of a program.
- **Adjudication** (`pythonJudge.ts`) keeps the same protocol. A
  claimed method and path the app does not serve, or a declared
  literal status a probe contradicts, is a `falseClaim`. A served
  route that nothing claims and nothing abstains over is `uncovered`.
  Abstention is never a finding, and we report it as the run's cost
  metric, the abstention rate. Its first catch was this: a
  non-literal `status_code=` keyword plus a return annotation made
  the adapter invent a literal-200 claim that the running app
  contradicted, and the adapter now abstains there.

CI on a pull request runs the static half only
(`pythonExtraction.test.ts`: claim-tier shapes extract their served
path, abstention-tier shapes extract no path claim, and the promotion
protocol is the same one the shape tiers use). The full differential
runs in the fuzz workflow through `fuzzPython.mjs`, which installs the
target frameworks from `python/requirements.txt`.

The rule of thumb the harness encodes: **one differential per kind of
boundary** (HTTP request/response, render, and later message-consume),
and **one target per pack within it**.

## Shapes: how a unit is written, bound, reached, and announced
(`src/shape/`)

The handler and component DSLs vary what happens *inside* a unit. The
shape generator varies everything around it, because that is where the
bugs of the last few weeks came from: a concise arrow, a value read off
a property, a component exported twice, a reassigned binding. None of
those are about what the code does, and a DSL that only describes a
body cannot produce any of them.

There are five dimensions, drawn independently and then combined:

| Dimension | Values |
|---|---|
| How the function is written | declaration, function expression, concise arrow, block arrow, method, async, overloaded |
| How the binding is formed | `const`, `let` assigned once, `let` reassigned, `var`, destructured, with a default |
| How the value reaches its use | direct, through a name, a property, an array index, a call's return, a factory's object argument, an alias, a parameter, an import, a barrel, two barrels |
| What the function hands back | a response, a returned response, a value typed by a library type |
| How the boundary is announced | a registration call (Express, Fastify), an export name, a default export, both, an alias, a barrel, a class decorator (NestJS), a project decorator that wraps it, `applyDecorators` |

When a draw's dimensions do not fit together, we repair it rather than
throw it away (a concise arrow keeps the response its body ends on and
drops the guards it has no room for), so coverage per dimension stays
close to uniform. `isValidShape` is the predicate that says which
combinations mean something, and the tests enforce it.

### Three oracles

Execution alone cannot see most shape bugs, because a shape does not
change what the program does. Two more join it:

- **Execution**, unchanged from the handler differential. A transition
  whose conditions are true promised a status the run did not produce.
  It catches a reassigned binding, because the run takes the second
  assignment while the summary reports the first.
- **Invariants** (`invariants.ts`), the things that have to be true of
  a set of summaries no matter what the program says. A boundary that
  was announced and never summarized, one summarized twice, two
  summaries collapsing onto one identity, a boundary with no key to
  pair on, a summary that says nothing at high confidence, a summary
  bigger than a quarter of a megabyte. Each of those is a named
  check, and the name is what a failure reports.
- **Equivalence** (`equivalence.ts`), where the generator renders the
  same behavior twice, once as drawn and once in the plainest
  spelling, and the two summaries have to agree on everything except
  where they are in the source. This is the one execution cannot
  substitute for, because a spelling that quietly loses a claim still
  runs fine and still produces a well-formed summary.

### Minimization

fast-check shrinks the body and leaves the dimensions where the draw
put them, which is not enough to see *why* a program failed.
`minimize.ts` walks each dimension back toward its plainest value and
keeps the change whenever the same finding survives, so what a failure
prints is the shortest program in the space that still shows it,
usually six lines. We identify a finding by its oracle plus either the
invariant name or the path that disagreed, so minimization cannot
wander off onto a different bug.

`longrunShape.mjs` also runs one program per dimension value with every
other dimension at its plainest. The sample tells you how often a shape
fails, and that table tells you which dimension is responsible.

### What a scheduled run does with what it finds

Every bug the fuzzer finds today is written down in `knownBugs.ts`,
with the dimension value that produces it and a sentence saying what is
wrong. Two readers use that list. The pinned tests assert each bug still
reproduces, so fixing one breaks a test and the failure tells you to
promote the dimension value. `longFuzz.mjs`, which the schedule runs,
fails on a finding whose signature is not in the list, and on a pinned
bug that stopped reproducing. A nightly that writes into a log and
returns success is a nightly nobody reads, so this one exits non-zero
and prints the minimized program.

### Tiers

The protocol is the same as the handler differential's. The sound tier
is the set of dimension values extraction handles today, and it has to
stay silent. Every value that fails has an entry in `shape.test.ts`
that says which finding it produces, plus a sentence saying what is
wrong. When someone fixes it, that entry fails and tells you to move
the value into the sound tier.

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
seed. The whole shape suite takes about eight seconds. 4,500 sound-tier
shapes take under a minute, and that is what `.github/workflows/fuzz.yml`
runs on demand and nightly with random seeds.
