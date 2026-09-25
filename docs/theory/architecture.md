---
title: Architecture
description: The pipeline from a source file to a behavioral summary, which package owns each step, and what the layering rules out.
---

# Architecture

suss extracts **behavioral summaries** from source code: structured descriptions of what each unit of code produces, under what conditions, with what side effects. The summary is the product. Everything downstream, the checkers and the query layers, reads summaries without knowing whether the source was TypeScript, Python or Ruby.

Take this ts-rest handler:

```typescript
export const getUser = async ({ params }: { params: { id: string } }) => {
  const user = await db.findById(params.id);
  if (!user) {
    return { status: 404, body: { error: "not found" } };
  }
  return { status: 200, body: user };
};
```

It becomes two transitions. One returns 404 when `user` is null. The other returns 200 with a `User` body. Each transition records the condition that gates it and the output that follows, in a form the checker can compare against the contract on the other side.

The terms used here, such as code unit, terminal, transition and effect, are each defined once in the [Glossary](/reference/glossary).

## What counts as a boundary

The example above is HTTP, and suss treats a boundary generally: anywhere code meets something whose other side might disagree with it. A package export is a boundary too. You publish `parseConfig(input: string)`, somebody imports it, and the consumers are every call site in every package that imports it. The machinery is the same either way. suss discovers the producer, discovers the consumers, extracts behavior from both, pairs the two sides and compares them. Because every summary comes out in one format, the comparisons compose, and the checker never has to ask which framework produced its inputs.

## Data flow

Extraction is a straight line with one intermediate data structure, `RawCodeStructure`, between the layer that touches the AST (the adapter) and the layer that assembles summaries (the extractor):

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

[Pipelines](/theory/pipelines) traces each CLI command through this end to end.

The extractor never sees an AST node. It works on `RawCodeStructure`, which is plain data, and three things follow from that:

1. **The extractor is testable on hand-written input.** `assembleSummary(raw)` is a pure function, so its tests need no compiler and run in under 50ms.
2. **Adding a language means writing an adapter.** The new adapter produces `RawCodeStructure` and the extractor does not change. Python and Ruby were added that way.
3. **Pack authors touch neither.** A pack describes patterns as data.

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
    │     │
    │     └─ @suss/checker-intent    intent ↔ code checker; also consumes
    │                                behavioral summaries.
    │
    ├─ @suss/values          a bounded evaluator: what the source pins down
    │                        about a value, with a hole for the rest
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
    │     ├─ @suss/adapter-python, @suss/adapter-ruby   tree-sitter parsers
    │     │                              emitting the same RawCodeStructure
    │     │
    │     ├─ @suss/recognize             the pack vocabulary, plus @suss/sql
    │     │                              for reading which tables a statement
    │     │                              touches
    │     │
    │     └─ @suss/packs                 every framework, client and runtime
    │                                    pack in one install. The catalog is
    │                                    generated: see /packs/catalog
    │
    ├─ @suss/contract-*                  external spec → BehavioralSummary
    │                                    (openapi, graphql, cloudformation,
    │                                    appsync, serverless, terraform,
    │                                    wrangler, prisma, storybook,
    │                                    aws-apigateway)
    │
    ├─ @suss/checker         pairwise cross-boundary checker, over the
    │     │                  serialized IR
    │     │
    │  @suss/cli             the dispatch point: loads both artifact streams
    │     │                  (behavioral + intent) and sends each to its
    │     │                  checker
    │     │
    │  @suss/mcp             the same facts over MCP, for a coding agent
```

### Dependency rules

- `@suss/ir-core`: one peer dependency on `zod`. The primitives both IRs share (`TypeShape`, `BoundaryBinding` plus `boundaryKey`, `SourceLocation`, `ConfidenceInfo`) and the comparison primitives both checkers share (`bodyShapesMatch`). Intent and behavior describe boundaries the same way because they both build on this, and neither IR depends on the other.
- `@suss/behavioral-ir`: one peer dependency on `zod`. The runtime validators (`parseSummaries`, `safeParseSummaries`) and the generated JSON Schema all come from the zod schemas. This is what a downstream consumer installs.
- `@suss/intent-ir`: depends on `ir-core` only. The authoring schema (`IntentDoc`), the checkable form (`IntentSummary`), and `IntentFinding`, which is deliberately not the behavioral `Finding`: a behavioral finding is a two-sided peer comparison, and an intent finding is one-sided coverage.
- `@suss/contract-intent`: reader for `*.intent` and `*.prd` files. Unlike the other `contract-*` readers it produces `IntentSummary`. Intent is its own artifact stream, and the checker compares it against behavior.
- `@suss/checker-intent`: depends on both IRs, since it compares them, plus `ir-core`. It exposes one pure function, `checkIntentAgreement(intents, code)`, returning findings plus the checked and unchecked accounting. It is a peer of `@suss/checker` rather than a dependency of it.
- `@suss/extractor`: depends only on the IR. It defines `RawCodeStructure` and `PatternPack`, and never imports ts-morph or any compiler API.
- `@suss/adapter-typescript`: depends on the IR, the extractor, ts-morph, `@suss/datalog` for its whole-program passes, `@suss/resolution` for the rules those passes join on, and `@suss/values`. It is the heaviest package.
- `@suss/datalog`: zero dependencies. A semi-naive Datalog evaluator with stratified negation, where rules are plain data. Nothing in it refers to the IR or the AST, so an analysis written against fact patterns stays language-independent.
- `@suss/resolution`: a language-neutral list of Datalog rules, with no parser and no file access. The rules work out one thing, which function a value comes down to, and they compose one hop at a time, so a factory handing off to another factory, or a barrel re-exporting a wrapper, resolves without a rule written for that case. An adapter reads source into facts (`binds`, `paramOf`, `callArg`, `reExports`, and a handful more), concatenates its own rules, and evaluates on `@suss/datalog`. When an answer comes back empty, suspect the facts before the rules. `packages/resolution/DESIGN.md` has the fact vocabulary and the cases left unresolved on purpose, and [How suss follows a value](/theory/resolving-values) works through one example end to end.
- **Packs** depend on `@suss/extractor` for the `PatternPack` type, and on `@suss/recognize` where they describe an effect a library performs rather than a boundary it serves, plus a `@suss/manifest-*` package where discovery is manifest-driven. A pack is data.
- `@suss/manifest-*`: parse deploy manifests (SAM and CloudFormation templates, and the rest) into plain data. They depend on no IR and on no other `@suss` package. Contract readers (manifest as specification) and framework packs (manifest as a discovery index) both read through them, so the parsing happens once and neither side depends on the other.
- `@suss/contract-*`: depend on the IR, plus on each other where they compose (`cloudformation` delegates to `openapi` and `aws-apigateway`). They produce `BehavioralSummary[]` from specs, manifests and schemas, and mark what they produce `confidence.source: "derived"`. See [Contract sources](/packs/contract-sources).
- `@suss/checker`: depends on the IR and on `@suss/datalog`. Pairwise comparison is a pure function over two `BehavioralSummary` values returning `Finding[]`. Nothing in it touches extraction, the AST or packs, and it works on the serialized IR.
- `@suss/cli`: depends on everything, and imports the adapter dynamically so startup does not pay the ts-morph cost unless extraction runs. It is the one place that loads both summary streams and sends each to its checker, so the two checkers do not depend on each other.

### Ownership rules

Where new behavior goes:

- **The adapter** owns the language specification, both the syntax and the runtime semantics the language itself defines (Promise and its prototype methods, Array prototype methods, async/await, generators). If TC39 specifies it, the adapter handles it. Two cases show where the line is. The unit-body walkers descend into nested function expressions and arrows, such as Promise executors and `.then` callbacks, so recognizers and effects inside them attach to the enclosing unit. And a `.then` callback's first parameter binds to the resolved value of the upstream promise. A pack-declared sub-unit boundary is the one opt-out, where the walker stops so the sub-unit's behavior lands on its own summary. The argument for drawing the line there is in a proposal: [Adapter owns the ECMAScript spec](https://github.com/nimbuscloud-ai/suss/blob/main/design/proposals/adapter-ecmascript-spec.md).
- **Runtime packs** own behavior the runtime defines: `setTimeout`, `setImmediate` and `process.*` for Node, `requestAnimationFrame` and the DOM APIs for a browser. Where a name exists in both runtimes, each runtime owns its own, and there is no shared "language base" pack.
- **Framework packs** own framework patterns: how handlers are registered, what a response looks like, how inputs arrive.
- **Client packs** own consumer-side discovery: fetch call sites, axios calls, GraphQL clients.
- **Contract packs** own translating an external specification (an OpenAPI document, a GraphQL SDL, a CloudFormation template, a Prisma schema) into the IR.

No pack exists whose only job is to translate the language specification. That work goes in the adapter.

### A known tension in `PatternPack`

`PatternPack` was designed around provider-side extraction. Client discovery came later, through the `clientCall` match and the `returnStatement` terminal. It works, and it leaves structural noise behind. `inputMapping` means nothing for a client, because a client receives no framework-structured input. `returnStatement` and `throwExpression` are boilerplate every client pack repeats. `contractReading` applies only to providers and is at the top level anyway.

Splitting `PatternPack` into provider and client sub-interfaces, with defaults for the client terminals, is the fix. Leave it while there are three client packs for TypeScript, and split it once a fourth ships and the boilerplate has become a pattern.

## The extraction algorithm

For each code unit the adapter runs four independently testable steps, then assembles them:

1. **Terminal discovery.** Use the pack's patterns to find every AST node that produces observable output.
2. **Path enumeration.** The path engine enumerates every entry-to-terminal control-flow path over the function's structured statements (`if`/`else`, `switch`, loops, `try`/`catch`, `break`/`continue`) and produces one condition list per path. Facts nothing can decide statically, such as which loop iteration ran or which statement threw, become opaque conditions. The few shapes the engine declines degrade to enclosure conditions plus an explicit unmodeled-control-flow marker.
3. **Expression-level condition collection.** Ternaries, `&&` and `||` short-circuits, and conditions inside nested callbacks are read below the statement level and appended to each path's list.
4. **Condition expression parsing.** Decompose each condition into a structured `Predicate`, resolving subjects through the symbol table. Fall back to `opaque` where decomposition fails.

Step 5 is assembly: each entry-to-terminal path becomes one `Transition`, pairing that path's conditions with the terminal's output. [Extraction algorithm](/theory/extraction-algorithm) goes through each step.

Two mechanisms run alongside and feed effects and sub-units into the same pipeline:

- **Recognizers** fire when the walker reaches a specific call or property access inside a unit. The runtime-node pack's scheduling recognizer fires on `setTimeout(...)` and attaches a scheduling effect to the surrounding unit; its env-var recognizer fires on `process.env.X` and attaches a config-read effect.
- **Sub-units** are new code units created inside an existing one, usually a callback passed to a host function such as `setTimeout(callback)` or a Promise executor. The walker descends into the sub-unit and runs recognizer dispatch there, so an effect in a nested function body is not missed.

## Whole-program passes

Per-function extraction says what one function does. Two passes answer whole-program questions afterward, and both are Datalog rules over one shared fact database per extraction run:

- **Reachable closure**: every function statically reachable from a pack-discovered entry point becomes its own `library` summary.
- **Re-throw enrichment**: a bare `throw err` in a catch block gets the throw sources its try block's callees can raise, transitively.

What an entry point reaches transitively is not stamped on it. The CLI walks the invocation effects across summaries where a command needs that answer, so it comes out the same for every language.

The layering is strict. Extraction emits facts, rules derive new facts, and assembly stamps derived results onto summaries as additive metadata. Rules never touch the AST, so the analyses do not depend on the language. [Facts and rules](/theory/facts-and-rules) is the working reference, with the relation table and a checklist for adding an analysis.

## Verification: the differential fuzzer

A machine checks extraction's correctness principles on every build. A differential fuzzer (`tools/differential`, never published) generates handler programs and React components, extracts them through the shipping pipeline, executes the same code, and fails the build where a summary claims something execution disproves. Shrunk counterexamples are pinned in a permanent corpus, and a fixed gap becomes a regression test. [The differential-fuzzing record](https://github.com/nimbuscloud-ai/suss/blob/main/design/docs-internal/differential-fuzzing.md) has the protocol.

## Degradation

Static analysis of production code is always imperfect, and suss records where it fell short:

- **Opaque predicates.** Where the adapter cannot decompose a condition, it keeps the source text and marks the predicate `opaque`. A downstream tool sees an explicit "suss could not tell".
- **Gaps.** There are two kinds, and they mean different things. An `unhandledCase` is about the code: the contract declares a 500 the handler never produces, or the handler produces a 418 the contract never declared. An `unreadOutcome` is about how much suss could read: a `return` didn't match any of the pack's terminal patterns, so what it produces went undescribed. Both go in the output as data.
- **Confidence levels** (`high`, `medium`, `low`). A return suss could not read drops the summary straight to `low`, because a function whose returns all went unread has no conditions either and would otherwise score as certain. Otherwise the level comes from the ratio of opaque to structured predicates.
- **Layered dependency resolution.** In-project code gets full extraction, a typed external dependency gets its type information, and an untyped one becomes opaque predicates. Nothing needs configuring.

## Boundary semantics today

The IR types are mostly protocol-agnostic. Every `Output` is a typed structure and every `Predicate` operates on `ValueRef`s. Nine semantics variants ship, each its own module under `packages/ir-core/src/semantics/`, composed by a registry:

- **`rest`**: `(method, normalizedPath)` as the identity, `"*"` as the method wildcard. Two sides pair when their paths bucket together and their methods agree. Metadata under `metadata.http.*`.
- **`graphql-resolver`**: the parent type name plus the field (`Query.user`, and also `User.posts`), with contract derivation from inline SDL. Metadata under `metadata.graphql.*`. **`graphql-operation`** describes the client side, and the contract checker pairs it rather than the key engine.
- **`message-bus`**: the key is built from the channel's subject, so a template that writes `default#order.placed` and a handler that writes `order.placed` land in one bucket, and the buses have to agree inside it.
- **`function-call`**: keyed by package and export path where both are known.
- **`storage`**, **`runtime-config`**, **`metric`** and **`unit-invocation`**: each with its own identity. `storage` and `runtime-config` don't declare an identity key, and their checkers pair by container and by deployable unit instead.

Each variant declares its identity key, its pairing key, and how two sides agree. The pairing engine in `@suss/checker` dispatches through the registry, so a new boundary type adds a variant. [Boundary semantics](/theory/boundary-semantics) describes what a variant looks like and what adding one involves.

## What is not here

- **A full control flow graph.** suss identifies terminals and the conditions that gate them. Building a CFG and running data-flow analysis over it would capture more and cost orders of magnitude more.
- **Cross-service aggregation.** `@suss/checker` compares two summaries at a time. Aggregating across an organization, tracking boundaries over commits, and alerting on regressions are separate concerns that take pairwise findings as input. See [Cross-boundary checking](/why/cross-boundary-checking).
- **Runtime tracing.** Everything is static. suss never instruments your code and never reads anything from your running system.
- **Semantics for a dependency's calls.** Seeing `await db.findById(id)`, the extractor records that the subject is the result of `db.findById`. It records nothing about what Prisma's `findById` does. Cross-boundary comparison only needs subjects to be stable, so it does not need to know what they mean.
- **A shared adapter abstraction layer.** Three adapters ship, and each has its own analysis logic over its own parser. What they share is the layer above them: `assembleSummary` turns a `RawCodeStructure` into a summary for all three, so gap detection and confidence scoring have one implementation. Some tree-walking patterns are conceptually language-agnostic, such as finding every property access on a variable within a subtree, but a shared `@suss/adapter-core` should wait until the same pattern has been written twice for a reason.
- **A linter.** A finding describes what two sides of a contract disagree on. It is not a style rule or a code-quality opinion.
