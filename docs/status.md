# Status

Progress tracker. Updated as phases land.

## Legend

- ✅ done
- 🚧 in progress
- ⬜ not started
- ⏸ deferred / future

## Phase 1 — Foundation

*Types, assembly engine, framework pack interface. No compiler, no AST.*

| Task | Status | Notes |
|------|--------|-------|
| 1.1 Monorepo scaffold | ✅ | turbo + npm workspaces + tsup + vitest. 7 packages. |
| 1.2 `@suss/behavioral-ir` types and utilities | ✅ | Full IR + `diffSummaries`. 7 tests. |
| 1.3 `@suss/extractor` assembly engine | ✅ | `assembleSummary`, `detectGaps` (both directions), `assessConfidence`. Map-based converters. 9 tests. |
| 1.4 `FrameworkPack` interface | ✅ | Lives in `@suss/extractor/framework`. |

## Phase 2 — TypeScript Adapter

*The hard part. Uses ts-morph. Four independently testable extraction functions.*

| Task | Status | Notes |
|------|--------|-------|
| 2.1 `collectAncestorBranches` + `collectEarlyReturns` | ✅ | Pure AST walk. if/else, switch, try/catch, ternary, &&/||, early-return guards. 24 tests. |
| 2.2 `parseConditionExpression` + `resolveSubject` | ✅ | Condition → `Predicate`; identifier/property chain → `ValueRef`. Symbol resolution via ts-morph. 47 tests. |
| 2.3 `findTerminals` | ✅ | returnShape, parameterMethodCall, throwExpression, functionCall matching. Ternary branch support. `as const` unwrapping. |
| 2.4 Discovery logic | ✅ | `discoverByNamedExport`, `discoverByRegistrationCall`, `discoverByFileConvention`. Import tracing via symbol resolution. |
| 2.5 Assembly wiring | ✅ | `extractRawBranches` + `extractDependencyCalls` (nested block traversal). Parameter extraction with input mapping. |
| 2.5b Contract reading + adapter API | ✅ | `readContract` with cross-file import resolution. `createTypeScriptAdapter`: `extractFromFiles`, `extractAll`. Integration tests. |

## Phase 3 — Framework Packs

*Declarative data for each framework. Mostly transcription.*

| Task | Status | Notes |
|------|--------|-------|
| 3.1 `@suss/framework-ts-rest` | ✅ | Full pack, 5 tests. |
| 3.2 `@suss/framework-react-router` | ✅ | Full pack, 5 tests. |
| 3.3 `@suss/framework-express` | ✅ | Full pack, 5 tests. |

*(Framework packs were implemented ahead of the adapter as declarative data. Enhanced during Phase 2 with additional terminal patterns: Express gained res.status().send(), res.sendStatus(), res.redirect(); React Router gained json(), data(), redirect() functionCall terminals.)*

## Phase 4 — CLI + Fixtures

| Task | Status | Notes |
|------|--------|-------|
| 4.1 `@suss/cli` — `extract` and `inspect` | ✅ | `suss extract` with dynamic framework resolution, `suss inspect` with human-readable output. 11 tests. |
| 4.2 ts-rest fixture set | ✅ | Handler + contract. Gap exercise (500 declared but unproduced). |
| 4.3 react-router fixture set | ✅ | Loader + action with json/redirect helpers. |
| 4.4 express fixture set | ✅ | Handler with guards, dep calls, nested conditions. |
| 4.5 End-to-end integration test | ✅ | CLI tests run live extraction against all 3 fixture sets. |

## Phase 5+ — Deferred

| Item | Status | Notes |
|------|--------|-------|
| Cross-boundary checker | ⏸ | Downstream tool that consumes summaries and flags provider/consumer mismatches. |
| Python adapter | ⏸ | Same `RawCodeStructure` interface, Pyright or ast-grep. |
| React component support | ⏸ | `Input` types beyond `parameter` (hookReturn, contextValue) need `RawCodeStructure` surface. JSX-as-terminal pattern design. |
| GitHub Action / CI integration | ⏸ | PR-scoped extraction wrapper. |

## Test coverage

| Package | Tests | Notes |
|---------|-------|-------|
| `@suss/behavioral-ir` | 7 | diff utility, type narrowing |
| `@suss/extractor` | 41 | assembly, gaps (both directions), confidence, opaque wrapping, ValueRef statusCode, edge cases |
| `@suss/adapter-typescript` | 213 | conditions, predicates, subjects, terminals, discovery, contract reading, integration |
| `@suss/framework-ts-rest` | 5 | pack structure, discriminants, bindingExtraction |
| `@suss/framework-react-router` | 5 | pack structure, discovery kinds, inputMapping |
| `@suss/framework-express` | 6 | pack structure, registration, terminals, positional params |
| `@suss/cli` | 11 | extract (3 frameworks), inspect, error cases, gap detection, file output |
| **Total** | **288** | |

Runs in ~10s via `turbo test`.

## Decisions log

1. **Single language per invocation.** The tool analyzes one tsconfig at a time. Monorepo orchestration is the user's responsibility.
2. **Framework packs are declarative data**, not code. They describe patterns; the adapter interprets them.
3. **The condition extractor is four independent functions.** Each testable with its own fixtures.
4. **Opaque predicates are first-class.** When decomposition fails, preserve source text and mark opaque. Never silently drop.
5. **Dependency resolution degrades gracefully.** In-project → full extraction. Typed dependencies → type info. Untyped → opaque. No config.
6. **ts-morph is the TypeScript foundation.** Public, stable, AST + symbol table + type checker in one package. No SCIP, no LSP.
7. **`RawCodeStructure` is the adapter/extractor boundary.** Extractor never sees AST. Adapter never runs assembly logic.
8. **Maps over switch statements** for dispatch on discriminated unions. `Record<Kind, converter>` enforces exhaustiveness at the type level, no fall-through risk.
9. **Biome 2.x for linting and formatting.** No ESLint, no Prettier. Pre-commit hook (husky + lint-staged) runs `biome check --write` on staged files. `turbo lint` / `turbo lint:fix` available at the root. See `docs/style.md` for the full style guide.
