# Architecture

suss extracts **behavioral summaries** from source code: structured descriptions of what each piece of code does, in terms of conditions and observable outputs. The summary is the product. Downstream tools, checkers, query layers, operate on the summaries without caring whether the source was TypeScript, Python, or anything else.

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

becomes two transitions: one returns 404 when `user` is null, the other returns 200 with a `User` shape. The output isn't "this returns a Promise<{ status, body }>", it's the conditions under which each shape comes out, expressed structurally enough to compare against the contract on the other side.

### What counts as a boundary

The example above is HTTP, but suss treats "boundary" generally, anywhere code interacts with something whose other side might disagree. The HTTP example is one shape. A package export is another: you publish `parseConfig(input: string)`, someone imports it, the boundary is the function signature and the consumers are every call site in every package that imports it. Same machinery in both cases, discover the producer, discover the consumers, extract behavior, pair, compare.

### What pairing summaries lets you do

Two summaries from anywhere in the system get compared by the same checker. Frontend ↔ backend, declared contract ↔ implementation, library ↔ caller. The summary format being uniform is what makes the comparisons composable; the checker doesn't care which frameworks produced its inputs.

## Data flow

Extraction is a straight line with one intermediate data shape, `RawCodeStructure`, between the AST-shaped layer (the adapter) and the assembly layer (the extractor):

<svg class="suss-diagram" viewBox="0 0 700 412" role="img" aria-labelledby="pipeline-title pipeline-desc">
  <title id="pipeline-title">The extraction pipeline</title>
  <desc id="pipeline-desc">Source files pass through the language adapter, which produces RawCodeStructure. The assembly engine turns that into BehavioralSummary. The adapter is the only stage that touches an AST, and the extractor is the only stage that touches RawCodeStructure.</desc>

  <defs>
    <marker id="pipeline-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <rect class="box" x="250" y="8" width="200" height="34" rx="6" />
  <text class="label" x="350" y="30" text-anchor="middle">Your source files</text>
  <line class="arrow" x1="350" y1="42" x2="350" y2="66" marker-end="url(#pipeline-arrow)" />

  <rect class="box" x="150" y="72" width="400" height="86" rx="6" />
  <text class="label" x="350" y="94" text-anchor="middle">Language adapter</text>
  <text class="note" x="350" y="112" text-anchor="middle">reads the project through the compiler, one tsconfig at a time</text>
  <text class="note" x="350" y="128" text-anchor="middle">finds the units a pack describes, then their branches and outputs</text>
  <text class="label-mono" x="350" y="148" text-anchor="middle">@suss/adapter-typescript</text>
  <line class="arrow" x1="350" y1="158" x2="350" y2="182" marker-end="url(#pipeline-arrow)" />

  <rect class="box-data" x="250" y="188" width="200" height="34" rx="6" />
  <text class="label-mono" x="350" y="209" text-anchor="middle">RawCodeStructure</text>
  <line class="arrow" x1="350" y1="222" x2="350" y2="246" marker-end="url(#pipeline-arrow)" />

  <rect class="box" x="150" y="252" width="400" height="76" rx="6" />
  <text class="label" x="350" y="274" text-anchor="middle">Assembly engine</text>
  <text class="note" x="350" y="292" text-anchor="middle">normalizes conditions, finds gaps, scores confidence</text>
  <text class="label-mono" x="350" y="313" text-anchor="middle">@suss/extractor</text>
  <line class="arrow" x1="350" y1="328" x2="350" y2="352" marker-end="url(#pipeline-arrow)" />

  <rect class="box-data" x="205" y="358" width="290" height="46" rx="6" />
  <text class="label-mono" x="350" y="378" text-anchor="middle">BehavioralSummary[]</text>
  <text class="note" x="350" y="394" text-anchor="middle">JSON. No language or framework left in it.</text>

  <line class="seam" x1="55" y1="205" x2="150" y2="205" />
  <line class="seam" x1="450" y1="205" x2="645" y2="205" />
  <text class="note" x="55" y="196" text-anchor="start">the adapter is the only</text>
  <text class="note" x="55" y="221" text-anchor="start">stage that sees an AST</text>
  <text class="note" x="645" y="196" text-anchor="end">everything below reads</text>
  <text class="note" x="645" y="221" text-anchor="end">plain data instead</text>
</svg>

See [`pipelines.md`](pipelines.md) for per-CLI-action walkthroughs.

The split between adapter and extractor is deliberate. The extractor never sees an AST node, it works on `RawCodeStructure`, a plain data shape. This means:

1. **The extractor is directly testable** with hand-crafted input. Tests run in milliseconds, no compiler involved.
2. **Adding a new language** means writing a new adapter that produces `RawCodeStructure`. The extractor doesn't change.
3. **Pack authors** never touch the adapter or extractor, they describe patterns declaratively.

## Vocabulary

The terms used consistently across the codebase, code unit, boundary, terminal, transition, predicate, subject, output, effect, gap, recognizer, sub-unit, pack, confidence, have one canonical definition each in the [Glossary](glossary.md). The running example there is the same `getUser` handler above. This doc uses those terms without redefining them.

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
    │     │                          (not BehavioralSummary, intent is its
    │     │                          own artifact stream)
    │     │
    │     └─ @suss/checker-intent    intent ↔ code checker; also consumes
    │                                behavioral summaries. IR-only consumer.
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
    │     │     @suss/framework-aws-eventbridge
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
                             streams (behavioral + intent) and dispatches to
                             the matching checker.
```

### Dependency rules

- `@suss/ir-core`: one peer dep on `zod`. Primitives both IRs share (`TypeShape`, `BoundaryBinding` + `boundaryKey`, `SourceLocation`, `ConfidenceInfo`) plus the comparison primitives both checkers share (`bodyShapesMatch`). Intent and behavior describe boundaries the same way because they build on the same vocabulary; neither IR depends on the other.
- `@suss/behavioral-ir`: one peer dep on `zod`. Runtime validators (`parseSummaries`, `safeParseSummaries`) and the generated JSON Schema both come from the zod schemas. This is what downstream consumers install.
- `@suss/intent-ir`: depends on `ir-core` only. Authoring schema (`IntentDoc`), checkable form (`IntentSummary`), and the intent finding shape (`IntentFinding`, deliberately not the behavioral `Finding`, which is a two-sided peer comparison; intent findings are one-sided coverage).
- `@suss/contract-intent`: reader for `*.intent` / `*.prd` files. Unlike the other `contract-*` readers it produces `IntentSummary`, not `BehavioralSummary`: intent is a separate artifact stream that gets *compared against* behavior, not folded into it.
- `@suss/checker-intent`: depends on both IRs (it compares them) and `ir-core`. Pure function `checkIntentAgreement(intents, code)` → findings + checked / unchecked accounting. Peer of `@suss/checker`, not a dependency of it.
- `@suss/extractor`: depends only on the IR. Defines `RawCodeStructure` and `PatternPack`. Never imports ts-morph or any compiler API.
- `@suss/adapter-typescript`: depends on IR, extractor, ts-morph. The heavyweight package.
- **All pack kinds** (framework, client, runtime), depend only on `@suss/extractor` for the `PatternPack` type, plus `@suss/manifest-*` packages where discovery is manifest-driven. They're data, not logic.
- `@suss/manifest-*` packages, parse deploy manifests (SAM/CFN templates) into plain data. No IR, no `@suss` dependencies. Both contract readers (manifest as specification) and framework packs (manifest as discovery index) read through them; the parse lives once, and neither witness depends on the other.
- `@suss/contract-*` packages, depend only on the IR, plus on each other where they compose (`cloudformation` delegates to `openapi` + `aws-apigateway`). Produce `BehavioralSummary[]` from specs, manifests, schemas; carry `confidence.source: "derived"`. See [`contract-sources.md`](contract-sources.md).
- `@suss/checker`: depends only on the IR. Pure function over two `BehavioralSummary` values → `Finding[]`. Knows nothing about extraction, AST, or packs, operates on the serialized IR.
- `@suss/cli`: depends on everything; dynamically imports the adapter so CLI startup doesn't pay the ts-morph cost unless extraction actually runs. The CLI is the orchestration seam for multi-stream checking: it loads behavioral summaries and intent docs and dispatches each to its checker. The checkers stay IR-only consumers and never depend on each other.

### Ownership rules

What goes where, when adding new behavior:

- **Adapter** owns the language spec, both syntax and the runtime-semantic built-ins ECMAScript defines (Promise and its prototype methods, Array prototype methods, async/await, generators). If TC39 says it, the adapter handles it. Two concrete cases: the unit-body walkers descend into nested function expressions and arrows (Promise executors, `.then` callbacks, `forEach` bodies) so recognizers and effects inside them attach to the enclosing unit; and a `.then` callback's first parameter binds to the resolved value of the upstream promise. A pack-declared sub-unit boundary is the one opt-out, the walker stops there so the sub-unit's behavior lands on its own summary. See `docs/internal/proposals/adapter-ecmascript-spec.md`.
- **Runtime packs** own behavior the runtime defines. `setTimeout`, `setImmediate`, `process.*` for Node. `requestAnimationFrame`, DOM APIs for browser. Even when names overlap across runtimes (setTimeout exists in both Node and browsers), each runtime owns its own, no shared "language base" pack.
- **Framework packs** own framework-specific patterns: how handlers are registered, what response shapes look like, how inputs are delivered.
- **Client packs** own consumer-side discovery: fetch call sites, axios calls, GraphQL clients.
- **Contract packs** own translating external specifications (OpenAPI documents, GraphQL SDL, CloudFormation templates, Prisma schemas) into the IR.

A pack that exists only to translate the language spec doesn't exist, that work goes in the adapter.

### Provider-shape carries client patterns (known tension)

The `PatternPack` interface was designed around provider-side extraction. Client/consumer discovery was added via `clientCall` match and `returnStatement` terminal, which works correctly but creates structural noise: `inputMapping` is meaningless for clients (they don't receive framework-structured inputs), the `returnStatement` + `throwExpression` terminals are boilerplate every client pack repeats, and `contractReading` is provider-only but lives at the top level.

This isn't worth refactoring while there are three client packs (web, axios, apollo). If a fourth ships and the boilerplate becomes a pattern, the right move is to split `PatternPack` into `provider` / `client` sub-shapes with sensible defaults for client terminals.

## The extraction algorithm

For each code unit, the adapter runs four independently testable steps, then assembles them:

1. **Terminal discovery**, use pack patterns to find all AST nodes that produce observable output.
2. **Ancestor branch collection**, walk upward from each terminal to the function root, recording branching constructs (`if`, `switch`, `try/catch`, ternary, `&&` / `||`).
3. **Early return detection**, scan sibling statements before the terminal; any `if (cond) return` contributes an implicit negative predicate to the terminal.
4. **Condition expression parsing**, decompose each condition AST node into a structured `Predicate`, resolving subjects via the symbol table. Fall back to `opaque` when decomposition fails.

The four functions compose in step 5 (**assembly**): for each terminal, concatenate its early-return conditions + ancestor-branch conditions, pair with the terminal's output data, and produce a `Transition`.

Two parallel mechanisms feed effects and sub-units into this pipeline:

- **Recognizers** fire when the walker encounters a specific call or property access inside a code unit. The runtime-node pack's `schedulingRecognizer` fires on `setTimeout(...)` and attaches a scheduling effect to the surrounding unit; its env-var recognizer fires on `process.env.X` reads and attaches a config-read effect.
- **Sub-units** synthesize new code units inside an existing one, typically a callback passed to a host function (`setTimeout(callback)`, `array.forEach(callback)`, a Promise executor). The walker descends into the sub-unit and runs recognizer dispatch there, so effects in nested function bodies aren't missed.

## Why `RawCodeStructure` exists

The adapter produces `RawCodeStructure` (plain data). The extractor consumes it and produces `BehavioralSummary`. You might ask: why not skip the intermediate shape and produce `BehavioralSummary` directly from the adapter?

Three reasons:

1. **Testability.** `assembleSummary(raw)` is a pure function that can be tested with hand-crafted input. No fixtures, no compiler, no files. The extractor test suite runs in <50ms.
2. **Logic centralization.** Gap detection, confidence assessment, predicate normalization, opaque-wrapping, and `expectedInput` pass-through all live in one place. Language adapters don't re-implement them.
3. **Contributor isolation.** A pack author never touches adapter code. An adapter bug doesn't affect the extractor. The extractor doesn't care what language the raw structure came from.

The pipeline contract is strict: the adapter fills in `RawCodeStructure` (including `RawBranch.expectedInput` for client call sites), the extractor produces `BehavioralSummary` from it. No post-assembly patching, everything the summary needs must come through `RawCodeStructure`.

## Degradation strategy

Static analysis of production codebases is always imperfect. suss handles this explicitly:

- **Opaque predicates**: when the adapter can't decompose a condition expression, it preserves the source text and marks the predicate `opaque`. Downstream tools see an explicit "we don't know" rather than a fabricated decomposition.
- **Gaps**: cases the code unit doesn't handle (declared-but-not-produced, produced-but-not-declared, uncaught exceptions, fall-through branches) are top-level output, not errors.
- **Confidence levels** (`high` / `medium` / `low`), computed from the ratio of opaque to structured predicates. A summary with 80% opaque conditions is labeled "low confidence" so consumers can treat it with appropriate skepticism.
- **Layered dependency resolution**: in-project code gets full extraction; typed external dependencies get type info; untyped ones become opaque predicates. No configuration needed.

## Boundary semantics today

The IR types are mostly protocol-agnostic, every `Output` is a typed shape, every `Predicate` operates on `ValueRef`s. The cross-boundary plumbing has two semantics shipped:

- **HTTP**, `(method, normalizedPath)` as the pairing key, status codes as the outcome discriminator, response bodies as the payload. Metadata namespaced under `metadata.http.*`.
- **GraphQL**: operation type + field as the identity, contract derivation from inline SDL, contract-agreement checker. Metadata namespaced under `metadata.graphql.*`.

Other parts of the pipeline (automatic boundary pairing, the inspect output) are still HTTP-only and need extending as new semantics land.

The forward direction is `boundary-semantics.md`: a `BoundarySemantics` interface that splits transport, semantics, and recognition into separate fields on `BoundaryBinding`. The GraphQL work is the second concrete case the abstraction was waiting for; before that, designing it would have put the seams in the wrong places.

Other boundary types are still ahead. Message buses with event-name pairing are the most concrete next case; each new semantics adds a `BoundarySemantics` variant rather than stretching an existing one.

## What's deliberately not here

- **A full control flow graph.** suss identifies terminals and their gating conditions. It doesn't build a CFG or do data flow analysis. A CFG would capture more but costs orders of magnitude more in complexity.
- **Cross-service aggregation.** `@suss/checker` compares two summaries at a time (one provider, one consumer). Aggregating across an organization, tracking boundaries over commits, or alerting on regressions are separate concerns that consume pairwise findings as input. See [`cross-boundary-checking.md`](cross-boundary-checking.md).
- **Runtime tracing.** Everything is static. No instrumentation, no production data.
- **Semantic understanding of dependency calls.** When the extractor sees `await db.findById(id)`, it knows the subject is "the result of `db.findById`." It doesn't know what Prisma's `findById` actually does. That's fine, cross-boundary comparison only needs subjects to be *stable*, not *semantically understood*.
- **A shared adapter abstraction layer.** The TypeScript adapter contains substantial analysis logic. A Python adapter would need analogous logic using a different AST library. Some patterns are conceptually language-agnostic ("find all property accesses on a variable within a subtree"), but extracting a shared `@suss/adapter-core` is premature with one adapter. When the second adapter starts, the right move is to extract shared patterns as they emerge from the second implementation, not design them upfront.
- **A linter.** Findings describe what a contract pair disagrees on. They aren't style rules, code-quality opinions, or unsafe-pattern warnings. The summary is the product; what gets built on top of it is a downstream concern.
