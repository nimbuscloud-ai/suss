# Pipelines

What each CLI action does under the hood, end to end. This is the
reference to read when a behavior surprises you and you want to trace it
without grepping the source. For the static package picture, see
[`architecture.md`](architecture.md); for finding semantics, see
[`cross-boundary-checking.md`](cross-boundary-checking.md).

## `suss extract`

Turns a TypeScript project into `BehavioralSummary[]`.

The CLI does almost nothing itself. When the command runs, it dynamically imports `@suss/adapter-typescript`. That lazy import matters because the adapter is the only package that pulls in ts-morph (a multi-megabyte dependency), which a command like `inspect` shouldn't pay for.

The adapter then builds a ts-morph `Project` from the given `tsconfig`, walks every source file, and for each framework or runtime pack it's configured with, looks for discovery matches. A discovery match identifies one code unit (a handler, a client call site, a loader, …). For each matched unit the adapter runs the four extraction passes documented in [`extraction-algorithm.md`](extraction-algorithm.md) (terminal discovery, ancestor branch collection, early-return detection, and condition expression parsing), plus contract reading if the pack declares one. The output of that work per unit is a `RawCodeStructure`: a plain-data description with no AST references, ready to be serialized or tested against fixtures.

The extractor (`@suss/extractor.assembleSummary`) then normalizes each `RawCodeStructure` into a `BehavioralSummary`. It wraps un-decomposed conditions as `opaque`, records gaps where the contract and the code disagree or where a return matched no terminal shape, assesses confidence, and assembles the summary. The CLI collects the array, parses it back through the IR validator as a sanity check, and writes it to disk.

```
User
 │  suss extract -p tsconfig.json -f ts-rest -o out.json
 ▼
@suss/cli
 │  dynamic import(@suss/adapter-typescript)  ← lazy, avoids ts-morph cost on non-extract commands
 │
 ▼
@suss/adapter-typescript
 │  build ts-morph Project from tsconfig
 │
 │  for each source file:
 │    for each pack (ts-rest, axios, …):
 │      discovery.patterns → matched code units
 │      for each unit:
 │        run 4 extraction passes (terminals, branches, early returns, conditions)
 │        produce RawCodeStructure
 │        │
 │        ▼
 │      @suss/extractor.assembleSummary(raw)
 │        wraps opaque predicates, detects gaps, assesses confidence
 │        ▼
 │      BehavioralSummary
 │
 ▼
BehavioralSummary[] → write out.json
```

The adapter/extractor split is the key invariant of this pipeline: the adapter owns everything AST-shaped, the extractor never sees a node. Adding a second language (Python, Go) means writing a new adapter that emits `RawCodeStructure`; the extractor doesn't change.

## `suss inspect`

Renders summaries as human-readable output.

`suss inspect summaries.json` loads the file, runs it through `safeParseSummaries` (so any malformed JSON fails with a clear path-pointed error message before rendering), and then iterates the summaries, formatting each one as a tree of transitions with conditions, outputs, and gaps.

`suss inspect --diff before.json after.json` and `suss inspect --dir summaries/` are variants over the same load-and-parse plumbing. The first uses `diffSummaries` to compute added / removed / changed transitions per summary pair, the second uses `pairSummaries` to show the boundary-pair overview (who is paired with whom, which summaries are unmatched).

All three modes share the same failure path: if `safeParseSummaries` reports issues, the CLI prints `Invalid summary file <path>: <issue paths>` and exits non-zero. No rendering happens on invalid input.

## `suss check`

Pairs provider and consumer summaries, emits findings.

The CLI loads both files through `safeParseSummaries` (same validation error path as `inspect`), then calls `checkPair(provider, consumer)`, which runs six independent check functions one after the other and concatenates their findings:

- `checkProviderCoverage`: does the consumer handle every status code the provider produces? Also checks sub-cases within a status (distinguishing predicates that the consumer doesn't distinguish).
- `checkConsumerSatisfaction`: does the consumer handle any status codes the provider never produces? (Dead branches.)
- `checkContractConsistency`: is the handler's behavior consistent with the declared contract it carries (e.g. ts-rest `responses`, OpenAPI schema)?
- `checkConsumerContract`: does the consumer read fields the declared contract doesn't promise? (Depends on undeclared implementation details.)
- `checkBodyCompatibility`: do the consumer's body-field reads line up with the provider's body shapes, per status?
- `checkSemanticBridging`: does the provider produce distinguishing literals or field-presence discriminators that the consumer collapses into a single branch?

Each check is pure over `(provider, consumer)`, emits `Finding[]`, and knows nothing about the other checks. The findings are then rendered (human or JSON) and the exit code is derived from `--fail-on` (`error`, `warning`, `info`, or `none`).

`suss check --dir summaries/` is the same flow with an upstream step: `pairSummaries` groups every summary by its boundary key (`(method, normalizedPath)` for HTTP today) and by role (`BOUNDARY_ROLE[kind]`), producing matched pairs + buckets of unmatched providers / consumers / summaries-with-no-binding. `checkPair` runs on each matched pair.

<svg class="suss-diagram" viewBox="0 0 660 356" role="img" aria-labelledby="check-title check-desc">
  <title id="check-title">How a folder of summaries becomes findings</title>
  <desc id="check-desc">Every summary in the folder is grouped by its boundary key and by whether it provides or consumes. Groups holding both sides become pairs, which run through six independent checks. Groups holding one side are reported as waiting for a counterpart.</desc>

  <defs>
    <marker id="check-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <text class="axis" x="330" y="14" text-anchor="middle">summaries/</text>
  <rect class="box-data" x="150" y="24" width="80" height="30" rx="5" />
  <text class="label-mono" x="190" y="43" text-anchor="middle">api.json</text>
  <rect class="box-data" x="240" y="24" width="80" height="30" rx="5" />
  <text class="label-mono" x="280" y="43" text-anchor="middle">web.json</text>
  <rect class="box-data" x="330" y="24" width="90" height="30" rx="5" />
  <text class="label-mono" x="375" y="43" text-anchor="middle">stripe.json</text>
  <rect class="box-data" x="430" y="24" width="80" height="30" rx="5" />
  <text class="note" x="470" y="43" text-anchor="middle">and so on</text>

  <line class="arrow" x1="330" y1="54" x2="330" y2="76" marker-end="url(#check-arrow)" />

  <rect class="box" x="140" y="82" width="380" height="56" rx="6" />
  <text class="label" x="330" y="102" text-anchor="middle">Group every summary by the boundary it describes</text>
  <text class="note" x="330" y="119" text-anchor="middle">the key is (method, path) for HTTP, and each summary is</text>
  <text class="note" x="330" y="133" text-anchor="middle">either the side that provides it or the side that calls it</text>

  <line class="arrow" x1="260" y1="138" x2="220" y2="176" marker-end="url(#check-arrow)" />
  <line class="arrow" x1="400" y1="138" x2="490" y2="176" marker-end="url(#check-arrow)" />

  <rect class="box" x="30" y="182" width="380" height="40" rx="6" />
  <text class="label" x="220" y="200" text-anchor="middle">Both sides present</text>
  <text class="note" x="220" y="215" text-anchor="middle">one pair per group</text>

  <rect class="box" x="430" y="182" width="210" height="40" rx="6" />
  <text class="label" x="535" y="200" text-anchor="middle">One side only</text>
  <text class="note" x="535" y="215" text-anchor="middle">reported, not compared</text>

  <line class="arrow" x1="220" y1="222" x2="220" y2="244" marker-end="url(#check-arrow)" />

  <rect class="box" x="30" y="250" width="380" height="70" rx="6" />
  <text class="label" x="220" y="269" text-anchor="middle">Six checks, each reading only this pair</text>
  <text class="note" x="220" y="286" text-anchor="middle">statuses in both directions, sub-cases within a status,</text>
  <text class="note" x="220" y="300" text-anchor="middle">body fields, the declared contract, and semantic bridging</text>
  <text class="note" x="220" y="314" text-anchor="middle">none of them can see what another found</text>

  <line class="arrow" x1="220" y1="320" x2="220" y2="340" marker-end="url(#check-arrow)" />
  <text class="label" x="220" y="352" text-anchor="middle">Findings</text>
</svg>

Pairing is HTTP-shaped today. See [`boundary-semantics.md`](boundary-semantics.md) for the planned refactor when a second boundary semantics lands.

## `suss contract --from openapi`

Turns an OpenAPI 3.x spec into `BehavioralSummary[]` carrying `confidence.source: "derived"`. Output is the same shape as `suss extract`, pairable with extracted consumers.

`@suss/contract-openapi` walks every `(path, operation)` in the spec. For each operation it emits one handler summary with:

- one transition per declared response (status code → body schema, converted to `TypeShape`),
- `metadata.http.declaredContract` populated so `checkContractConsistency` can cross-check a hypothetical provider (if you later extract one) against the spec,
- `confidence.source: "derived"` so downstream consumers know where this came from.

The CLI writes the result to disk after round-tripping through `safeParseSummaries` to catch any shape drift.

## `suss contract --from cloudformation`

The most layered contract reader: the same physical API can be expressed several ways in CFN, and we want them all to produce the same summaries.

Three layers, deliberately separated. The raw template parse (a file on disk to plain data, resolving the CFN intrinsic YAML tags) lives in `@suss/manifest-aws`, shared with the manifest-driven framework packs. On top of it, the **manifest-reader** layer in `@suss/contract-cloudformation` walks the parsed tree and builds normalized `RestApiConfig` / `HttpApiConfig` values (what is this API, what endpoints, what authorizer, CORS, throttle, and integration config), through `buildRestApiConfigs`, `buildHttpApiConfigs`, `readSamApiEvents`, `readSamHttpApiEvents`, and `readCors`. That is pure grouping: it handles `AWS::ApiGateway::RestApi` + `AWS::ApiGateway::Method`, `AWS::ApiGatewayV2::Api` + `AWS::ApiGatewayV2::Route` + `AWS::ApiGatewayV2::Integration`, the SAM `AWS::Serverless::Api` / `AWS::Serverless::HttpApi` shorthand, and SAM `Events.Api` / `Events.HttpApi` blocks. It also handles inline OpenAPI bodies on RestApis.

The **resource-semantics** layer turns each normalized config into `BehavioralSummary[]` with platform-injected transitions: authorizer 401/403, API key 403, request-validator 400, throttle 429, integration 502/504, CORS preflight OPTIONS. That logic lives in `restApiToSummaries` and `httpApiToSummaries` in `@suss/contract-aws-apigateway`, which is independently consumable, so a future hand-authored API Gateway path (no CFN involved) would go straight into the semantics layer. When the manifest has an inline OpenAPI body, CFN delegates that part to `@suss/contract-openapi` instead.

The three layers, and why each one is separate:

<svg class="suss-diagram" viewBox="0 0 660 316" role="img" aria-labelledby="cfn-title cfn-desc">
  <title id="cfn-title">The three layers of the CloudFormation reader</title>
  <desc id="cfn-desc">A template is parsed once into plain data, grouped into normalized API configurations, then turned into summaries carrying the statuses API Gateway itself produces. Each layer lives in its own package so the layer above it can be reached without the layers below.</desc>

  <defs>
    <marker id="cfn-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path class="arrow-head" d="M0,1 L7,4 L0,7 Z" />
    </marker>
  </defs>

  <rect class="box-data" x="215" y="8" width="230" height="30" rx="6" />
  <text class="label-mono" x="330" y="27" text-anchor="middle">template.yaml</text>
  <line class="arrow" x1="330" y1="38" x2="330" y2="58" marker-end="url(#cfn-arrow)" />

  <rect class="box" x="120" y="64" width="420" height="56" rx="6" />
  <text class="label" x="330" y="84" text-anchor="middle">Parse the template</text>
  <text class="note" x="330" y="101" text-anchor="middle">a file becomes plain data, resolving CloudFormation's own tags</text>
  <text class="label-mono" x="330" y="116" text-anchor="middle">@suss/manifest-aws</text>
  <line class="arrow" x1="330" y1="120" x2="330" y2="140" marker-end="url(#cfn-arrow)" />

  <rect class="box" x="120" y="146" width="420" height="70" rx="6" />
  <text class="label" x="330" y="166" text-anchor="middle">Group it into one shape per API</text>
  <text class="note" x="330" y="183" text-anchor="middle">a REST API, an HTTP API, and the SAM shorthand for either</text>
  <text class="note" x="330" y="198" text-anchor="middle">all describe the same thing, so they normalize to one config</text>
  <text class="label-mono" x="330" y="213" text-anchor="middle">@suss/contract-cloudformation</text>
  <line class="arrow" x1="330" y1="216" x2="330" y2="236" marker-end="url(#cfn-arrow)" />

  <rect class="box" x="120" y="242" width="420" height="70" rx="6" />
  <text class="label" x="330" y="262" text-anchor="middle">Say what the gateway answers</text>
  <text class="note" x="330" y="279" text-anchor="middle">401 and 403 from an authorizer, 429 from a throttle, 504 on timeout:</text>
  <text class="note" x="330" y="294" text-anchor="middle">statuses your handler never writes and your caller still receives</text>
  <text class="label-mono" x="330" y="309" text-anchor="middle">@suss/contract-aws-apigateway</text>

  <line class="seam" x1="548" y1="242" x2="652" y2="242" />
  <text class="note" x="652" y="233" text-anchor="end">usable alone,</text>
  <text class="note" x="652" y="261" text-anchor="end">no template</text>
</svg>


See [`contract-sources.md`](contract-sources.md) for the doctrine behind this split and the opaque-predicate naming convention for transcribed external contracts.

## Internal: `RawCodeStructure` → `BehavioralSummary`

One level deeper than `suss extract`: what `assembleSummary` actually does.

It reads the raw branches and produces one `Transition` per branch. Structured predicates pass through, un-decomposed conditions get wrapped as `opaque`, and the transition ID is minted from `(function, terminal kind, status, conditionHash)` so it survives branch reordering. It reads the raw declared contract and cross-references it against the produced statuses, emitting an `unhandledCase` gap in each direction (declared-but-not-produced, produced-but-not-declared). A return that matched no terminal shape in the pack becomes an `unreadOutcome` gap instead, and that one also forces confidence to `low`. Otherwise it counts the ratio of opaque to structured predicates and assigns a confidence level from that. Finally it assembles the summary object, nesting any HTTP-scoped metadata under `metadata.http.*` per the [boundary-semantics](boundary-semantics.md) namespacing convention.

Each step is small, pure over `RawCodeStructure`, and independently testable, which is why the extractor test suite runs in milliseconds and takes no compiler dependency.

## Internal: cross-boundary pairing

Before `suss check --dir` runs `checkPair`, it has to decide which summaries face each other across a boundary. `pairSummaries` does that in three passes:

1. Classify each summary by its role via `BOUNDARY_ROLE[summary.kind]`: provider (handler, loader, action, middleware, resolver, worker, component, hook) or consumer (client, consumer). Summaries with an unrecognized kind land in `unmatched.unpairable` with reason `unknownKind` rather than crashing, the runtime guard deferred until the zod IR migration makes it unreachable.
2. Derive a boundary key for each summary via `boundaryKey(binding)`. Today that's `"<METHOD> <normalizedPath>"` with path normalization that treats `:id` and `{id}` equivalently and lowercases static segments. Summaries without a path land in `unmatched.unpairable` with reason `unnamedBoundary`.
3. Group by (key × role). Every key that has at least one provider AND one consumer yields pairs (`N × M` cross-product within the group). Keys with only one side populate `unmatched.providers` or `unmatched.consumers`.

The result is `{ pairs, unmatched }`. `checkPair` runs on each pair; the unmatched lists surface in the CLI output so you can see what didn't line up.

This logic is REST-shaped: both the key function and the role classification assume HTTP. When a second boundary semantics lands, pairing dispatches on the binding's semantics variant (GraphQL pairs by operation name, Kafka by topic, Lambda by function name). See [`boundary-semantics.md`](boundary-semantics.md).
