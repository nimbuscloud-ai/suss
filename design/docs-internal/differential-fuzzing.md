# Differential Fuzzing

suss checks its own extraction by generating programs, running them, and
comparing what happened with what the summary claimed. The harness lives
in `tools/differential` (`@suss/differential`, a private workspace
package we never publish). It runs against HTTP handlers and React
components today, and it has a Python target for the second language
adapter.

## Why this exists

The extraction algorithm makes two promises
([`extraction-algorithm.md`](../../docs/theory/extraction-algorithm.md), "Correctness
principles"):

1. **Exhaustiveness**: every path through a function maps to a
   transition (or to a declared gap).
2. **No false conditions**: when a transition reports a predicate, that
   predicate does gate the transition in the source. The summary may
   say too little (an opaque predicate), but it may not make anything
   up.

Before this harness, we found violations by running the extractor over
external codebases by hand and reading the output. That is how D50, D51
and D53 were caught. The differential fuzzer automates the search. If
extraction and execution disagree on any program the generators can
express, the harness finds the program, shrinks it, and we keep the
counterexample as a permanent fixture. This turns the promise of a
"machine-enforced correspondence between summary and source" into
something a test run can check.

## Architecture

There are four generic components and one place where the target
framework plugs in:

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

- **`program.ts`** is a small AST DSL for handler bodies. It has guards
  over `req.params/query/headers/body`, truthiness, equality and `in`
  conditions, `&&` and `||` composition, a final respond, if-else or
  ternary, and the constructs of the gap tiers (nested guards and loop
  guards). It does not depend on any framework and never mentions
  Express.
- **`generators.ts`** has the fast-check arbitraries over the DSL,
  split into tiers (see below).
- **`extract.ts`** runs the full pipeline. It uses one shared in-memory
  ts-morph project (about 500ms to start, 5 to 30ms per re-extract), a
  fresh adapter for each program, and the target's actual
  `PatternPack`.
- **`execute.ts`** and **`requests.ts`** run the program in `node:vm`
  against a fixed battery of requests. For each field the program
  reads, the battery tries the field absent, `""`, a truthy value, and
  every literal the program compares it with. It takes the full cross
  product when that is small, and a seeded sample when it is not. Each
  execution has to record exactly one response. Anything else is a
  harness error, which means a generator bug and never a finding.
- **`interpret.ts`** is a three-valued (Kleene) interpreter that
  evaluates a `Predicate` or `ValueRef` against a concrete request. It
  declines to guess. An opaque predicate, a dependency, state, an
  unresolved ref, or anything derived from a method call or an await
  all evaluate to `unknown`. We kept this module free of dependencies on
  the rest of the harness on purpose, because it is meant to become the
  shared core of the planned `suss corroborate`.
- **`target.ts`** is the only file that contains framework syntax. A
  `FuzzTarget` is a `PatternPack`, a terminal renderer
  (`res.status(N).json(B)` versus `res.code(N).send(B)`), a module
  wrapper (the registration form), and the vm response stub. Express
  and Fastify are both wired up, and the sound-tier property runs
  against both. That shows the harness is testing the *adapter* and
  not quirks of Express.

## Adjudication semantics

For each pair of program and request, the harness extracts once,
executes once, and then evaluates every transition's conditions with
the interpreter.

| Situation | Verdict | Principle violated |
|---|---|---|
| A transition's conditions all evaluate **true**, its status is known, and it differs from the observed status | `falseClaim` | #2: the summary asserted something about this execution and was wrong |
| No transition with true-or-unknown conditions admits the observed status, and the summary declares no gap | `uncovered` | #1: observed behavior unaccounted for |
| Anything involving `unknown` conditions or unknown status | no verdict | abstention can neither falsify nor be falsified |

The judge never uses transition order or `isDefault`. It reads each
transition as an independent claim ("when these conditions hold, this
output happens"). The checker and human readers read a summary the
same way.

## Tiers and the corpus protocol

- **Sound tier** (`SOUND_TIER`) contains the constructs extraction models
  faithfully. Its property has to pass, and CI runs it with a fixed
  seed (you can override it with `SUSS_FUZZ_SEED` and `SUSS_FUZZ_RUNS`).
  A counterexample here is an extraction bug nobody has written down.
  Shrink it, fix it or file it, and pin it in `corpus.test.ts`.
- **Gap tiers** contain constructs whose unsoundness we have *written
  down*. They run inverted properties, where the fuzzer is **required**
  to rediscover each gap within a bounded run. This keeps the
  documentation accurate in both directions. If the gap grows, the
  sound tier catches the new failures. If the gap closes, the
  rediscovery test fails and tells you to promote the construct to the
  sound tier and flip its corpus entries to `clean`. The nested-guard
  and loop-return tiers went through that whole cycle. The fuzzer
  rediscovered both gaps, the CFG path engine then closed them, and the
  milestones on both boundaries flipped together as the constructs
  joined the sound tier. `arbNestedGuard` and `arbLoopGuard` now run as
  "promoted constructs stay sound" properties. Since then there have
  been **no open gap tiers**.
- **Corpus** (`corpus.test.ts`): we pin every shrunk counterexample as a
  triple of program, request and verdict. A `gap:*` entry asserts that
  a known gap still reproduces. The `fixed:*` entries are the regression
  suite built up from past fixes.

A gap goes through these steps. The fuzzer finds a mismatch. The shrunk
program becomes a `gap:*` corpus entry, and a new construct also gets a
generator arm. Extraction work closes the gap, so the rediscovery test
and the corpus entry fail. The entries then flip to `clean` or
`fixed:*`, and the construct joins the sound tier.

The results of the first session give a sense of scale. The fuzzer
rediscovered the two written-down gaps (nested-guard and loop-return)
in seconds. 6,000 random sound-tier programs ran without a finding. The
fuzzer also found one **new** bug: the extractor was encoding a dynamic
element-access index (`obj[key]`) as a static read
(`indexAccess("key")`). We fixed it the same day in the adapter's
`subjects.ts`, which now tells a dynamic index apart from a static one.
One session later the CFG path engine closed both written-down gaps,
and the corpus went through its first full cycle: the fuzzer found each
gap, we pinned it as `gap:*`, fixed it, and flipped it to a `fixed:*`
regression.

## Extending to another HTTP pack

We kept adding a target small on purpose. It is one entry in
`target.ts`:

1. **Terminal renderer**: how the pack's response terminals are
   written from a DSL `Terminal` (a status and a one-key JSON body).
2. **Module wrapper**: the registration form the pack's discovery
   matches (`router.get(...)`, `app.get(...)`, …). Keep the handler
   params named `(req, res)`. Application code chooses its own parameter
   names, and keeping these fixed means the DSL's conditions and the
   interpreter's environment keys are the same for every target.
3. **Response stub**: the chainable object the vm passes to the handler.
   Every terminating call on it records `{ status, body }` exactly once.
4. Add the target to `ALL_TARGETS`. The sound tier and the determinism
   properties then pick it up automatically.

Packs already in the tree that could become targets: Hono,
NestJS-REST, which needs a class-method module wrapper, and ts-rest.
ts-rest needs a `returnShape` terminal renderer, `return { status, body }`
instead of a `res` call, and a stub that captures return values. The
DSL's `Terminal` already contains everything it needs.

The DSL, the generators, the request battery, the interpreter, the
adjudicator and the corpus protocol need no work per target.

## The JSX / render boundary (implemented, `src/jsx/`)

React components are the other extraction surface that matters most for
confidence today (`@suss/framework-react`, decisions #33 to #45). We
moved the differential mechanism over and only had to change what
"execute" and "observe" mean at a render boundary.

- **Program DSL** (`componentProgram.ts`). A `ComponentProgram` has
  destructured string props, guards (`return null` or `return <jsx/>`),
  and a JSX return tree with inline conditionals (`{cond && <X/>}`,
  `{cond ? <A/> : <B/>}`). These are the constructs decisions #38 and
  #42 say extraction models. The program renders to a `.tsx` module
  with a default-exported function component.
- **Extraction** works the same way as for HTTP: an in-memory project
  with the `jsx` compiler option on, plus the React pack. The claims
  are in the transitions' conditions (structured `Predicate`s over
  props) and in their outputs. A `return null` claims the component
  renders nothing. A `render` output claims a `RenderNode` tree, and its
  `conditional` nodes contain the condition text word for word, the v0
  form decision #38 settled on.
- **Execution** (`componentExecute.ts`) does not depend on react. We
  transpile the TSX with the TypeScript compiler (`ts.transpileModule`,
  classic `React.createElement` emit) and run it in the vm with a stub
  `createElement` that builds a plain tree. We call the component with
  each set of props from a fixed battery, and the observation is the
  stub tree it returns, or `null`.
- **Adjudication** (`componentJudge.ts`) has the same two verdicts. Only
  the thing being observed changes. Transition conditions go through the
  shared interpreter over an environment of props, which only became
  possible after the destructured-parameter fix described below. The
  judge is conservative when it decides whether a tree is admissible. A
  claim commits to the facts that are *certain*: the root tag, and the
  tags and text of elements outside any conditional. It allows the
  facts that are *possible*, meaning the branches of a conditional. An
  expression node means the judge cannot rule out an observation, so it
  skips that check. It counts four things as proven mismatches: missing
  certain structure, observed structure that is not admissible, a root
  tag that disagrees, and a null where a render was claimed. Anything a
  conditional or an expression touches abstains. Running
  `parseConditionExpression` over a conditional node's text (the #38
  follow-up) would let the judge evaluate those cases instead of
  abstaining.
- The interpreter, the tier and corpus protocol, shrinking and the CI
  setup all carried over unchanged.

Bringing it up found two things:

1. **Destructured parameters came out as `unresolved`.** `function
   C({ user })` produced conditions over `unresolved("user")` instead of
   `input("user")`, even though the input mapping lists each prop as an
   Input. So every condition gated on a prop was opaque to everything
   downstream, and the checker in decision #45 had a regex fallback over
   the source text to make up for it. We fixed it in `subjects.ts`: a
   binding element whose pattern belongs to a `ParameterDeclaration` is
   an input. Without that fix, JSX adjudication could not evaluate any
   condition.
2. **The nested-guard gap showed up at the render boundary**, as we
   expected, since both boundaries share the guard code.
   `if (o) { if (i) { return null; } }` left the final render
   transition claiming it applied unconditionally while execution
   returned null. We pinned it as the JSX rediscovery milestone
   (`arbComponentProgramWithNestedGuard`) and a `gap:nested-guard`
   corpus entry. When the CFG path engine landed, one adapter change
   flipped the HTTP *and* the JSX milestone together. That confirmed
   the two boundaries do share the guard code. Both entries are now
   `fixed:*` regressions.

Some parts of the render side are not covered yet, and they are the
next candidates. Event-handler sub-units need the harness to call the
recorded handler props with a stub event, which needs the invocation
effects from #42 on the claims side. The others are `useEffect`
sub-units, fragments, children that are custom components, and
`.map()` lists. We have written `.map()` lists down as opaque today, so
they would only exercise abstention until extraction models them.

## Other languages

The Python target (implemented, `src/python/`) is the first differential
for a second language. It judges what the v0 Python adapter claims,
which is boundary declarations and not condition-gated transitions. Its
parts:

- **Program DSL and generators** (`pythonProgram.ts`,
  `pythonGenerators.ts`). The specs cover the patterns the shipped
  flask-restx and fastapi packs read. For flask-restx that is a
  decorated resource class behind a direct import, a project wrapper
  module, or a namespace mounted with `add_namespace`. For fastapi it is
  decorated functions on the app or on a mounted router, with
  `response_model` or `status_code` and prefix composition. The specs
  also cover the patterns those packs say they abstain on: a
  non-literal path, a computed prefix, a namespace with no path of its
  own or a mount that overrides it, a reassigned router or namespace
  variable, and one mounted twice, never, or onto another router.
  Rendering writes out the program's files plus one intent per route,
  saying where the running app serves it and which tier its pattern
  belongs to.

  Both frameworks get the same dimensions because of a bug that stayed
  hidden. The flask-restx arm once always mounted its namespace at
  `"/"`. No generated program could then tell composing a namespace
  path apart from ignoring it, so a whole class of wrong paths went
  unmeasured while the runs reported no findings. If the generator
  cannot vary a dimension, the differential cannot see bugs in it.
- **Extraction** runs the same pipeline `suss extract` runs for Python
  (tree-sitter, binder, router index, the shipped pack) over the same
  files on disk that the runtime side imports.
- **Observation** (`pythonObserve.ts`) shells out to python3 (the CI
  image's or the developer's own, never one we ship). It asks the
  frameworks themselves which routes are served, through flask's
  `url_map` and fastapi's route table, and probes each route once with
  a well-formed request. One interpreter process observes a whole
  batch, because importing the frameworks is most of the cost of each
  program.
- **Adjudication** (`pythonJudge.ts`) follows the same protocol. A
  claimed method and path the app does not serve is a `falseClaim`, and
  so is a declared literal status that a probe contradicts. A served
  route that nothing claims and nothing abstains over is `uncovered`.
  Abstention is never a finding. We report it as the run's cost, the
  abstention rate. The first bug it caught: a non-literal `status_code=`
  keyword plus a return annotation made the adapter invent a
  literal-200 claim that the running app contradicted. The adapter now
  abstains there.

On a pull request, CI runs only the static half
(`pythonExtraction.test.ts`). It checks that claim-tier patterns
extract their served path, that abstention-tier patterns extract no
path claim, and that promotion works the same way as in the shape
tiers. The full differential runs in the fuzz workflow through
`fuzzPython.mjs`, which installs the target frameworks from
`python/requirements.txt`.

The harness follows a rule of thumb: **one differential per kind of
boundary** (HTTP request and response, render, and later message
consumption), and **one target per pack within it**.

## Shapes: how a unit is written, bound, reached, and announced
(`src/shape/`)

The handler and component DSLs vary what happens *inside* a unit. The
shape generator varies everything around it, because that is where the
bugs of the last few weeks came from: a concise arrow, a value read off
a property, a component exported twice, a reassigned binding. None of
those change what the code does, and a DSL that only describes a body
cannot produce any of them.

There are five dimensions. The generator draws each one independently
and then combines them:

| Dimension | Values |
|---|---|
| How the function is written | declaration, function expression, concise arrow, block arrow, method, async, overloaded |
| How the binding is formed | `const`, `let` assigned once, `let` reassigned, `var`, destructured, with a default |
| How the value reaches its use | direct, through a name, a property, an array index, a call's return, a factory's object argument, an alias, a parameter, an import, a barrel, two barrels |
| What the function hands back | a response, a returned response, a value typed by a library type |
| How the boundary is announced | a registration call (Express, Fastify), an export name, a default export, both, an alias, a barrel, a class decorator (NestJS), a project decorator that wraps it, `applyDecorators` |

When a draw's dimensions do not fit together, the generator repairs it
instead of throwing it away. For example, a concise arrow keeps the
response its body ends on and drops the guards it has no room for. That
keeps coverage close to uniform across each dimension. `isValidShape`
is the predicate for which combinations make sense, and the tests
enforce it.

### Three oracles

Execution alone cannot see most shape bugs, because the shape does not
change what the program does. So two more oracles run beside it:

- **Execution** works as in the handler differential. It flags a
  transition whose conditions are true but whose promised status the
  run did not produce. It catches a reassigned binding, because the run
  takes the second assignment while the summary reports the first.
- **Invariants** (`invariants.ts`) are things that have to be true of a
  set of summaries whatever the program does. Examples are a boundary
  that was announced but never summarized, or one summarized twice. Two
  summaries collapsing onto one identity, a boundary with no key to
  pair on, a summary that says nothing at high confidence, and a
  summary bigger than a quarter of a megabyte are the rest. Each is a
  named check, and a failure reports the name.
- **Equivalence** (`equivalence.ts`) has the generator render the same
  behavior twice, once as drawn and once in the plainest spelling. The
  two summaries have to agree on everything except their positions in
  the source. Execution cannot stand in for this oracle, because a
  spelling that silently loses a claim still runs and still produces a
  well-formed summary.

### Minimization

fast-check shrinks the body but leaves the dimensions where the draw put
them, and that is not enough to see *why* a program failed.
`minimize.ts` moves each dimension back toward its plainest value and
keeps the change whenever the same finding survives. A failure then
prints the shortest program in the space that still shows it, usually
six lines. We identify a finding by its oracle plus either the
invariant name or the path that disagreed, so minimization cannot drift
onto a different bug.

`longrunShape.mjs` also runs one program for each dimension value, with
every other dimension at its plainest. The random sample tells you how
often a shape fails, and this table tells you which dimension causes
it.

### What a scheduled run does with what it finds

Every bug the fuzzer finds today is listed in `knownBugs.ts`, with the
dimension value that produces it and a sentence saying what is wrong.
Two things read that list. The pinned tests assert that each bug still
reproduces, so fixing one breaks a test, and the failure tells you to
promote the dimension value. `longFuzz.mjs`, which the schedule runs,
fails on a finding whose signature is not in the list, and on a pinned
bug that stopped reproducing. Nobody reads a nightly job that writes to
a log and exits successfully, so this one exits non-zero and prints the
minimized program.

### Tiers

The protocol matches the handler differential's. The sound tier is the
set of dimension values extraction handles today, and it has to stay
silent. Every value that fails has an entry in `shape.test.ts` saying
which finding it produces, plus a sentence saying what is wrong. When
someone fixes the bug, that entry fails and tells you to move the value
into the sound tier.

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
shapes take under a minute, and `.github/workflows/fuzz.yml` runs that
on demand and nightly with random seeds.
