# Pipelines

What each CLI action does under the hood, end to end. This is the
reference to read when a behavior surprises you and you want to trace it
without grepping the source. For the static package picture, see
[`architecture.md`](architecture.md); for finding semantics, see
[`cross-boundary-checking.md`](cross-boundary-checking.md).

## `suss extract`

Turns a TypeScript project into `BehavioralSummary[]`.

The CLI does almost nothing itself. When the command runs, it dynamically imports `@suss/adapter-typescript` — that lazy-import matters because it's the only package that pulls in ts-morph (a multi-megabyte dependency), and commands like `inspect` or `stub` shouldn't pay that cost.

The adapter then builds a ts-morph `Project` from the given `tsconfig`, walks every source file, and for each framework or runtime pack it's configured with, looks for discovery matches. A discovery match identifies one code unit (a handler, a client call site, a loader, …). For each matched unit the adapter runs the four extraction passes documented in [`extraction-algorithm.md`](extraction-algorithm.md) — terminal discovery, ancestor branch collection, early-return detection, and condition expression parsing — plus contract reading if the pack declares one. The output of that work per unit is a `RawCodeStructure`: a plain-data description with no AST references, ready to be serialized or tested against fixtures.

The extractor (`@suss/extractor.assembleSummary`) then normalizes each `RawCodeStructure` into a `BehavioralSummary`. It wraps un-decomposed conditions as `opaque`, detects declared-vs-produced gaps from the contract, assesses confidence, and assembles the summary. The CLI collects the array, parses it back through the IR validator as a sanity check, and writes it to disk.

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

`suss inspect --diff before.json after.json` and `suss inspect --dir summaries/` are variants over the same load-and-parse plumbing — the first uses `diffSummaries` to compute added / removed / changed transitions per summary pair, the second uses `pairSummaries` to show the boundary-pair overview (who is paired with whom, which summaries are unmatched).

All three modes share the same failure path: if `safeParseSummaries` reports issues, the CLI prints `Invalid summary file <path>: <issue paths>` and exits non-zero. No rendering happens on invalid input.

## `suss check`

Pairs provider and consumer summaries, emits findings.

The CLI loads both files through `safeParseSummaries` (same validation error path as `inspect`), then calls `checkPair(provider, consumer)`, which runs six independent check functions one after the other and concatenates their findings:

- `checkProviderCoverage` — does the consumer handle every status code the provider produces? Also checks sub-cases within a status (distinguishing predicates that the consumer doesn't distinguish).
- `checkConsumerSatisfaction` — does the consumer handle any status codes the provider never produces? (Dead branches.)
- `checkContractConsistency` — is the handler's behavior consistent with the declared contract it carries (e.g. ts-rest `responses`, OpenAPI schema)?
- `checkConsumerContract` — does the consumer read fields the declared contract doesn't promise? (Depends on undeclared implementation details.)
- `checkBodyCompatibility` — do the consumer's body-field reads line up with the provider's body shapes, per status?
- `checkSemanticBridging` — does the provider produce distinguishing literals or field-presence discriminators that the consumer collapses into a single branch?

Each check is pure over `(provider, consumer)`, emits `Finding[]`, and knows nothing about the other checks. The findings are then rendered (human or JSON) and the exit code is derived from `--fail-on` (`error`, `warning`, `info`, or `none`).

`suss check --dir summaries/` is the same flow with an upstream step: `pairSummaries` groups every summary by its boundary key (`(method, normalizedPath)` for HTTP today) and by role (`BOUNDARY_ROLE[kind]`), producing matched pairs + buckets of unmatched providers / consumers / summaries-with-no-binding. `checkPair` runs on each matched pair.

Pairing is HTTP-shaped today — see [`boundary-semantics.md`](boundary-semantics.md) for the planned refactor when a second boundary semantics lands.

## `suss contract --from openapi`

Turns an OpenAPI 3.x spec into `BehavioralSummary[]` carrying `confidence.source: "stub"`. Output is the same shape as `suss extract`, pairable with extracted consumers.

`@suss/contract-openapi` walks every `(path, operation)` in the spec. For each operation it emits one handler summary with:

- one transition per declared response (status code → body schema, converted to `TypeShape`),
- `metadata.http.declaredContract` populated so `checkContractConsistency` can cross-check a hypothetical provider (if you later extract one) against the spec,
- `confidence.source: "stub"` so downstream consumers know where this came from.

The CLI writes the result to disk after round-tripping through `safeParseSummaries` to catch any shape drift.

## `suss contract --from cloudformation`

The most layered stub: the same physical API can be expressed several ways in CFN, and we want them all to produce the same summaries.

Two phases, deliberately separated. The **manifest-reader** phase walks the raw CFN/SAM tree and builds normalized `RestApiConfig` / `HttpApiConfig` values — what is this API? what endpoints? what authorizer / CORS / throttle / integration config? That's pure parsing and grouping: it handles `AWS::ApiGateway::RestApi` + `AWS::ApiGateway::Method`, `AWS::ApiGatewayV2::Api` + `AWS::ApiGatewayV2::Route` + `AWS::ApiGatewayV2::Integration`, the SAM `AWS::Serverless::Api` / `AWS::Serverless::HttpApi` shorthand, and SAM `Events.Api` / `Events.HttpApi` blocks. It also handles inline OpenAPI bodies on RestApis.

The **resource-semantics** phase turns each normalized config into `BehavioralSummary[]` with platform-injected transitions — authorizer 401/403, API key 403, request-validator 400, throttle 429, integration 502/504, CORS preflight OPTIONS. That logic lives in `@suss/contract-aws-apigateway`, which is independently consumable: a future hand-authored API Gateway stub path (no CFN involved) would go straight into the semantics layer. When the manifest has an inline OpenAPI body, CFN delegates that part to `@suss/contract-openapi` instead.

```
User
 │  suss contract --from cloudformation -i template.yaml -o api.json
 ▼
@suss/cli
 │  read template.yaml
 ▼
@suss/contract-cloudformation
 │
 │  ── manifest-reader phase ─────────────────────────────
 │    buildRestApiConfigs:   group AWS::ApiGateway::Method by RestApiId
 │    buildHttpApiConfigs:   group AWS::ApiGatewayV2::Route by ApiId
 │    readSamApiEvents / readSamHttpApiEvents: expand SAM Events
 │    readCors, collect authorizers / throttle / integration types
 │    (→ normalized RestApiConfig / HttpApiConfig)
 │
 │  ── resource-semantics phase ──────────────────────────
 │    inline OpenAPI body?  →  @suss/contract-openapi
 │    restApiToSummaries(config)  →  @suss/contract-aws-apigateway
 │    httpApiToSummaries(config)  →  @suss/contract-aws-apigateway
 │                (emits handler transitions per declared status
 │                 + authorizer 401/403, apiKey 403, validator 400,
 │                 throttle 429, integration 502/504, CORS OPTIONS)
 │
 ▼
BehavioralSummary[] → write api.json
```

See [`stubs.md`](stubs.md) for the doctrine behind this split and the opaque-predicate naming convention for transcribed external contracts.

## Internal: `RawCodeStructure` → `BehavioralSummary`

One level deeper than `suss extract`: what `assembleSummary` actually does.

It reads the raw branches and produces one `Transition` per branch — structured predicates pass through, un-decomposed conditions get wrapped as `opaque`, the transition ID is minted from `(function, terminal kind, status, conditionHash)` so it survives branch reordering. It reads the raw declared contract and cross-references it against the produced statuses, emitting `Gap` entries both directions (declared-but-not-produced, produced-but-not-declared). It counts the ratio of opaque to structured predicates and assigns a confidence level. Finally it assembles the summary object, nesting any HTTP-scoped metadata under `metadata.http.*` per the [boundary-semantics](boundary-semantics.md) namespacing convention.

Each step is small, pure over `RawCodeStructure`, and independently testable — which is why the extractor test suite runs in milliseconds and takes no compiler dependency.

## Internal: cross-boundary pairing

Before `suss check --dir` runs `checkPair`, it has to decide which summaries face each other across a boundary. `pairSummaries` does that in three passes:

1. Classify each summary by its role via `BOUNDARY_ROLE[summary.kind]` — provider (handler, loader, action, middleware, resolver, worker, component, hook) or consumer (client, consumer). Summaries with an unrecognized kind land in `unmatched.noBinding` rather than crashing — that's the runtime guard deferred until the zod IR migration makes it unreachable.
2. Derive a boundary key for each summary via `boundaryKey(binding)`. Today that's `"<METHOD> <normalizedPath>"` with path normalization that treats `:id` and `{id}` equivalently and lowercases static segments. Summaries without a path go into `unmatched.noBinding`.
3. Group by (key × role). Every key that has at least one provider AND one consumer yields pairs (`N × M` cross-product within the group). Keys with only one side populate `unmatched.providers` or `unmatched.consumers`.

The result is `{ pairs, unmatched }`. `checkPair` runs on each pair; the unmatched lists surface in the CLI output so you can see what didn't line up.

This logic is REST-shaped — both the key function and the role classification assume HTTP. When a second boundary semantics lands, pairing dispatches on the binding's semantics variant (GraphQL pairs by operation name, Kafka by topic, Lambda by function name). See [`boundary-semantics.md`](boundary-semantics.md).
