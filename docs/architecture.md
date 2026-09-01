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

becomes two transitions: one returns 404 when `user` is null, the other returns 200 with a `User` body. The output isn't "this returns a Promise<{ status, body }>", it's the conditions under which each result comes out, expressed structurally enough to compare against the contract on the other side.

### What counts as a boundary

The example above is HTTP, but suss treats "boundary" generally, anywhere code interacts with something whose other side might disagree. The HTTP example is one kind of boundary. A package export is another: you publish `parseConfig(input: string)`, someone imports it, the boundary is the function signature and the consumers are every call site in every package that imports it. The machinery is the same in both cases: discover the producer, discover the consumers, extract behavior, pair the two sides, compare them.

### What pairing summaries lets you do

Two summaries from anywhere in the system get compared by the same checker. Frontend ↔ backend, declared contract ↔ implementation, library ↔ caller. Because every summary comes out in the same format, the comparisons compose; the checker doesn't care which frameworks produced its inputs.

## Data flow

Extraction is a straight line with one intermediate data structure, `RawCodeStructure`, between the layer that touches the AST (the adapter) and the assembly layer (the extractor):

<svg class="suss-diagram" viewBox="0 0 660 412" role="img" aria-labelledby="pipeline-title pipeline-desc">
  <title id="pipeline-title">The extraction pipeline</title>
  <desc id="pipeline-desc">Source files pass through the language adapter, which produces RawCodeStructure. The assembly engine turns that into BehavioralSummary. The adapter is the only stage that touches an AST, and the extractor is the only stage that touches RawCodeStructure.</desc>

  <defs>
    <marker id="pipeline-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <rect class="box" x="210" y="8" width="240" height="34" rx="6" />
  <text class="label" x="330" y="30" text-anchor="middle">Your source files</text>
  <line class="arrow" x1="330" y1="42" x2="330" y2="66" marker-end="url(#pipeline-arrow)" />

  <rect class="box" x="130" y="72" width="400" height="86" rx="6" />
  <text class="label" x="330" y="94" text-anchor="middle">Language adapter</text>
  <text class="note" x="330" y="112" text-anchor="middle">reads the project through the compiler, one tsconfig at a time</text>
  <text class="note" x="330" y="128" text-anchor="middle">finds the units a pack describes, then their branches and outputs</text>
  <text class="label-mono" x="330" y="148" text-anchor="middle">@suss/adapter-typescript</text>
  <line class="arrow" x1="330" y1="158" x2="330" y2="182" marker-end="url(#pipeline-arrow)" />

  <rect class="box-data" x="210" y="188" width="240" height="34" rx="6" />
  <text class="label-mono" x="330" y="209" text-anchor="middle">RawCodeStructure</text>
  <line class="arrow" x1="330" y1="222" x2="330" y2="246" marker-end="url(#pipeline-arrow)" />

  <rect class="box" x="130" y="252" width="400" height="76" rx="6" />
  <text class="label" x="330" y="274" text-anchor="middle">Assembly engine</text>
  <text class="note" x="330" y="292" text-anchor="middle">normalizes conditions, finds gaps, scores confidence</text>
  <text class="label-mono" x="330" y="313" text-anchor="middle">@suss/extractor</text>
  <line class="arrow" x1="330" y1="328" x2="330" y2="352" marker-end="url(#pipeline-arrow)" />

  <rect class="box-data" x="210" y="358" width="240" height="46" rx="6" />
  <text class="label-mono" x="330" y="378" text-anchor="middle">BehavioralSummary[]</text>
  <text class="note" x="330" y="394" text-anchor="middle">JSON. No language or framework in it.</text>

  <line class="seam" x1="20" y1="205" x2="130" y2="205" />
  <line class="seam" x1="450" y1="205" x2="644" y2="205" />
  <text class="note" x="20" y="196" text-anchor="start">only this stage</text>
  <text class="note" x="20" y="221" text-anchor="start">sees an AST</text>
  <text class="note" x="644" y="196" text-anchor="end">everything below</text>
  <text class="note" x="644" y="221" text-anchor="end">reads plain data</text>
</svg>

See [`pipelines.md`](pipelines.md) for per-CLI-action walkthroughs.

The split between adapter and extractor is deliberate. The extractor never sees an AST node, it works on `RawCodeStructure`, a plain data structure. This means:

1. **The extractor is directly testable** with hand-crafted input. Tests run in milliseconds, no compiler involved.
2. **Adding a new language** means writing a new adapter that produces `RawCodeStructure`. The extractor doesn't change.
3. **Pack authors** never touch the adapter or extractor, they describe patterns declaratively.

## Vocabulary

The terms used consistently across the codebase, code unit, boundary, terminal, transition, predicate, subject, output, effect, gap, recognizer, sub-unit, pack, confidence, have one canonical definition each in the [Glossary](glossary.md). The running example there is the same `getUser` handler above.

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
    │     ├─ @suss/adapter-typescript    ts-morph-based extraction; runs
    │     │        │                     whole-program passes as rules
    │     │        ├─ @suss/datalog      small Datalog evaluator (facts,
    │     │        │                     rules, stratified negation)
    │     │        └─ @suss/resolution   language-neutral rules for following
    │     │                              a value to the function it comes
    │     │                              down to
    │     │
    │     ├─ Framework packs             discover handlers, define terminals
    │     │  (all inside @suss/packs)
    │     │     @suss/framework-ts-rest          and inputs for a framework
    │     │     @suss/framework-express
    │     │     @suss/framework-fastify
    │     │     @suss/framework-hono
    │     │     @suss/framework-nextjs
    │     │     @suss/framework-react
    │     │     @suss/framework-react-router
    │     │     @suss/framework-nestjs-rest
    │     │     @suss/framework-nestjs-graphql
    │     │     @suss/framework-apollo
    │     │     @suss/framework-aws-lambda
    │     │     @suss/framework-aws-sqs
    │     │     @suss/framework-aws-sns
    │     │     @suss/framework-aws-eventbridge
    │     │     @suss/framework-aws-secrets-manager
    │     │     @suss/framework-aws-ssm
    │     │     @suss/framework-prisma
    │     │     @suss/framework-drizzle
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
    │     @suss/contract-graphql   (SDL + committed .graphql operations)
    │     @suss/contract-aws-apigateway
    │     @suss/contract-cloudformation  (delegates to openapi + apigateway)
    │     @suss/contract-appsync
    │     @suss/contract-prisma
    │     @suss/contract-storybook
    │
    └─ @suss/checker         pairwise cross-boundary checker. IR-only consumer.
          │
       @suss/cli             thin wrapper over extractor + checkers + contracts.
                             The CLI dispatch point: loads both artifact
                             streams (behavioral + intent) and dispatches to
                             the matching checker.
```

### Dependency rules

- `@suss/ir-core`: one peer dep on `zod`. Primitives both IRs share (`TypeShape`, `BoundaryBinding` + `boundaryKey`, `SourceLocation`, `ConfidenceInfo`) plus the comparison primitives both checkers share (`bodyShapesMatch`). Intent and behavior describe boundaries the same way because they build on the same vocabulary; neither IR depends on the other.
- `@suss/behavioral-ir`: one peer dep on `zod`. Runtime validators (`parseSummaries`, `safeParseSummaries`) and the generated JSON Schema both come from the zod schemas. This is what downstream consumers install.
- `@suss/intent-ir`: depends on `ir-core` only. Authoring schema (`IntentDoc`), checkable form (`IntentSummary`), and the type for intent findings (`IntentFinding`, deliberately not the behavioral `Finding`, which is a two-sided peer comparison; intent findings are one-sided coverage).
- `@suss/contract-intent`: reader for `*.intent` / `*.prd` files. Unlike the other `contract-*` readers it produces `IntentSummary`, not `BehavioralSummary`: intent is a separate artifact stream that gets *compared against* behavior, not folded into it.
- `@suss/checker-intent`: depends on both IRs (it compares them) and `ir-core`. It exposes one pure function, `checkIntentAgreement(intents, code)`, which returns findings plus the checked / unchecked accounting. Peer of `@suss/checker`, not a dependency of it.
- `@suss/extractor`: depends only on the IR. Defines `RawCodeStructure` and `PatternPack`. Never imports ts-morph or any compiler API.
- `@suss/adapter-typescript`: depends on IR, extractor, ts-morph, `@suss/datalog` for its whole-program passes, and `@suss/resolution` for the rules those passes join on. The heavyweight package.
- `@suss/datalog`: zero dependencies. A small semi-naive Datalog evaluator with stratified negation; rules are plain data. It knows nothing about the IR or the AST, which is the point: analyses written against fact patterns stay language-independent.
- `@suss/resolution`: a list of Datalog rules and nothing else. No parser, no language, no files. The rules answer one question, which function does this value come down to, and they compose one hop at a time, so a factory handing off to another factory, or a barrel re-exporting a wrapper, resolves without a rule written for that case specifically. An adapter reads source into facts (`binds`, `paramOf`, `callArg`, `reExports`, and a handful more), concatenates its own rules, and evaluates on `@suss/datalog`. When an answer comes back empty, suspect the facts before the rules. See `packages/resolution/README.md` for the fact vocabulary and the cases deliberately left unresolved, and [How suss follows a value](resolving-values.md) for how the facts, the rules and the proof fit together on one worked example.
- **All pack kinds** (framework, client, runtime), depend only on `@suss/extractor` for the `PatternPack` type, plus `@suss/manifest-*` packages where discovery is manifest-driven. They're data, not logic.
- `@suss/manifest-*` packages, parse deploy manifests (SAM/CFN templates) into plain data. No IR, no `@suss` dependencies. Both contract readers (manifest as specification) and framework packs (manifest as discovery index) read through them; the parsing happens in one place, and neither side depends on the other.
- `@suss/contract-*` packages, depend only on the IR, plus on each other where they compose (`cloudformation` delegates to `openapi` + `aws-apigateway`). They produce `BehavioralSummary[]` from specs, manifests and schemas, and mark what they produce `confidence.source: "derived"`. See [`contract-sources.md`](contract-sources.md).
- `@suss/checker`: depends only on the IR. A pure function over two `BehavioralSummary` values → `Finding[]`. It knows nothing about extraction, the AST, or packs; it works on the serialized IR.
- `@suss/cli`: depends on everything; dynamically imports the adapter so CLI startup doesn't pay the ts-morph cost unless extraction actually runs. The CLI is the one place that loads both summary streams (behavioral and intent) and dispatches each to its checker. The checkers stay IR-only consumers and never depend on each other.

### Ownership rules

What goes where, when adding new behavior:

- **Adapter** owns the language spec, both syntax and the runtime-semantic built-ins ECMAScript defines (Promise and its prototype methods, Array prototype methods, async/await, generators). If TC39 says it, the adapter handles it. Two concrete cases: the unit-body walkers descend into nested function expressions and arrows (Promise executors, `.then` callbacks, `forEach` bodies) so recognizers and effects inside them attach to the enclosing unit; and a `.then` callback's first parameter binds to the resolved value of the upstream promise. A pack-declared sub-unit boundary is the one opt-out, the walker stops there so the sub-unit's behavior lands on its own summary. The argument for drawing the line there is in a design record, [Adapter owns the ECMAScript spec](https://github.com/nimbuscloud-ai/suss/blob/main/design/proposals/adapter-ecmascript-spec.md), which is a proposal rather than documentation.
- **Runtime packs** own behavior the runtime defines. `setTimeout`, `setImmediate`, `process.*` for Node. `requestAnimationFrame`, DOM APIs for browser. Even when names overlap across runtimes (setTimeout exists in both Node and browsers), each runtime owns its own, no shared "language base" pack.
- **Framework packs** own framework-specific patterns: how handlers are registered, what a response looks like, how inputs are delivered.
- **Client packs** own consumer-side discovery: fetch call sites, axios calls, GraphQL clients.
- **Contract packs** own translating external specifications (OpenAPI documents, GraphQL SDL, CloudFormation templates, Prisma schemas) into the IR.

There is no pack whose only job is to translate the language spec; that work goes in the adapter.

### The provider shape is reused for client patterns (known tension)

The `PatternPack` interface was designed around provider-side extraction. Client and consumer discovery came later, through the `clientCall` match and the `returnStatement` terminal. That works correctly, but it leaves structural noise behind. `inputMapping` means nothing for a client, since clients don't receive framework-structured inputs. The `returnStatement` and `throwExpression` terminals are boilerplate every client pack repeats. And `contractReading` applies only to providers, yet it lives at the top level.

This isn't worth refactoring while there are three client packs (web, axios, apollo). If a fourth ships and the boilerplate becomes a pattern, the right move is to split `PatternPack` into `provider` and `client` sub-interfaces, with sensible defaults for client terminals.

## The extraction algorithm

For each code unit, the adapter runs four independently testable steps, then assembles them:

1. **Terminal discovery**, use pack patterns to find all AST nodes that produce observable output.
2. **Path enumeration**, the path engine enumerates every entry-to-terminal control-flow path over the function's structured statements (`if`/`else`, `switch`, loops, `try`/`catch`, `break`/`continue`) and produces one condition list per path. Facts that aren't statically decidable (which loop iteration, which statement threw) become opaque conditions, and the few cases the engine declines degrade to enclosure conditions plus an explicit unmodeled-control-flow marker.
3. **Expression-level condition collection**, ternaries, `&&` / `||` short-circuits, and conditions inside nested callbacks are read below the statement level and appended to each path's list.
4. **Condition expression parsing**, decompose each condition AST node into a structured `Predicate`, resolving subjects via the symbol table. Fall back to `opaque` when decomposition fails.

The four functions compose in step 5 (**assembly**): each entry-to-terminal path becomes one `Transition`, pairing that path's conditions with the terminal's output data. [`extraction-algorithm.md`](extraction-algorithm.md) walks each step in detail.

Two parallel mechanisms feed effects and sub-units into this pipeline:

- **Recognizers** fire when the walker encounters a specific call or property access inside a code unit. The runtime-node pack's `schedulingRecognizer` fires on `setTimeout(...)` and attaches a scheduling effect to the surrounding unit; its env-var recognizer fires on `process.env.X` reads and attaches a config-read effect.
- **Sub-units** synthesize new code units inside an existing one, typically a callback passed to a host function (`setTimeout(callback)`, `array.forEach(callback)`, a Promise executor). The walker descends into the sub-unit and runs recognizer dispatch there, so effects in nested function bodies aren't missed.

## Whole-program passes: facts and rules

Per-function extraction answers "what does this function do". Three passes answer whole-program questions afterward, and all three are Datalog rules (`@suss/datalog`) over one shared fact database per extraction:

- **Reachable closure**: every function statically reachable from a pack-discovered entry point becomes its own `library` summary.
- **Re-throw enrichment**: a bare `throw err` in a catch block learns the throw sources its try block's callees can raise, transitively.
- **Boundary effects**: every effect statically reachable behind an entry point lands on that entry's summary as `metadata.effectsClosure`.

The layering is strict: extraction emits facts, rules derive new facts, assembly stamps derived results onto summaries as additive metadata. Rules never touch the AST, so the analyses are language-independent by construction. [`internal/facts-and-rules.md`](internal/facts-and-rules.md) is the working reference, including the relation table and the checklist for adding an analysis.

## Verification: the differential fuzzer

Extraction's correctness principles are checked mechanically, not by review alone. A differential fuzzer (`tools/differential`, never published) generates handler programs and React components, extracts them through the real pipeline, executes the same code, and fails the build if a summary claims something execution disproves. Shrunk counterexamples are pinned in a permanent corpus, and fixed gaps become regression tests. [`internal/differential-fuzzing.md`](internal/differential-fuzzing.md) has the protocol.

## Why `RawCodeStructure` exists

The adapter produces `RawCodeStructure` (plain data). The extractor consumes it and produces `BehavioralSummary`. You might ask: why not skip the intermediate step and produce `BehavioralSummary` directly from the adapter?

Three reasons:

1. **Testability.** `assembleSummary(raw)` is a pure function that can be tested with hand-crafted input. No fixtures, no compiler, no files. The extractor test suite runs in <50ms.
2. **Logic centralization.** Gap detection, confidence assessment, predicate normalization, opaque-wrapping, and `expectedInput` pass-through all live in one place. Language adapters don't re-implement them.
3. **Contributor isolation.** A pack author never touches adapter code. An adapter bug doesn't affect the extractor. The extractor doesn't care what language the raw structure came from.

The pipeline contract is strict: the adapter fills in `RawCodeStructure` (including `RawBranch.expectedInput` for client call sites), the extractor produces `BehavioralSummary` from it. No post-assembly patching, everything the summary needs must come through `RawCodeStructure`.

## Degradation strategy

Static analysis of production codebases is always imperfect. suss handles this explicitly:

- **Opaque predicates**: when the adapter can't decompose a condition expression, it preserves the source text and marks the predicate `opaque`. Downstream tools see an explicit "we don't know" rather than a fabricated decomposition.
- **Gaps**: two kinds, and they say different things. An `unhandledCase` is about the code: the contract declares a 500 the handler never produces, or the handler produces a 418 the contract never declared. An `unreadOutcome` is about how much suss could read: a `return` matched none of the terminal patterns the pack looks for, so what it produces went undescribed. Both are top-level output, not errors.
- **Confidence levels** (`high` / `medium` / `low`). A return nobody could read drops the summary straight to `low`, since a function whose returns all went unread has no conditions either and would otherwise score as certain. Otherwise the level comes from the ratio of opaque to structured predicates. A summary with 80% opaque conditions is labeled low confidence so consumers can treat it with appropriate skepticism.
- **Layered dependency resolution**: in-project code gets full extraction; typed external dependencies get type info; untyped ones become opaque predicates. No configuration needed.

## Boundary semantics today

The IR types are mostly protocol-agnostic, every `Output` is a typed structure, every `Predicate` operates on `ValueRef`s. Seven semantics variants ship, each as its own module under `packages/ir-core/src/semantics/` composed by a registry:

- **`rest`**: `(method, normalizedPath)` as the identity, `"*"` as the method wildcard; two sides pair when their paths bucket together and their methods agree. Metadata namespaced under `metadata.http.*`.
- **`graphql-resolver`**: the parent type name + field as the identity (`Query.user`, but also `User.posts`), with contract derivation from inline SDL. Metadata under `metadata.graphql.*`. **`graphql-operation`** describes the client side; the contract checker pairs it rather than the key engine.
- **`message-bus`**: the key is built from the channel's subject, so a template that writes `default#order.placed` and a handler that writes `order.placed` land in one bucket, and the buses have to agree inside it.
- **`function-call`**: keyed by package + export path when both are known.
- **`runtime-config`** and **`storage`**: no identity key; their checkers pair by deployable unit and by container.

Each variant declares its identity key, its pairing key, and how two sides agree; the pairing engine in `@suss/checker` dispatches through the registry rather than assuming any one protocol. A new boundary type adds a variant instead of stretching an existing one. [`boundary-semantics.md`](boundary-semantics.md) covers what a variant looks like and what adding one involves.

## What's deliberately not here

- **A full control flow graph.** suss identifies terminals and their gating conditions. It doesn't build a CFG or do data flow analysis. A CFG would capture more but costs orders of magnitude more in complexity.
- **Cross-service aggregation.** `@suss/checker` compares two summaries at a time (one provider, one consumer). Aggregating across an organization, tracking boundaries over commits, or alerting on regressions are separate concerns that consume pairwise findings as input. See [`cross-boundary-checking.md`](cross-boundary-checking.md).
- **Runtime tracing.** Everything is static. No instrumentation, no production data.
- **Semantic understanding of dependency calls.** When the extractor sees `await db.findById(id)`, it knows the subject is "the result of `db.findById`." It doesn't know what Prisma's `findById` actually does. That's fine, cross-boundary comparison only needs subjects to be *stable*, not *semantically understood*.
- **A shared adapter abstraction layer.** Three adapters ship, for TypeScript, Python and Ruby, and each has its own analysis logic over its own parser. What they share today is the layer above them: `assembleSummary` in `@suss/extractor` turns a `RawCodeStructure` into a summary for all three, so gap detection and confidence scoring have one implementation. Some tree-walking patterns are conceptually language-agnostic ("find all property accesses on a variable within a subtree"), and a shared `@suss/adapter-core` for those waits until the same pattern has been written twice for a reason, not because it looked shareable.
- **A linter.** Findings describe what a contract pair disagrees on. They aren't style rules, code-quality opinions, or unsafe-pattern warnings. The summary is the product; what gets built on top of it is a downstream concern.
