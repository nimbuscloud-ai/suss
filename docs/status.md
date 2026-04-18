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
| 1.4 `PatternPack` interface | ✅ | Lives in `@suss/extractor/framework`. |

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
| 6.1 `clientCall` discovery match + consumer binding extractors | ✅ | New `DiscoveryMatch` variant `clientCall` in `PatternPack` interface. `BindingExtraction` gains `fromClientMethod`, `fromArgumentLiteral`, `fromArgumentProperty`. |
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
| 7.6 Error-to-response bridging | ✅ | Throw terminals with framework-extracted status codes are converted to response outputs at the extractor level. Behavioral contract (consumer sees HTTP status, not exception) takes priority over mechanism (code threw). Unhandled throws without status codes remain as throw outputs. |
| 7.7 Subject resolution through intermediates | ✅ | `resolveSubject` follows non-call initializers (`const data = result.body` → recurse). Depth-bounded at 8 hops. |
| 7.8 Semantic condition bridging | ✅ | `checkSemanticBridging`: literal discrimination, field-presence discrimination, truthiness checks, negated comparisons (`!== X`), fetch `.json()` body accessor, "any match suppresses" semantics. All 6 original aspirations resolved or reclassified — remaining gaps are Level 6 (local function inlining). See [`cross-boundary-checking.md`](cross-boundary-checking.md) §Level 5. |
| 7.9 `PatternPack` rename + response property semantics | ✅ | `FrameworkPack` → `PatternPack` across all packages. `ResponsePropertyMapping` declares response property semantics (statusCode, statusRange, body, headers). Adapter resolves `.ok` → `status >= 200 && status <= 299` at extraction time. Pack-driven field filtering in `collectClientFieldAccesses` replaces hardcoded property lists. |
| 7.10 Opaqueness reductions: instanceof, in, Array.includes | ✅ | `instanceof` → `typeCheck`, `in` → `propertyExists`, `[lit].includes(x)` → compound OR. Default status codes for Express/React Router implicit-200 terminals via `defaultStatusCode` in `TerminalExtraction`. |
| 7.11 Behavioral summary format spec | ✅ | JSON Schema v0 (`packages/ir/schema/behavioral-summary.schema.json`), format spec (`docs/behavioral-summary-format.md`), publishing convention (`suss.summaries` in package.json), portable relative paths, schema validation tests. Inspect rewrite: output-first behavioral descriptions with body shapes and contract display. |

## Phase 8 — Real-world readiness

*Production-grade coverage of the dominant ecosystem patterns: a second server framework, a second HTTP client with all the shapes real codebases use, declared-contract stubs for cross-team and cross-org checking, governance scaffolding, and a runnable example.*

| Task | Status | Notes |
|------|--------|-------|
| 8.1 `@suss/framework-fastify` | ✅ | Full pack, 8 tests. `Fastify()` and named-import `fastify()` discovery, `reply.code/status(N).send(body)` chains, implicit-200 `reply.send(body)`, `reply.redirect(...)` with 1-arg/2-arg disambiguation, throw matcher, positional `(request, reply)` inputs. |
| 8.2 `@suss/runtime-axios` | ✅ | Per-verb discovery via `methodFilter` + literal-method bindings, `factoryMethods: ["create"]` so `const api = axios.create(...); api.get(...)` is matched, AxiosResponse semantics (`.data` body, `.status` statusCode). 7 tests. |
| 8.3 Adapter `clientCall` enhancements | ✅ | Direct method calls on the imported binding (`axios.get(...)`) and not just on call-result variables; each `DiscoveredUnit` carries the source pattern so kind-sharing patterns (per-verb axios) pick the right binding. |
| 8.4 Template-literal path extraction | ✅ | `fromArgumentLiteral` matches `NoSubstitutionTemplateLiteral` and `TemplateExpression`; substitutions become OpenAPI-style `{name}` placeholders that pair with `:id`-style provider paths via the existing path normaliser. |
| 8.5 Destructured response support | ✅ | `findResponseAccessor` returns identifier OR destructured shape (mapping local → underlying property); `collectPropertyAccesses` resolves bare destructured uses to property chains. Status check via destructured `status` is recognised in the checker (`refLooksLikeStatus`). |
| 8.6 Pack-aware body unwrap | ✅ | Adapter records pack body-typed accessor names on each client summary's `metadata.http.bodyAccessors`; checker reads it and tries each accessor when unwrapping `expectedInput`. Falls back to `["body"]` for legacy summaries. Fixes false-positive body-shape findings for axios consumers. |
| 8.7 Optional-field tracking | ✅ | OpenAPI `required` set is preserved; non-required properties become `union<T, undefined>`. Body-compatibility unwraps optional unions before recursing AND emits info-level `consumerContractViolation` findings for consumer reads of optional fields via `findOptionalAccesses`. |
| 8.8 Wrapper expansion | ✅ | Path-passthrough wrappers (`getJson(path)` forwarding to `axios.get(path)`) get per-caller summaries via post-pass: ts-morph references → caller's literal/template-literal arg → synthetic `DiscoveredUnit` → full `extractCodeStructure` pipeline. Caller-side branch tracking and `expectedInput` work; multi-hop and method-as-parameter wrappers deferred. |
| 8.9 `@suss/stub-openapi` | ✅ | OpenAPI 3.x → `BehavioralSummary[]` with `$ref` cycle protection, `oneOf`/`anyOf`/`allOf`, `nullable`, `enum`, `additionalProperties` → `dictionary`, file/JSON/YAML loading. 31 tests. |
| 8.10 `@suss/stub-cloudformation` | ✅ | CFN/SAM templates: inline OpenAPI bodies (REST/HTTP API + SAM `Body`/`DefinitionBody`), CFN-native `AWS::ApiGateway::Method` walks (resolves path via `ResourceId` chain through `AWS::ApiGateway::Resource`), `AWS::ApiGatewayV2::Route` parsing, CloudFormation YAML intrinsic shorthand (`!Ref`, `!GetAtt`, pass-through for `!Sub`/`!Join`/etc.). 22 tests. |
| 8.11 `suss stub` CLI command | ✅ | `suss stub --from <openapi\|cloudformation> <spec>` with uniform loader registry. Plumbs into `suss check --dir` so stub providers and extracted consumers pair seamlessly. |
| 8.12 Inspect refactor | ✅ | All five `switch (x.type)` dispatches in `inspect.ts` converted to typed `DispatchTable<T, R>` maps; `formatBodyShape` now renders all `TypeShape` variants (the prior switch silently dropped primitives like `text`, `integer`, leading to `{ [key]:  }` for dictionary values). |
| 8.13 OSS governance | ✅ | `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `.github/ISSUE_TEMPLATE/` (bug + feature + config), `.github/PULL_REQUEST_TEMPLATE.md`, npm publish metadata across all packages. |
| 8.14 Runnable end-to-end example | ✅ | `examples/petstore-axios-openapi/` — axios consumer + Petstore OpenAPI + Makefile that runs extract → stub → check. Doubles as a regression test for the full pipeline. |

### Deferred within Phase 8

- **`axios.create()` instances with `axios({ url, method })` bare-call form and `axios.request(config)`** — only per-verb method calls are matched.
- **Aliased default imports** (`import myAxios from "axios"`) — pack matches the conventional `import axios from "axios"` only.
- **Multi-hop wrapper expansion** (helper-of-helper) — single hop only.
- **Method-as-parameter wrappers** (`fetch(method, path)`) — only path-passthrough is recognised.
- **`BodyS3Location`** in CloudFormation — out-of-line OpenAPI bodies aren't fetched.
- **Raw CDK source** — consume `cdk synth` output instead.
- **Greedy `{proxy+}` paths** — extracted verbatim into the boundary path; the checker doesn't normalise them as wildcards, so consumer calls with concrete sub-paths won't pair against a `/{proxy+}` provider.
- **`!Sub` partial resolution** — `!Sub "${ResourceLogicalId.Arn}"` and parameter interpolations are passed through as their raw template strings. Doesn't matter for path/method extraction (paths are usually literal in practice) but does mean integration URIs lose their resource references.
- **`!ImportValue` cross-stack tracking** — silently passed through. Useful for graph extraction across stacks; not load-bearing for behavioural summaries within a single template.
- **Non-HTTP triggers** (`AWS::Lambda::EventSourceMapping`, `AWS::Events::Rule`, `AWS::SNS::Subscription`) — would each warrant their own resource-semantics package (`@suss/stub-aws-sqs`, `@suss/stub-aws-eventbridge`, etc.) following the same reader/semantics split as `aws-apigateway`. Out of scope while the focus is HTTP boundaries.

## Phase 9+ — Deferred

| Item | Status | Notes |
|------|--------|-------|
| Python adapter | ⏸ | Same `RawCodeStructure` interface, Pyright or ast-grep. |
| React component support | ⏸ | `Input` types beyond `parameter` (hookReturn, contextValue) need `RawCodeStructure` surface. JSX-as-terminal pattern design. |
| GitHub Action / CI integration | ⏸ | PR-scoped extraction wrapper. |
| GraphQL / gRPC stubs | ⏸ | Different protocol shape than HTTP req/resp; the IR's `boundaryBinding` doesn't currently model RPC method + service or query/mutation operation. |
| OpenAPI 3.1 nullability + `discriminator` polymorphism | ⏸ | Today only OpenAPI 3.0's `nullable: true` is recognised; `type: ["string", "null"]` in 3.1 isn't yet. |

## Test coverage

| Package | Tests | Notes |
|---------|-------|-------|
| `@suss/behavioral-ir` | 12 | diff utility, type narrowing, Finding shape, JSON Schema validation |
| `@suss/extractor` | 55 | assembly, gaps (both directions), confidence, opaque wrapping, ValueRef statusCode, throw-to-response bridging, transition ID stability, edge cases |
| `@suss/adapter-typescript` | 345 | conditions, predicates (incl. instanceof, in operator, Array.includes expansion), subjects (incl. intermediate variable resolution), terminals (incl. defaultStatusCode fallback), discovery (clientCall + factoryMethods + direct method-on-import), contract reading, shape extraction, consumer binding (incl. template literals), field-access tracking (incl. destructured response), response property resolution, wrapper expansion, integration |
| `@suss/framework-ts-rest` | 10 | pack shape (handler + consumer discovery) + integration |
| `@suss/framework-react-router` | 7 | pack shape + integration (loader/action transitions, default status codes, singleObjectParam inputs) |
| `@suss/framework-express` | 7 | pack shape + integration (guard chains, positional inputs, redirect forms, default status codes) |
| `@suss/framework-fastify` | 8 | pack shape + integration (Fastify + named-import discovery, reply.code/status chains, redirect, throw, defaults) |
| `@suss/runtime-web` | 4 | pack shape + integration (fetch discovery, binding extraction, transitions) |
| `@suss/runtime-axios` | 7 | pack shape + integration (per-verb discovery, axios.create instances, response semantics) |
| `@suss/checker` | 158 | subject/predicate matchers, body-shape matcher, body-compatibility (field presence + optional fields), semantic bridging, response-match helpers (incl. destructured + nested derived statuses), provider coverage, consumer satisfaction, contract consistency, consumer contract leakage, path normalization, boundary pairing, `checkPair` integration |
| `@suss/stub-openapi` | 31 | basic mapping, `$ref` cycles, schema features (oneOf/anyOf/allOf/nullable/enum/additionalProperties), required→optional encoding, file loading |
| `@suss/stub-cloudformation` | 22 | inline OpenAPI bodies (REST/HTTP API/SAM), CFN-native AWS::ApiGateway::Method walks (with ParentId chain resolution + Fn::GetAtt + bare strings), AWS::ApiGatewayV2::Route, YAML intrinsic shorthand |
| `@suss/cli` | 49 | deep-equal summary shape per framework, `-o` round-trip, inspect (behavioral descriptions, snapshot pinning), `suss check`, `suss check --dir`, `suss stub`, consumer extraction, end-to-end extract+check, semantic-bridging e2e |
| **Total** | **715** | |

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
13. **Reduce opaqueness recursively.** When the extractor encounters something it can't decompose (call expression, unresolved reference), it should try to resolve through it — inline the function body, follow the variable chain, look up the type. Same recursive strategy at every level. Opaque predicates are the honest fallback, not the first resort.
14. **`FrameworkPack` → `PatternPack` (done).** The interface describes discovery patterns, terminal extraction, and binding extraction. It applies equally to frameworks (Express, ts-rest) and runtime APIs (fetch). `@suss/runtime-web` uses the same interface. Renamed alongside response property semantics (7.9).
15. **Response property semantics belong in the pack, not the checker (done).** Properties like `.ok` (fetch) and `.body` (ts-rest) have framework/runtime-specific relationships to the HTTP status code and response body. The pack declares these semantics via `ResponsePropertyMapping[]` so the adapter resolves derived properties (`.ok` → `status >= 200 && status <= 299`) at extraction time. The checker never needs to know about framework-specific response shapes.
16. **Throw-with-status converts to response at extraction time.** When a framework pack extracts a status code from a thrown value, the extractor produces a `response` output, not a `throw` output. The behavioral contract (what the consumer sees) takes priority over the mechanism (how the code achieves it). This keeps transition IDs stable across throw↔direct-response refactors.
17. **Stubs are first-class.** Summary generators that don't extract from source (`@suss/stub-openapi`, `@suss/stub-cloudformation`) emit the same `BehavioralSummary[]` shape as the extractor and carry `confidence.source: "stub"`. The cross-boundary checker pairs stub providers with extracted consumers without any source-aware logic — pairing is by `(method, normalisedPath)` regardless of where each side came from. This is what lets a TypeScript axios consumer be checked against a Stripe / GitHub / internal-team API whose handlers we can't extract from source.
18. **Pack-aware checker via summary metadata.** The body-compatibility checker can't be hardcoded to fetch's `.body` accessor — axios uses `.data`, ts-rest uses `.body`, custom packs vary. Adapter writes `metadata.http.bodyAccessors` on each client summary from the pack's response semantics; checker reads it. Same pattern scales to other pack-specific knowledge (status accessor names via `metadata.http.statusAccessors`, request body accessors, etc.). Keys live under `metadata.http.*` — see decision #25.
19. **Wrapper expansion is a post-pass over the discovered summaries.** Path-passthrough wrappers (`getJson(path)` forwarding to `axios.get(path)`) are recognised after the per-file discovery completes. ts-morph references find callers across the project; each caller gets a synthetic `DiscoveredUnit` fed back through `extractCodeStructure` with a synthetic pack. This reuses every existing analysis (terminal extraction, branch tracking, expectedInput) instead of growing a parallel synthesis path.
20. **Stub doctrine is documented separately.** Reader/semantics layering (manifest reader builds normalized config → resource-semantics package emits summaries), the opaque-predicate naming convention for transcribed external contracts (`<vendor>:<service>:<contract>`), per-transition `metadata` for provenance, and the rule that multiple platform causes for the same status collapse into one transition rather than forcing consumer disambiguation — see [`docs/stubs.md`](stubs.md). This extends decision #17 with concrete conventions so additional stubs (CDK synth, Terraform, vendor-doc transcriptions) follow the same shape.
21. **`Transition.metadata` is a first-class field.** Optional `Record<string, unknown>` on every `Transition`, mirroring `BehavioralSummary.metadata`. Used by stubs to attribute platform-injected transitions to their source manifest, by the checker as ignored opaque payload, and by inspect/diff to render provenance. Added in IR alongside the stub doctrine work — additive, doesn't affect checker semantics.
22. **`BOUNDARY_ROLE` lookup replaces hardcoded provider/consumer kind sets.** The pairing logic previously enumerated `PROVIDER_KINDS = {handler, loader, action, middleware, resolver}` and silently dropped `worker`, `component`, `hook` into `noBinding`. Replaced with a single `Record<CodeUnitKind, BoundaryRole>` exported from `@suss/behavioral-ir` so adding a new code-unit kind produces a TS error if its role is missing, and so the classification has one source of truth across packages.
23. **zod is the IR's single source of truth.** Behavioral summary types are derived from zod schemas in `packages/ir/src/schemas.ts` via `z.infer`, the JSON Schema published for non-TS consumers is generated from the same schemas at build time (`z.toJSONSchema`), and the runtime parsers (`parseSummaries`, `safeParseSummaries`) are exposed for boundary validation in CLI and downstream tools. This replaces the prior hand-written-types + hand-built-JSON-Schema split (kept aligned only by an Ajv test). The "zero dependencies" line on `@suss/behavioral-ir` is gone — it now has one peer dep on `zod ^4.0.0`. The trade-off: bundlers that inline transitively-reached generic types can produce large `.d.ts` files; `safeParse*` returns are explicitly annotated to keep declarations small (~3 KB instead of ~1 MB).
24. **Status property names come from the pack, not from a hardcoded list.** The checker previously matched only `"status"` and `"statusCode"` when finding status-eq predicates in consumer transitions. Now the adapter writes `metadata.http.statusAccessors` on each client summary from the pack's `responseSemantics` (entries with `semantics.type: "statusCode"`), parallel to `metadata.http.bodyAccessors`. The checker reads `statusAccessorsFor(summary)` once per check and passes a `ReadonlySet<string>` through `consumerExpectedStatuses`/`refLooksLikeStatus`. Falls back to the historical `["status", "statusCode"]` for hand-written summaries or summaries produced before this metadata existed. Also dedupes the duplicated `isStatusRef`/`isStatusName` helpers that lived in both `response-match.ts` and `provider-coverage.ts`.
25. **Summary metadata is namespaced by boundary semantics; layered-boundary design is the north star.** HTTP-scoped metadata keys (`declaredContract`, `bodyAccessors`, `statusAccessors`) live under `metadata.http.*` rather than at the top level of `metadata`. This signals scope so future GraphQL / Lambda-invoke / queue-message packs can own sibling namespaces (`metadata.graphql.*`, `metadata.lambda.*`, etc.) without migration. Semantics-neutral keys (e.g. `metadata.derivedFromWrapper` wrapper-expansion provenance) stay at the top level. The checker is still HTTP-coupled end-to-end — status codes as discriminator, response body as payload, `(method, normalizedPath)` as pairing key, 2xx success range. Refactoring that coupling into a `BoundarySemantics` interface waits for a second concrete semantics to forcing-function the seams (GraphQL is the planned first target because it shares transport with REST but has different discriminator / payload / pairing shape). See [`docs/boundary-semantics.md`](boundary-semantics.md) for the layered transport / semantics / recognition model and what the refactor will look like when it lands.
