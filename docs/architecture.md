# Architecture

suss extracts **behavioral summaries** from source code: structured descriptions of what each piece of code does, in terms of conditions and observable outputs. The summary is the product. Downstream tools — checkers, query layers — operate on the summaries without caring whether the source was TypeScript, Python, or anything else.

> **Related reading:**
> - [`motivation.md`](motivation.md) for the *why*
> - [`extraction-algorithm.md`](extraction-algorithm.md) for the detailed algorithm
> - [`ir-reference.md`](ir-reference.md) for the type-by-type walkthrough
> - [`packs.md`](packs.md) for what packs are
> - [`guides/writing-a-pack.md`](guides/writing-a-pack.md) for pattern-writing

## Behavior, not structure

Most analysis tools describe *structure*: a function takes these parameters, returns this type, calls these other functions. suss describes *behavior*: under what conditions a piece of code produces what output, with what side effects.

Concretely, this ts-rest handler:

```typescript
export const getUser = async ({ params }: { params: { id: string } }) => {
  const user = await db.findById(params.id);
  if (!user) {
    return { status: 404, body: { error: "not found" } };
  }
  return { status: 200, body: user };
};
```

becomes two transitions: one returns 404 when `user` is null, the other returns 200 with a `User` shape. The output isn't "this returns a Promise<{ status, body }>" — it's the conditions under which each shape comes out, expressed structurally enough to compare against the contract on the other side.

### What counts as a boundary

The example above is HTTP, but suss treats "boundary" generally — anywhere code interacts with something whose other side might disagree. The HTTP example is one shape. A package export is another: you publish `parseConfig(input: string)`, someone imports it, the boundary is the function signature and the consumers are every call site in every package that imports it. Same machinery in both cases — discover the producer, discover the consumers, extract behavior, pair, compare.

### What pairing summaries lets you do

Two summaries from anywhere in the system get compared by the same checker. Frontend ↔ backend, declared contract ↔ implementation, library ↔ caller. The summary format being uniform is what makes the comparisons composable; the checker doesn't care which frameworks produced its inputs.

## Data flow

Extraction is a straight line with one intermediate data shape, `RawCodeStructure`, between the AST-shaped layer (the adapter) and the assembly layer (the extractor):

```
Source files
    │
    │  Language adapter (@suss/adapter-typescript)
    │    loads project via compiler API (ts-morph)
    │    uses pack patterns to discover code units
    │    for each unit: finds terminals, walks condition chains,
    │                    resolves subjects, reads declared contracts
    ▼
RawCodeStructure
    │
    │  Assembly engine (@suss/extractor)
    │    normalizes predicates (wraps unstructured as opaque)
    │    detects gaps (declared ↔ produced mismatches)
    │    assesses confidence
    ▼
BehavioralSummary[]   — JSON, language- and framework-agnostic
```

See [`pipelines.md`](pipelines.md) for per-CLI-action walkthroughs.

The split between adapter and extractor is deliberate. The extractor never sees an AST node — it works on `RawCodeStructure`, a plain data shape. This means:

1. **The extractor is directly testable** with hand-crafted input. Tests run in milliseconds, no compiler involved.
2. **Adding a new language** means writing a new adapter that produces `RawCodeStructure`. The extractor doesn't change.
3. **Pack authors** never touch the adapter or extractor — they describe patterns declaratively.

## Vocabulary

These terms are used consistently across the codebase. The running example is the `getUser` handler above.

**[Code unit](ir-reference.md#codeunitkind)** — a callable piece of code (handler, loader, component, resolver, consumer, library function). The atomic unit of analysis. Every code unit has a **kind** that determines its behavioral model. `getUser` is a code unit of kind `"handler"`.

**Boundary** — an identifiable point of interaction (REST endpoint, GraphQL operation, queue topic, package export, env-var read). Boundaries are where behavioral contracts matter. For `getUser`, the boundary is `GET /users/:id`.

**Terminal** — a point in a code unit where observable output is produced. Each `return` in `getUser` is a terminal. Other shapes: `res.status(400).json(...)` in Express, `throw httpErrorJson(404)` in React Router, a JSX return in a React component.

**[Transition](ir-reference.md#transition)** — `(conditions → output, effects)`. The atomic unit of behavioral description. A code unit's full behavior is its set of transitions. `getUser` has two:

```json
[
  {
    "id": "getUser:0",
    "conditions": [{ "type": "truthinessCheck", "subject": <user>, "negated": true }],
    "output": { "type": "response", "statusCode": { "type": "literal", "value": 404 }, ... },
    "isDefault": false
  },
  {
    "id": "getUser:1",
    "conditions": [],
    "output": { "type": "response", "statusCode": { "type": "literal", "value": 200 }, ... },
    "isDefault": true
  }
]
```

**[Effect](ir-reference.md#effect)** — an observable side effect a code unit causes during execution: writing to a database, sending a queue message, scheduling work, reading a config value, calling another service. Effects are part of the output alongside the terminal value, because two implementations that produce the same return shape but different side effects don't agree.

**[Predicate](ir-reference.md#predicate)** — a structured condition gating a transition. Has a **subject** (what value is tested), a **test** (nullness, equality, etc.), and composes into `and` / `or` / `negation`. The source expression `!user` becomes a `truthinessCheck` predicate against the subject `db.findById`'s result, with `negated: true`. When the extractor can't decompose an expression, it falls back to an `opaque` predicate that preserves the source text.

**[Subject / ValueRef](ir-reference.md#valueref)** — a reference to a value with an *origin* (parameter, dependency call, import, context) and a *path* (property access chain). Shallow on purpose: identifies what's being tested without trying to understand its full semantics. Two predicates that test the same subject — on different sides of a service boundary — should be recognizable as referring to the same thing. That's why the shape is structural, not a raw string.

**[Output](ir-reference.md#output)** — what a terminal produces. One of: `response`, `throw`, `render`, `return`, `delegate`, `emit`, or `void`.

**[Gap](ir-reference.md#gap)** — a case the code unit doesn't explicitly handle. Recorded in the summary, not raised as an error. Gaps run both directions: declared-but-not-produced (e.g. the contract says the endpoint can return 500, but the handler never produces one) and produced-but-not-declared (the handler returns a shape the contract didn't list).

**Declared contract** — a machine-readable behavioral declaration authored alongside the implementation: a ts-rest router, an OpenAPI document, a GraphQL SDL, a Prisma schema, a Storybook story. The extractor reads both the declaration and the implementation, and the checker compares them.

**Recognizer** — a pack-declared rule that fires when the extractor encounters a specific call or property access (`setTimeout(...)`, `process.env.X`, `__dirname`). Recognizers attach effects or other metadata to whichever code unit they fire inside.

**Sub-unit** — a code unit synthesized inside another code unit (a callback passed to `setTimeout`, an arrow inside `array.forEach`, a Promise executor). Sub-units exist so recognizers can fire on nested function bodies that wouldn't otherwise be discovered as their own units.

**Pack** — declarative patterns the adapter and extractor consume. Packs come in four kinds — framework, runtime, contract, client — described in the next section. Packs are data, not code.

**[Confidence](ir-reference.md#confidenceinfo)** — how much of a code unit's behavior was structurally analyzed vs. opaque. Computed as the ratio of opaque predicates to total predicates, bucketed into `high` / `medium` / `low`. Falls back to opaque predicates when the extractor can't decompose something, so downstream consumers can treat low-confidence summaries with appropriate skepticism.

## Packages and what each owns

```
@suss/ir-core                shared IR primitives: TypeShape, boundary
    │                        bindings + boundaryKey, source locations,
    │                        confidence. Both IRs build on this; neither
    │                        depends on the other.
    │
    ├─ @suss/intent-ir       team-authored intent IR: IntentDoc (authoring),
    │     │                  IntentSummary (checkable form), IntentFinding.
    │     │
    │     ├─ @suss/contract-intent   *.intent / *.prd reader → IntentSummary
    │     │                          (not BehavioralSummary — intent is its
    │     │                          own artifact stream)
    │     │
    │     └─ @suss/checker-intent    intent ↔ code checker; also consumes
    │                                behavioural summaries. IR-only consumer.
    │
@suss/behavioral-ir          zod schemas, types, parsers. Install this to
    │                        consume summaries.
    │
    ├─ @suss/extractor       assembly engine + PatternPack interface.
    │     │                  No AST access.
    │     │
    │     ├─ @suss/adapter-typescript    ts-morph-based extraction
    │     │
    │     ├─ Framework packs             discover handlers, define terminals
    │     │     @suss/framework-ts-rest          and inputs for a framework
    │     │     @suss/framework-express
    │     │     @suss/framework-fastify
    │     │     @suss/framework-react
    │     │     @suss/framework-react-router
    │     │     @suss/framework-nestjs-rest
    │     │     @suss/framework-nestjs-graphql
    │     │     @suss/framework-apollo
    │     │     @suss/framework-aws-sqs
    │     │     @suss/framework-prisma
    │     │
    │     ├─ Client packs                consumer-side discovery
    │     │     @suss/client-web         (fetch)
    │     │     @suss/client-axios
    │     │     @suss/client-apollo
    │     │
    │     └─ Runtime packs               runtime-defined behavior
    │           @suss/runtime-node             (setTimeout, process.*, etc.)
    │
    ├─ Contract packs                    external spec → BehavioralSummary
    │     @suss/contract-openapi
    │     @suss/contract-graphql
    │     @suss/contract-aws-apigateway
    │     @suss/contract-cloudformation  (delegates to openapi + apigateway)
    │     @suss/contract-appsync
    │     @suss/contract-prisma
    │     @suss/contract-storybook
    │
    └─ @suss/checker         pairwise cross-boundary checker. IR-only consumer.
          │
       @suss/cli             thin wrapper over extractor + checkers + contracts.
                             The orchestration seam: loads both artifact
                             streams (behavioural + intent) and dispatches to
                             the matching checker.
```

### Dependency rules

- `@suss/ir-core` — one peer dep on `zod`. Primitives both IRs share (`TypeShape`, `BoundaryBinding` + `boundaryKey`, `SourceLocation`, `ConfidenceInfo`) plus the comparison primitives both checkers share (`bodyShapesMatch`). Intent and behaviour describe boundaries the same way because they build on the same vocabulary; neither IR depends on the other.
- `@suss/behavioral-ir` — one peer dep on `zod`. Runtime validators (`parseSummaries`, `safeParseSummaries`) and the generated JSON Schema both come from the zod schemas. This is what downstream consumers install.
- `@suss/intent-ir` — depends on `ir-core` only. Authoring schema (`IntentDoc`), checkable form (`IntentSummary`), and the intent finding shape (`IntentFinding` — deliberately not the behavioural `Finding`, which is a two-sided peer comparison; intent findings are one-sided coverage).
- `@suss/contract-intent` — reader for `*.intent` / `*.prd` files. Unlike the other `contract-*` readers it produces `IntentSummary`, not `BehavioralSummary`: intent is a separate artifact stream that gets *compared against* behaviour, not folded into it.
- `@suss/checker-intent` — depends on both IRs (it compares them) and `ir-core`. Pure function `checkIntentAgreement(intents, code)` → findings + checked / unchecked accounting. Peer of `@suss/checker`, not a dependency of it.
- `@suss/extractor` — depends only on the IR. Defines `RawCodeStructure` and `PatternPack`. Never imports ts-morph or any compiler API.
- `@suss/adapter-typescript` — depends on IR, extractor, ts-morph. The heavyweight package.
- **All pack kinds** (framework, client, runtime) — depend only on `@suss/extractor` for the `PatternPack` type. They're data, not logic.
- `@suss/contract-*` packages — depend only on the IR, plus on each other where they compose (`cloudformation` delegates to `openapi` + `aws-apigateway`). Produce `BehavioralSummary[]` from specs, manifests, schemas; carry `confidence.source: "contract"`. See [`contract-sources.md`](contract-sources.md).
- `@suss/checker` — depends only on the IR. Pure function over two `BehavioralSummary` values → `Finding[]`. Knows nothing about extraction, AST, or packs — operates on the serialized IR.
- `@suss/cli` — depends on everything; dynamically imports the adapter so CLI startup doesn't pay the ts-morph cost unless extraction actually runs. The CLI is the orchestration seam for multi-stream checking: it loads behavioural summaries and intent docs and dispatches each to its checker. The checkers stay IR-only consumers and never depend on each other.

### Ownership rules

What goes where, when adding new behavior:

- **Adapter** owns the language spec — both syntax and the runtime-semantic built-ins ECMAScript defines (Promise and its prototype methods, Array prototype methods, async/await, generators). If TC39 says it, the adapter handles it. Two concrete cases: the unit-body walkers descend into nested function expressions and arrows (Promise executors, `.then` callbacks, `forEach` bodies) so recognizers and effects inside them attach to the enclosing unit; and a `.then` callback's first parameter binds to the resolved value of the upstream promise. A pack-declared sub-unit boundary is the one opt-out — the walker stops there so the sub-unit's behavior lands on its own summary. See `docs/internal/proposals/adapter-ecmascript-spec.md`.
- **Runtime packs** own behavior the runtime defines. `setTimeout`, `setImmediate`, `process.*` for Node. `requestAnimationFrame`, DOM APIs for browser. Even when names overlap across runtimes (setTimeout exists in both Node and browsers), each runtime owns its own — no shared "language base" pack.
- **Framework packs** own framework-specific patterns: how handlers are registered, what response shapes look like, how inputs are delivered.
- **Client packs** own consumer-side discovery: fetch call sites, axios calls, GraphQL clients.
- **Contract packs** own translating external specifications (OpenAPI documents, GraphQL SDL, CloudFormation templates, Prisma schemas) into the IR.

A pack that exists only to translate the language spec doesn't exist — that work goes in the adapter.

### Provider-shape carries client patterns (known tension)

The `PatternPack` interface was designed around provider-side extraction. Client/consumer discovery was added via `clientCall` match and `returnStatement` terminal, which works correctly but creates structural noise: `inputMapping` is meaningless for clients (they don't receive framework-structured inputs), the `returnStatement` + `throwExpression` terminals are boilerplate every client pack repeats, and `contractReading` is provider-only but lives at the top level.

This isn't worth refactoring while there are three client packs (web, axios, apollo). If a fourth ships and the boilerplate becomes a pattern, the right move is to split `PatternPack` into `provider` / `client` sub-shapes with sensible defaults for client terminals.

## The extraction algorithm

For each code unit, the adapter runs four independently testable steps, then assembles them:

1. **Terminal discovery** — use pack patterns to find all AST nodes that produce observable output.
2. **Ancestor branch collection** — walk upward from each terminal to the function root, recording branching constructs (`if`, `switch`, `try/catch`, ternary, `&&` / `||`).
3. **Early return detection** — scan sibling statements before the terminal; any `if (cond) return` contributes an implicit negative predicate to the terminal.
4. **Condition expression parsing** — decompose each condition AST node into a structured `Predicate`, resolving subjects via the symbol table. Fall back to `opaque` when decomposition fails.

The four functions compose in step 5 (**assembly**): for each terminal, concatenate its early-return conditions + ancestor-branch conditions, pair with the terminal's output data, and produce a `Transition`.

Two parallel mechanisms feed effects and sub-units into this pipeline:

- **Recognizers** fire when the walker encounters a specific call or property access inside a code unit. The runtime-node pack's `schedulingRecognizer` fires on `setTimeout(...)` and attaches a scheduling effect to the surrounding unit; its env-var recognizer fires on `process.env.X` reads and attaches a config-read effect.
- **Sub-units** synthesize new code units inside an existing one — typically a callback passed to a host function (`setTimeout(callback)`, `array.forEach(callback)`, a Promise executor). The walker descends into the sub-unit and runs recognizer dispatch there, so effects in nested function bodies aren't missed.

## Why `RawCodeStructure` exists

The adapter produces `RawCodeStructure` (plain data). The extractor consumes it and produces `BehavioralSummary`. You might ask: why not skip the intermediate shape and produce `BehavioralSummary` directly from the adapter?

Three reasons:

1. **Testability.** `assembleSummary(raw)` is a pure function that can be tested with hand-crafted input. No fixtures, no compiler, no files. The extractor test suite runs in <50ms.
2. **Logic centralization.** Gap detection, confidence assessment, predicate normalization, opaque-wrapping, and `expectedInput` pass-through all live in one place. Language adapters don't re-implement them.
3. **Contributor isolation.** A pack author never touches adapter code. An adapter bug doesn't affect the extractor. The extractor doesn't care what language the raw structure came from.

The pipeline contract is strict: the adapter fills in `RawCodeStructure` (including `RawBranch.expectedInput` for client call sites), the extractor produces `BehavioralSummary` from it. No post-assembly patching — everything the summary needs must come through `RawCodeStructure`.

## Degradation strategy

Static analysis of production codebases is always imperfect. suss handles this explicitly:

- **Opaque predicates** — when the adapter can't decompose a condition expression, it preserves the source text and marks the predicate `opaque`. Downstream tools see an explicit "we don't know" rather than a fabricated decomposition.
- **Gaps** — cases the code unit doesn't handle (declared-but-not-produced, produced-but-not-declared, uncaught exceptions, fall-through branches) are top-level output, not errors.
- **Confidence levels** (`high` / `medium` / `low`) — computed from the ratio of opaque to structured predicates. A summary with 80% opaque conditions is labeled "low confidence" so consumers can treat it with appropriate skepticism.
- **Layered dependency resolution** — in-project code gets full extraction; typed external dependencies get type info; untyped ones become opaque predicates. No configuration needed.

## Boundary semantics today

The IR types are mostly protocol-agnostic — every `Output` is a typed shape, every `Predicate` operates on `ValueRef`s. The cross-boundary plumbing has two semantics shipped:

- **HTTP** — `(method, normalizedPath)` as the pairing key, status codes as the outcome discriminator, response bodies as the payload. Metadata namespaced under `metadata.http.*`.
- **GraphQL** — operation type + field as the identity, contract derivation from inline SDL, contract-agreement checker. Metadata namespaced under `metadata.graphql.*`.

Other parts of the pipeline (automatic boundary pairing, the inspect output) are still HTTP-only and need extending as new semantics land.

The forward direction is `boundary-semantics.md`: a `BoundarySemantics` interface that splits transport, semantics, and recognition into separate fields on `BoundaryBinding`. The GraphQL work is the second concrete case the abstraction was waiting for; before that, designing it would have put the seams in the wrong places.

Other boundary types are still ahead. Message buses with event-name pairing are the most concrete next case; each new semantics adds a `BoundarySemantics` variant rather than stretching an existing one.

## What's deliberately not here

- **A full control flow graph.** suss identifies terminals and their gating conditions. It doesn't build a CFG or do data flow analysis. A CFG would capture more but costs orders of magnitude more in complexity.
- **Cross-service aggregation.** `@suss/checker` compares two summaries at a time (one provider, one consumer). Aggregating across an organization, tracking boundaries over commits, or alerting on regressions are separate concerns that consume pairwise findings as input. See [`cross-boundary-checking.md`](cross-boundary-checking.md).
- **Runtime tracing.** Everything is static. No instrumentation, no production data.
- **Semantic understanding of dependency calls.** When the extractor sees `await db.findById(id)`, it knows the subject is "the result of `db.findById`." It doesn't know what Prisma's `findById` actually does. That's fine — cross-boundary comparison only needs subjects to be *stable*, not *semantically understood*.
- **A shared adapter abstraction layer.** The TypeScript adapter contains substantial analysis logic. A Python adapter would need analogous logic using a different AST library. Some patterns are conceptually language-agnostic ("find all property accesses on a variable within a subtree"), but extracting a shared `@suss/adapter-core` is premature with one adapter. When the second adapter starts, the right move is to extract shared patterns as they emerge from the second implementation, not design them upfront.
- **A linter.** Findings describe what a contract pair disagrees on. They aren't style rules, code-quality opinions, or unsafe-pattern warnings. The summary is the product; what gets built on top of it is a downstream concern.
