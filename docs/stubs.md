# Stubs

A stub is a behavioral contract authored at the boundary, not extracted from implementation. Stubs produce the same `BehavioralSummary[]` as the extractor and feed the same checker. The source of truth varies — an OpenAPI YAML, a CloudFormation template, the published behavior of an external service, a hand-written file — but the artifact is the same.

> **Related reading:**
> - [`motivation.md`](motivation.md) — why behavioral summaries exist
> - [`architecture.md`](architecture.md) — how packages fit together
> - [`behavioral-summary-format.md`](behavioral-summary-format.md) — the IR / wire format
> - [`ir-reference.md`](ir-reference.md) — type-by-type walkthrough
> - [`contracts.md`](contracts.md) — the five shapes of declared contracts suss absorbs (schema, examples, tests, snapshots, design); every shipping stub today reads the **schema** shape
> - [`roadmap-react.md`](roadmap-react.md) — the first domain where multiple contract shapes for one boundary are actively planned

## What a stub is, and isn't

A stub describes the **boundary contract** of a system: the set of observable behaviors a caller can rely on. It does not describe the implementation. Source code, when available, is one way to derive a boundary contract; a stub derives the same contract from another source of truth.

A stub is not:

- A fallback for when extraction fails. Stubs are a complementary path, often *higher* fidelity than extraction (a clean OpenAPI spec is sharper than ambiguous TypeScript).
- A guess or placeholder. Every transition a stub emits should be a behavior the system genuinely produces under the conditions described.
- Implementation-specific. Two stubs of the same boundary written from different source formats (CFN vs CDK synth) should produce equivalent summaries.

## Sources of truth

Stubs draw from one of four categories:

| Category | Examples | Characteristics |
|---|---|---|
| **Specs** | OpenAPI, GraphQL SDL, AsyncAPI, `.proto` | Machine-readable, intended for tooling. Coverage gaps in the spec become coverage gaps in the summary. |
| **Manifests** | CloudFormation, CDK synth output, Terraform plan, Kubernetes manifests | Deployment artifacts that describe a system's surface as a side effect. Often share underlying resources across formats — see "Manifest readers vs resource semantics" below. |
| **Vendor docs** | AWS service behavior, Stripe API reference, GitHub API docs | Authoritative behavior for an external system, transcribed into a summary. The "spec" lives in the vendor's documentation. |
| **Hand-authored** | Internal team contracts, `.suss.yaml` files | Used when no machine-readable source exists yet, or when the team wants to publish a contract independent of any one implementation. |

Each category has different update cadence and different fidelity characteristics. The IR doesn't distinguish them; `confidence.source: "stub"` covers all four.

## `confidence.source: "stub"`

Every transition a stub emits carries `confidence: { source: "stub", level: <high|medium|low> }`.

- `source: "stub"` tells downstream consumers (checker, inspect, diff) that this transition came from a contract, not from observed code structure. The checker treats it identically — pairing is by `(method, normalisedPath)` regardless of source — but tooling can filter or display by source.
- `level` reflects how precisely the source declared the behavior. An OpenAPI `200` response with a typed body schema is `high`. A `2XX` range expansion or a body shape with `additionalProperties: true` may be `medium` or `low`.

A stub being marked `"stub"` does not imply lower fidelity than extracted code. It tells you *where the description came from*, not *how trustworthy it is*.

## Manifest readers vs resource semantics

When the same underlying resource can be authored in multiple source formats, split the stub package along this seam:

- **Manifest reader** — knows how to parse one source format. Walks the source tree, resolves cascading defaults (stage → method, API → endpoint), normalizes references, and builds a per-resource config. Calls into the resource-semantics layer.
- **Resource semantics** — knows what the underlying resource actually does. Manifest-agnostic. Takes a normalized config, emits `BehavioralSummary[]` reflecting the full contract of that resource type.

Worked example for AWS API Gateway:

```
packages/stub/
  cloudformation/      manifest reader (CFN + SAM templates)
  cdk-synth/           (future) manifest reader (cdk synth output)
  terraform/           (future) manifest reader (terraform plan)
  aws-apigateway/      resource semantics (REST + HTTP API)
```

All three readers ultimately call `restApiToSummaries(config)` / `httpApiToSummaries(config)`. Adding a Terraform reader doesn't reimplement API Gateway behavior — it parses Terraform, builds the same normalized config, and delegates.

For sources where there's no plausible second reader (a single OpenAPI document is the whole spec), the split adds no value. `@suss/stub-openapi` is a single package.

## Configuration drives behavior

A stub must capture *configuration-driven* behavior, not just the structural surface. An API Gateway endpoint with no authorizer produces what its integration returns. Add an authorizer and the same endpoint can also return 401/403. Add throttling and it can return 429. The summary has to reflect the full envelope.

For each behavioral knob in the source format, identify:

1. What configuration enables it
2. What status codes, headers, or body shapes it can produce
3. Whether it interacts with handler-attributed transitions or stands alone

API Gateway example:

| Configuration | Effect |
|---|---|
| Authorizer (any type) | 401 (missing/invalid credentials), 403 (authenticated but denied) |
| API key required | 403 |
| Request validation | 400 |
| Throttling (per-stage / per-method / usage plan) | 429 |
| Integration timeout | 504 |
| Lambda integration error | 502 |
| CORS configured | Synthesized OPTIONS preflight endpoint, `Access-Control-*` headers |

If the source format expresses a knob the stub doesn't model, the summary will under-describe the system. That's a defect, not a deferral — fix it.

## Transcribing external contracts: opaque-predicate convention

When a transition is gated by a contract from an external system that we can't structurally inspect (the authorizer's decision, the throttler's state, a vendor's policy engine), use an opaque predicate:

```typescript
{
  type: "opaque",
  sourceText: "<vendor>:<service>:<contract>",
  reason: "externalFunction"
}
```

Naming convention for `sourceText`:

- **Vendor prefix** — `aws`, `stripe`, `github`, `kubernetes`, etc.
- **Service / resource** — `apigateway`, `s3`, `lambda`, `cards`
- **Contract name** — `authorizer.reject`, `throttle.exceeded`, `card.declined`

Examples:

```
aws:apigateway:status-401      // platform-injected status from authorizer
aws:apigateway:status-429      // throttle-induced
stripe:cards:card_declined     // vendor contract
github:rate-limit              // vendor rate-limit envelope
```

Stable namespacing means inspect/diff can group related transitions across stubs without each one inventing its own labels.

## Per-transition metadata

Stubs use `Transition.metadata` (added to the IR for this purpose, but available to any producer) to carry provenance and aggregated attribution:

```json
{
  "source": "aws::apigateway::platform",
  "platform": "apiGateway",
  "causes": ["authorization", "api-key"],
  "configRefs": [
    { "file": "template.yaml", "pointer": "Resources/UsersAuth" }
  ]
}
```

Recommended keys:

- `source` — package + resource that emitted the transition (e.g., `"aws::apigateway::integration.lambda-proxy"`, `"openapi::responses"`)
- `platform` — the contract platform when applicable, used for filtering
- `causes` — list of contributing configuration knobs when multiple collapse into one transition (see next section)
- `configRefs` — pointers back into the source for inspect/diff to render
- `vendor` — vendor identifier for contracts from third-party docs

The checker ignores `metadata`. Inspect and diff use it to render attribution.

## Collapsing multiple causes for the same status

A single endpoint can have several configuration knobs that all produce the same status code. An authorizer and an API key requirement both produce 403; throttling and a usage plan both produce 429. Two ways to represent this:

1. Multiple transitions for the same status, each with a different opaque predicate.
2. One transition for the status, with the contributing causes aggregated in `metadata.causes`.

**Use option 2.** The checker's sub-case analysis (see `checker/src/provider-coverage.ts`) treats multiple transitions for the same status as cases the consumer is expected to disambiguate. A consumer can't actually know whether a 403 came from the authorizer or the API key, and shouldn't have to disambiguate. Aggregation preserves the attribution for inspect/diff without forcing artificial branching on the consumer side.

## Synthetic resources

Some platform behavior doesn't modify an existing endpoint — it creates a new one. AWS API Gateway with CORS configured responds to OPTIONS requests on every CORS-enabled path with `Access-Control-*` headers. There is no handler code; the platform synthesizes the response.

Emit these as standalone `BehavioralSummary` entries:

- One per unique path
- `boundaryBinding`: `method: "OPTIONS"`, path matching the resource path
- One transition: appropriate status (204 for CORS preflight), headers populated from configuration
- `metadata.synthetic` naming the synthesis rule (e.g., `"cors-preflight"`)

A synthesized summary is not a fiction. The platform genuinely responds at that boundary. Treating it as a real boundary lets a TypeScript consumer that does `fetch(path, { method: "OPTIONS" })` pair with it like any other endpoint.

## Pairing with extracted consumers

Stubs and extracted summaries pair through the same path-normalized matching (`:id` ↔ `{id}`, etc.). A TypeScript axios consumer of `GET /users/{id}` pairs with:

- An extracted handler with the same method + path
- A stub-emitted summary from any source format with the same method + path

The checker doesn't differentiate by source. `confidence.source` is preserved on each side so downstream consumers can filter findings by source if needed (e.g., "show me only mismatches against extracted providers, not stubs").

## What's deliberately not here

- **Stubs don't validate their own input.** A malformed CFN template, an OpenAPI spec with broken `$ref`s, a config with impossible values — all produce best-effort output rather than errors. Source-format validation is the responsibility of that format's tooling, not ours.
- **Stubs don't predict runtime state.** A throttle-configured endpoint *can* return 429; whether it *does* depends on actual traffic. The summary represents the envelope of possible behaviors, not a prediction.
- **Stubs don't model authorization decisions per caller.** "Authorizer attached → 401/403 possible" is captured. "User X with role Y on resource Z is denied" is not — that's runtime state.
- **Stubs don't backfill missing fields the source format doesn't declare.** If an OpenAPI response body has no schema, the stub emits a `null` body, not a guess.

## Adding a new stub

Two questions to answer before you write code:

1. **What's the source of truth?** Pick one of: spec / manifest / vendor docs / hand-authored. The package's name, location, and dependencies follow.
2. **Does the resource exist in multiple source formats?** If yes, build the resource-semantics layer first; the manifest reader becomes a thin shell. If no, a single package is sufficient.

Then for each behavioral knob the source format expresses:

1. List the status codes / headers / body shapes it can produce
2. Decide whether it interacts with handler-attributed transitions or stands alone
3. Pick the opaque predicate `sourceText` namespace
4. Decide what attribution to put in `Transition.metadata`

Conventions:

- Package name: `@suss/stub-<source-format>` for spec/manifest readers, `@suss/stub-<vendor>-<service>` for resource-semantics layers
- All transitions carry `confidence.source: "stub"`
- All synthesized boundaries carry `metadata.synthetic` naming the synthesis rule
- All platform-injected predicates use the namespaced opaque convention
- Tests should cover each configuration knob's effect on the emitted summary, including default-cascading behavior when applicable
