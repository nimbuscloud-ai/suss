# @suss/differential

Differential fuzzer for extraction fidelity. Internal tool — a private
workspace package under `tools/`, never published.

Full reference (architecture, adjudication semantics, tier/corpus
protocol, per-pack extension checklist, the JSX/render-boundary
design, second-language path):
[`docs/internal/differential-fuzzing.md`](../../docs/internal/differential-fuzzing.md).

## In one paragraph

The extraction algorithm promises exhaustiveness and "no false
conditions" ([`docs/extraction-algorithm.md`](../../docs/extraction-algorithm.md)).
This package checks both mechanically: fast-check generates
handler-shaped programs from a small framework-neutral DSL; each
program is extracted through the real pipeline (in-memory ts-morph
project + the target pack) *and* executed in `node:vm` against a
deterministic request battery; a three-valued interpreter (opaque →
abstain, never guess) evaluates the summary's transition conditions
against each concrete request and flags `falseClaim` / `uncovered`
verdicts. Framework syntax lives entirely in `target.ts`
(`FuzzTarget`) — Express and Fastify are wired, and the sound-tier
property runs against both.

## Layout

| File | Role |
|---|---|
| `src/program.ts` | handler-program DSL + framework-neutral renderer |
| `src/generators.ts` | fast-check arbitraries, tiered (sound vs documented-gap) |
| `src/target.ts` | per-pack seam: pack + terminal syntax + module wrapper + vm stub |
| `src/extract.ts` | real-pipeline extraction (shared in-memory project) |
| `src/execute.ts`, `src/requests.ts` | vm execution + deterministic request batteries |
| `src/interpret.ts` | three-valued Predicate/ValueRef interpreter (future `suss corroborate` core) |
| `src/differential.ts` | adjudicator: `falseClaim` / `uncovered` |
| `src/differential.test.ts` | sound-tier properties (all targets) + gap-rediscovery milestones |
| `src/corpus.test.ts` | permanent shrunk-counterexample corpus |
| `src/jsx/*` | the render boundary: component DSL, TSX transpile + stub `createElement` execution, tree-admissibility judge, its own sound tier / milestone / corpus |
| `longrun.mjs` | exploratory random-seed sessions (`node longrun.mjs jsx 800 3`) |

## Running

```sh
npx vitest run                          # full suite, CI defaults (fixed seed)
SUSS_FUZZ_RUNS=500 npx vitest run src/differential.test.ts
SUSS_FUZZ_SEED=12345 npx vitest run     # reproduce a specific CI run
npx tsup && node longrun.mjs sound 1500 4 fastify   # exploratory session
```
