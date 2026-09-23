# @suss/differential

A differential fuzzer that checks how faithfully suss extracts. It is an
internal tool, a private workspace package under `tools/`, and never
published.

The full reference covers the architecture, how verdicts are decided,
the tier and corpus protocol, a checklist for extending it to a pack,
the design for JSX and render boundaries, and the path to a second
language:
[`design/docs-internal/differential-fuzzing.md`](../../design/docs-internal/differential-fuzzing.md).

## In one paragraph

The extraction algorithm promises exhaustiveness and "no false
conditions" ([`docs/theory/extraction-algorithm.md`](../../docs/theory/extraction-algorithm.md)).
This package checks both automatically. fast-check generates handler
programs from a small DSL that is not tied to any framework. Each
program is extracted through the production pipeline (an in-memory
ts-morph project plus the target pack) *and* run in `node:vm` against a
fixed set of requests. A three-valued interpreter evaluates the
summary's transition conditions against each concrete request, and
reports `falseClaim` or `uncovered` verdicts. When a condition is
opaque, the interpreter abstains and never guesses. All framework
syntax is in `target.ts` (`FuzzTarget`). Express and Fastify are
connected, and the sound-tier property runs against both.

## Layout

| File | Role |
|---|---|
| `src/program.ts` | handler-program DSL + framework-neutral renderer |
| `src/generators.ts` | fast-check arbitraries, tiered (sound vs documented-gap) |
| `src/target.ts` | per-pack seam: pack + terminal syntax + module wrapper + vm stub |
| `src/extract.ts` | extraction through the production pipeline (shared in-memory project) |
| `src/execute.ts`, `src/requests.ts` | vm execution + deterministic request batteries |
| `src/interpret.ts` | three-valued Predicate/ValueRef interpreter (future `suss corroborate` core) |
| `src/differential.ts` | adjudicator: `falseClaim` / `uncovered` |
| `src/differential.test.ts` | sound-tier properties (all targets) + gap-rediscovery milestones |
| `src/corpus.test.ts` | permanent shrunk-counterexample corpus |
| `src/jsx/*` | the render boundary: component DSL, TSX transpile + stub `createElement` execution, tree-admissibility judge, its own sound tier / milestone / corpus |
| `src/python/*` | the Python target: Flask/FastAPI program DSL + generators, extraction through `@suss/adapter-python`, a python3 observer harness, and the route-claim adjudicator |
| `longrun.mjs` | exploratory random-seed sessions (`node longrun.mjs jsx 800 3`) |
| `fuzzPython.mjs` | the Python differential run (`node fuzzPython.mjs 200 42`); needs python3 with `python/requirements.txt` installed |

## The families under `src/shape`

Each family generates a whole program around one kind of boundary. It
then runs the invariants, and checks that the program is equivalent to
the plainest way of writing the same behavior. Where a generated
program can be run, it runs it.

| Family | What it varies |
|---|---|
| `shapeProgram.ts` | an HTTP registration call: how the handler is written, bound, and reached |
| `componentShape.ts` | a React component: how it is written, bound, and exported |
| `announceShape.ts` | a NestJS controller: how the class announces the boundary |
| `resolverShape.ts` | a GraphQL field: the Apollo resolver map, and the decorated resolver class |
| `envShape.ts` | a runtime-configuration read: where it is and how it is spelled |
| `queueShape.ts` | a queue consumer: how it is built, and how the project configures the subject it responds to |
| `packageShape.ts` | a package boundary: how a function is published and how another package calls it |

The last two write files and read a template or a manifest back from
disk, so they cost several times as much as the in-memory families.
They take smaller samples on each pull request (`SUSS_FUZZ_QUEUE_RUNS`,
`SUSS_FUZZ_PACKAGE_RUNS`), and the scheduled run covers the larger
volume.

## Running

```sh
npx vitest run                          # full suite, CI defaults (fixed seed)
SUSS_FUZZ_RUNS=500 npx vitest run src/differential.test.ts
SUSS_FUZZ_SEED=12345 npx vitest run     # reproduce a specific CI run
npx tsup && node longrun.mjs sound 1500 4 fastify   # exploratory session
node longFuzz.mjs 4000                  # the scheduled run, every family
node fuzzPython.mjs 200                 # the Python differential (needs python3 + python/requirements.txt)
```
