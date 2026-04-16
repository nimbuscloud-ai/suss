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

## Phase 5 — Cross-boundary checker

*Pure function from two `BehavioralSummary`s to `Finding[]`. No AST dependency — operates on serialized IR.*

| Task | Status | Notes |
|------|--------|-------|
| 5.1 `Finding` type in `@suss/behavioral-ir` | ✅ | Discriminated on `FindingKind`; shared across checker and downstream consumers. |
| 5.2 `@suss/checker` package + structural matchers | ✅ | `subjectsMatch`, `predicatesMatch` with `match` / `nomatch` / `unknown` result; handles opaque/unresolved tree-walk. |
| 5.3 Provider-coverage check | ✅ | Status-code matching; default consumer branch covers 2xx; opaque provider statuses emit `lowConfidence`. |
| 5.4 Consumer-satisfaction check | ✅ | Dead-branch detection; opaque provider statuses short-circuit to `lowConfidence`. |
| 5.5 Contract-consistency check | ✅ | Provider gaps reformatted to `providerContractViolation`; consumer checked against declared contract for declared-but-unhandled and handled-but-undeclared cases. |
| 5.6 `checkPair` entrypoint + fixture integration tests | ✅ | Composes all three checks; integration test exercises every finding kind in one pass. |
| 5.7 `suss check` CLI command | ✅ | `suss check <provider.json> <consumer.json>` with `--json` / `-o` output; non-zero exit when any finding has `error` severity. |
| 5.8 Structured body-shape extraction (provider side) | ✅ | Three-pass extraction: syntactic decomposition preserves literal narrowness (`{ type: "literal", value }` with `raw` for numerics); AST resolution follows identifiers / destructurings / single-return calls back to their defining values; type-checker fallback covers the rest. `record` vs `dictionary` distinguishes closed structs from index signatures. Wire-format caveats documented in `ir-reference.md#serialization-semantics`. |
| 5.9 Body-shape matching in the checker | ✅ | `bodyShapesMatch(actual, declared)` returns `match` / `nomatch` / `unknown` with asymmetric subtyping semantics — literal widening (`"ok"` → `text`), integer ⊂ number, union variance, dictionary/array recursion, spreads and refs propagate `unknown`. ts-rest `c.type<T>()` is lifted into `RawDeclaredContract.responses[].body`, and `checkContractConsistency` now emits `providerContractViolation` for body mismatches and `lowConfidence` when the shape is indeterminate. |

## Phase 6 — Consumer-side discovery

*Discover client call sites, extract the enclosing function's branches, produce consumer `BehavioralSummary`s for cross-boundary checking.*

| Task | Status | Notes |
|------|--------|-------|
| 6.1 `clientCall` discovery match + consumer binding extractors | ✅ | New `DiscoveryMatch` variant `clientCall` in `FrameworkPack` interface. `BindingExtraction` gains `fromClientMethod`, `fromArgumentLiteral`, `fromArgumentProperty`. |
| 6.2 `discoverByClientCall` in the TS adapter | ✅ | Finds matching call sites, walks to enclosing function, returns `DiscoveredUnit` with `callSite` metadata. Consumer binding extraction reads method/path from call args or contract. |
| 6.3 `returnStatement` terminal match | ✅ | New `TerminalMatch` variant for any return statement (not just object-literal returns). Required because consumer functions return arbitrary values, not `{ status, body }` objects. |
| 6.4 `readContractForClientCall` | ✅ | Traces from `client.getUser()` → `const client = initClient(contract)` → contract object → endpoint definition for the called method. Reuses existing `resolveContractObject` + `extractEndpointContract`. |
| 6.5 ts-rest consumer discovery pattern | ✅ | `@suss/framework-ts-rest` now includes a `consumer` `DiscoveryPattern` matching `initClient` from `@ts-rest/core`, binding method/path via `fromClientMethod`. |
| 6.6 `@suss/runtime-web` package | ✅ | New package (not "framework" — fetch is a runtime built-in). Discovers `fetch()` calls with literal URL paths, extracts method from options object, defaults to GET. |
| 6.7 Consumer fixtures + end-to-end tests | ✅ | fetch consumer fixture, CLI integration test (`suss extract -f fetch`), end-to-end `extract + check` test. |

### Deferred within consumer-side discovery

- **Template-literal / URL-builder paths** → opaque boundary binding, `lowConfidence` finding.
- **Multiple client calls per function** → first pass: one call site per consumer function, deduplicates on enclosing function.
- **Range-based status matching** → `status >= 400`, `response.ok` conditions produce opaque status predicates today; could be resolved to status ranges in a follow-up.
- **Recursive dependency extraction** → local function calls within the consumer are `invocation` effects, not recursively extracted into their own summaries.
- **axios, tRPC, GraphQL clients** → additive; the mechanism is proven, more packs are data.

## Phase 7 — Deepen cross-boundary analysis

*Closes the gap between the IR's expressive power and the checker's actual analysis depth, so cross-boundary findings catch field-level, predicate-level, and semantic mismatches.*

| Task | Status | Notes |
|------|--------|-------|
| 7.1 Resolve `consumer` kind overload | ✅ | `CodeUnitKind` gains `"client"` for API call sites, distinct from `"consumer"` (message queues). |
| 7.2 Consumer body-field extraction | ✅ | `collectClientFieldAccesses` traces property accesses on the response variable per branch. Populates `RawBranch.expectedInput` → `Transition.expectedInput`. |
| 7.3 Cross-boundary body comparison | ✅ | `checkBodyCompatibility` compares provider body shapes against consumer `expectedInput` using field-presence semantics (`providerCoversConsumerFields`). |
| 7.4 Predicate-level transition matching | ✅ | Sub-case analysis in `checkProviderCoverage`: when provider has N > 1 transitions for the same status, warns if consumer doesn't distinguish them. Uses `predicatesMatch` for structured predicate comparison. |
| 7.5 Automatic boundary pairing | ✅ | `normalizePath` (`:id` ↔ `{id}`), `pairSummaries`, `checkAll`. CLI: `suss check --dir summaries/`. Human-readable pairing report + `--json` structured output. |
| 7.6 Error-to-response bridging | ⬜ | When a provider throws and the framework converts it to an HTTP response, the checker should recognize this as a produced status code. Requires framework-pack-level throw→status mapping. |
| 7.7 Subject resolution through intermediates | ✅ | `resolveSubject` follows non-call initializers (`const data = result.body` → recurse). Depth-bounded at 8 hops. |
| 7.8 Semantic condition bridging | ✅ | `checkSemanticBridging`: when provider transitions produce distinguishing literal body fields (e.g., `status: "deleted"` vs `status: "active"`), checks whether consumer predicates test for them. Known limitations (5 aspiration tests): literal-only discrimination, equality-only matching, hardcoded "body" accessor, ref shapes opaque, `as const` dependency. See [`cross-boundary-checking.md`](cross-boundary-checking.md) §Level 5. |

## Phase 8+ — Deferred

| Item | Status | Notes |
|------|--------|-------|
| Python adapter | ⏸ | Same `RawCodeStructure` interface, Pyright or ast-grep. Multiplier on analysis depth — more valuable after Phase 7. |
| React component support | ⏸ | `Input` types beyond `parameter` (hookReturn, contextValue) need `RawCodeStructure` surface. JSX-as-terminal pattern design. |
| GitHub Action / CI integration | ⏸ | PR-scoped extraction wrapper. Depends on automatic boundary pairing (7.5). |
| Additional client packs | ⏸ | axios, tRPC, GraphQL — additive once the consumer extraction mechanism is proven. |

## Test coverage

| Package | Tests | Notes |
|---------|-------|-------|
| `@suss/behavioral-ir` | 8 | diff utility, type narrowing, Finding shape |
| `@suss/extractor` | 52 | assembly, gaps (both directions), confidence, opaque wrapping, ValueRef statusCode, transition ID stability, edge cases |
| `@suss/adapter-typescript` | 306 | conditions, predicates, subjects (incl. intermediate variable resolution), terminals, discovery (incl. clientCall), contract reading (incl. body schema, consumer contract resolution), shape extraction, consumer binding extraction, field-access tracking, integration |
| `@suss/framework-ts-rest` | 10 | pack shape (handler + consumer discovery) + integration |
| `@suss/framework-react-router` | 7 | pack shape + integration (loader/action transitions, singleObjectParam inputs) |
| `@suss/framework-express` | 7 | pack shape + integration (guard chains, positional inputs, redirect forms) |
| `@suss/runtime-web` | 4 | pack shape + integration (fetch discovery, binding extraction, transitions) |
| `@suss/checker` | 137 | subject/predicate matchers, body-shape matcher, body-compatibility (field presence), semantic bridging (incl. 6 aspiration tests), response-match helpers, provider coverage (incl. sub-case analysis), consumer satisfaction, contract consistency (status + body), path normalization, boundary pairing, `checkPair` integration |
| `@suss/cli` | 34 | deep-equal summary shape per framework, `-o` round-trip, inspect, `suss check`, `suss check --dir`, consumer extraction, end-to-end extract+check, semantic-bridging e2e |
| **Total** | **565** | |

Runs via `turbo test`.

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
10. **`expectedInput` flows through `RawBranch`, not post-assembly patching.** The adapter populates `RawBranch.expectedInput`; the extractor copies it to `Transition.expectedInput` during assembly. This preserves the pipeline contract (adapter → `RawCodeStructure` → extractor → `BehavioralSummary`) and means any future adapter (Python, etc.) gets field-level comparison for free.
11. **`"client"` vs `"consumer"` in `CodeUnitKind`.** `"consumer"` is for message consumers (Kafka, SQS). `"client"` is for API call sites (fetch, ts-rest `initClient`). Different behavioral models: clients branch on response status and read body fields; consumers receive messages and produce effects.
12. **Depth before breadth.** Cross-boundary analysis depth (field-level body comparison, predicate-level transition matching, automatic boundary pairing) takes priority over language breadth (Python adapter, React components). Breadth multiplies depth; adding depth later is a rewrite, adding breadth later is additive.
