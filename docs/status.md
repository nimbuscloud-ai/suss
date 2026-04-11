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
| 2.1 `collectAncestorBranches` | ⬜ | Walk AST upward from terminal; record branching constructs. |
| 2.2 `collectEarlyReturns` | ⬜ | Scan prior sibling statements for `if (cond) return/throw`. |
| 2.3 `parseConditionExpression` | ⬜ | AST condition expression → structured `Predicate`. |
| 2.4 `resolveSubject` | ⬜ | Symbol resolution via ts-morph's type checker. |
| 2.5 `findTerminals` | ⬜ | Interpret `TerminalPattern` against AST. |
| 2.6 Discovery logic | ⬜ | `discoverByNamedExport`, `discoverByRegistrationCall`, `discoverByFileConvention`. |
| 2.7 Contract reading | ⬜ | Read ts-rest contracts via ts-morph. |
| 2.8 `createTypeScriptAdapter` wiring | ⬜ | Public API: `extractFromFiles`, `extractAll`. |

## Phase 3 — Framework Packs

*Declarative data for each framework. Mostly transcription.*

| Task | Status | Notes |
|------|--------|-------|
| 3.1 `@suss/framework-ts-rest` | ✅ | Full pack, 5 tests. |
| 3.2 `@suss/framework-react-router` | ✅ | Full pack, 5 tests. |
| 3.3 `@suss/framework-express` | ✅ | Full pack, 5 tests. |

*(Framework packs were implemented ahead of the adapter because they're declarative data. The adapter will validate them against real code in Phase 2.)*

## Phase 4 — CLI + Fixtures

| Task | Status | Notes |
|------|--------|-------|
| 4.1 `@suss/cli` — `extract` and `inspect` | ⬜ | Stub only. |
| 4.2 ts-rest fixture set | ⬜ | Handler + contract + `expected.json`. |
| 4.3 react-router fixture set | ⬜ | Loader + `expected.json`. |
| 4.4 express fixture set | ⬜ | Handler + `expected.json`. |
| 4.5 End-to-end integration test | ⬜ | Adapter run against fixtures, assert expected outputs. |

## Phase 5+ — Deferred

| Item | Status | Notes |
|------|--------|-------|
| Cross-boundary checker | ⏸ | Downstream tool that consumes summaries and flags provider/consumer mismatches. |
| Python adapter | ⏸ | Same `RawCodeStructure` interface, Pyright or ast-grep. |
| React component support | ⏸ | `Input` types beyond `parameter` (hookReturn, contextValue) need `RawCodeStructure` surface. JSX-as-terminal pattern design. |
| Transition ID stability | ⏸ | Current `${name}:${i}` shifts when branches are added. Will hurt `diffSummaries` quality. Fix when Phase 2 produces real data. |
| `TerminalExtraction` constructor case | ⏸ | `{ from: "constructor" }` underspecified — no mapping rules for constructor name → status code. Fix when a framework actually needs it. |
| GitHub Action / CI integration | ⏸ | PR-scoped extraction wrapper. |

## Test coverage

| Package | Tests | Notes |
|---------|-------|-------|
| `@suss/behavioral-ir` | 7 | diff utility, type narrowing |
| `@suss/extractor` | 9 | assembly, gaps (both directions), confidence, opaque wrapping, ValueRef statusCode |
| `@suss/adapter-typescript` | 1 (stub) | Phase 2 placeholder |
| `@suss/framework-ts-rest` | 5 | pack structure, discriminants, bindingExtraction |
| `@suss/framework-react-router` | 5 | pack structure, discovery kinds, inputMapping |
| `@suss/framework-express` | 5 | pack structure, registration, terminals, positional params |
| `@suss/cli` | 1 (stub) | Phase 4 placeholder |
| **Total** | **33** | |

Runs in a couple of seconds via `turbo test`.

## Decisions log

1. **Single language per invocation.** The tool analyzes one tsconfig at a time. Monorepo orchestration is the user's responsibility.
2. **Framework packs are declarative data**, not code. They describe patterns; the adapter interprets them.
3. **The condition extractor is four independent functions.** Each testable with its own fixtures.
4. **Opaque predicates are first-class.** When decomposition fails, preserve source text and mark opaque. Never silently drop.
5. **Dependency resolution degrades gracefully.** In-project → full extraction. Typed dependencies → type info. Untyped → opaque. No config.
6. **ts-morph is the TypeScript foundation.** Public, stable, AST + symbol table + type checker in one package. No SCIP, no LSP.
7. **`RawCodeStructure` is the adapter/extractor boundary.** Extractor never sees AST. Adapter never runs assembly logic.
8. **Maps over switch statements** for dispatch on discriminated unions. `Record<Kind, converter>` enforces exhaustiveness at the type level, no fall-through risk.
