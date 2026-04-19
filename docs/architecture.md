# Architecture

suss extracts **behavioral summaries** from source code — structured descriptions of every execution path through a function, mapping *conditions* to *outputs*. This document explains how the pieces fit together.

> **Related reading:**
> - [`motivation.md`](motivation.md) for the *why*
> - [`extraction-algorithm.md`](extraction-algorithm.md) for the detailed algorithm
> - [`ir-reference.md`](ir-reference.md) for the type-by-type walkthrough
> - [`framework-packs.md`](framework-packs.md) for pattern-writing

## The core idea

Most analysis tools describe *structure* (a function has these parameters, returns this type). suss describes *behavior*: "when `user` is null, this handler throws 404; otherwise it returns 200 with a `User` shape". Behavioral summaries are language- and framework-agnostic JSON, so downstream tools (contract checkers, doc generators, test enumerators, impact analyzers) can operate on them without caring whether the source was TypeScript, Python, or anything else.

## Data flow

Extraction is a straight line with one intermediate data shape, `RawCodeStructure`, between the AST-shaped layer (the adapter) and the assembly layer (the extractor):

```
Source files
    │
    │  Language adapter (@suss/adapter-typescript)
    │    loads project via compiler API (ts-morph)
    │    uses framework-pack patterns to discover code units
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
3. **Framework pack authors** never touch the adapter or extractor — they describe patterns declaratively.

## The vocabulary

These terms are used consistently across the codebase. Most are illustrated with a running example: this ts-rest handler.

```typescript
// The running example for this section
export const getUser = async ({ params }: { params: { id: string } }) => {
  const user = await db.findById(params.id);
  if (!user) {
    return { status: 404, body: { error: "not found" } };
  }
  return { status: 200, body: user };
};
```

**Code unit**: a callable piece of code (handler, loader, component, resolver, consumer). The atomic unit of analysis. Every code unit has a **kind** that determines its behavioral model. In the example above, `getUser` is a code unit of kind `"handler"`.

**Boundary**: an identifiable point of interaction (REST endpoint, GraphQL operation, message queue topic). Boundaries are where behavioral contracts matter. For `getUser`, the boundary is `GET /users/:id` — the code unit is *bound* to that boundary via the framework's registration mechanism.

**Terminal**: a point in a code unit where observable output is produced. Terminals are framework-specific but the *output type* is universal. In the running example there are two terminals — the highlighted lines below:

```typescript
if (!user) {
  return { status: 404, body: { error: "not found" } };  // ← terminal 1
}
return { status: 200, body: user };                       // ← terminal 2
```

Other terminal shapes: `res.status(400).json(...)` in Express, `throw httpErrorJson(404)` in React Router, a JSX return in a React component.

**Transition**: `(conditions → output, effects)`. The atomic unit of behavioral description. A code unit's full behavior is its set of transitions. `getUser` has two:

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

**Predicate**: a structured condition gating a transition. Has a **subject** (what value is tested), a **test** (nullness, equality, etc.), and composes into `and`/`or`/`negation`. The source expression `!user` becomes:

```json
{
  "type": "truthinessCheck",
  "subject": { "type": "dependency", "name": "db.findById", "accessChain": [] },
  "negated": true
}
```

When the extractor can't decompose an expression (complex function calls, dynamic computation), it falls back to an `opaque` predicate that preserves the source text.

**Subject / ValueRef**: a reference to a value with an *origin* (parameter, dependency call, import, context) and a *path* (property access chain). Shallow on purpose: identifies what's being tested without trying to understand its full semantics. A deeper example — `container.repository.lastAnalyzedCommitHash`, where `container` came from `await prisma.containerV2.findUnique(...)`:

```json
{
  "type": "derived",
  "from": {
    "type": "derived",
    "from": { "type": "dependency", "name": "prisma.containerV2.findUnique", "accessChain": [] },
    "derivation": { "type": "propertyAccess", "property": "repository" }
  },
  "derivation": { "type": "propertyAccess", "property": "lastAnalyzedCommitHash" }
}
```

Two predicates that test the same subject — on different sides of a service boundary — should be recognizable as referring to the same thing. That's why the shape is structural, not a raw string.

**Output**: what a terminal produces. One of: `response`, `throw`, `render`, `return`, `delegate`, `emit`, or `void`. The `response` variant from the running example:

```json
{
  "type": "response",
  "statusCode": { "type": "literal", "value": 200 },
  "body": { "type": "ref", "name": "User" },
  "headers": {}
}
```

**Gap**: a case the code unit doesn't explicitly handle. First-class in the summary, not an error. If the declared contract for `getUser` says the endpoint can return `200 | 404 | 500`, but the handler never actually produces 500, that's a gap:

```json
{
  "type": "unhandledCase",
  "consequence": "frameworkDefault",
  "description": "Declared response 500 is never produced by the handler"
}
```

Gaps run both directions: *declared but not produced* (as above) and *produced but not declared* (contract violation).

**Declared contract**: a machine-readable behavioral declaration authored alongside the implementation. For `getUser`, a ts-rest contract:

```typescript
const contract = c.router({
  getUser: {
    method: "GET",
    path: "/users/:id",
    pathParams: z.object({ id: z.string() }),
    responses: {
      200: UserSchema,
      404: ErrorSchema,
      500: ErrorSchema,
    },
  },
});
```

The extractor reads both the declaration and the implementation, and the checker compares them.

**Framework pack**: declarative patterns describing how to find code units, what terminals look like, and how inputs are delivered for a specific framework. They are data, not code — the adapter interprets them.

```typescript
tsRestFramework(): PatternPack {
  return {
    name: "ts-rest",
    languages: ["typescript"],
    discovery: [{ kind: "handler", match: { type: "registrationCall", ... } }],
    terminals: [{ kind: "response", match: { type: "returnShape",
                  requiredProperties: ["status", "body"] }, extraction: { ... } }],
    contractReading: { ... },
    inputMapping: { type: "destructuredObject", knownProperties: { ... } },
  };
}
```

**Confidence**: how much of a code unit's behavior was structurally analyzed vs. opaque. Computed as the ratio of opaque predicates to total predicates, bucketed into `high` / `medium` / `low`. Falls back to opaque predicates when the extractor can't decompose something, so downstream consumers can treat low-confidence summaries with appropriate skepticism.

## Package layout

```
@suss/behavioral-ir          zod schemas, types, parsers. One peer dep on zod.
    │                        Install this to consume summaries.
    │
    ├─ @suss/extractor           assembly engine + PatternPack interface. No AST access.
    │     │
    │     ├─ @suss/adapter-typescript    ts-morph-based extraction (provider + consumer)
    │     │
    │     ├─ @suss/framework-ts-rest     declarative patterns (handler + client discovery)
    │     ├─ @suss/framework-react-router
    │     ├─ @suss/framework-express
    │     ├─ @suss/framework-fastify
    │     ├─ @suss/runtime-web           fetch call-site discovery
    │     └─ @suss/runtime-axios         axios call-site discovery
    │
    ├─ @suss/stub-openapi            OpenAPI 3.x → BehavioralSummary[]
    ├─ @suss/stub-aws-apigateway     API Gateway resource semantics (config → summaries)
    ├─ @suss/stub-cloudformation     CFN / SAM → BehavioralSummary[]
    │                                (delegates to openapi + aws-apigateway)
    │
    └─ @suss/checker             pairwise cross-boundary checker. IR-only consumer.
          │
       @suss/cli                 thin wrapper over extractor + checker + stubs
```

Dependency rules (enforced by the layout):

- `@suss/behavioral-ir` — one peer dep on `zod`. Runtime validators (`parseSummaries`, `safeParseSummaries`) and the generated JSON Schema both come from the zod schemas. This is what downstream consumers install.
- `@suss/extractor` — depends only on the IR. Defines `RawCodeStructure` and `PatternPack`. Never imports ts-morph or any compiler API.
- `@suss/adapter-typescript` — depends on IR, extractor, ts-morph. This is the heavyweight package.
- `@suss/framework-*` and `@suss/runtime-*` packs — depend only on `@suss/extractor` (for the `PatternPack` type). They're data, not logic. Runtime packs (e.g., `@suss/runtime-web` for `fetch`) use the same `PatternPack` interface but target built-in APIs rather than third-party frameworks.
- `@suss/stub-*` packages — depend only on the IR (and on each other where they compose: the CloudFormation stub delegates to the OpenAPI and AWS API Gateway stubs). Produce `BehavioralSummary[]` from specs, manifests, or vendor docs; carry `confidence.source: "stub"`. See [`stubs.md`](stubs.md).
- `@suss/checker` — depends only on the IR. Pure function over two `BehavioralSummary` values → `Finding[]`. Knows nothing about extraction, AST, or framework packs — operates on the serialized IR.
- `@suss/cli` — depends on everything; dynamically imports the adapter so CLI startup doesn't pay the ts-morph cost unless extraction actually runs.

## The extraction algorithm

For each code unit, the adapter runs four independently testable steps:

1. **Terminal discovery** — use framework patterns to find all AST nodes that produce observable output.
2. **Ancestor branch collection** — walk upward from each terminal to the function root, recording branching constructs (`if`, `switch`, `try/catch`, ternary, `&&`/`||`).
3. **Early return detection** — scan sibling statements before the terminal; any `if (cond) return` contributes an implicit negative predicate to the terminal.
4. **Condition expression parsing** — decompose each condition AST node into a structured `Predicate`, resolving subjects via the symbol table. Fall back to `opaque` when decomposition fails.

The four functions compose in step 5 (**assembly**): for each terminal, concatenate its early-return conditions + ancestor-branch conditions, pair with the terminal's output data, and produce a `Transition`.

## Why `RawCodeStructure` exists

The adapter produces `RawCodeStructure` (plain data). The extractor consumes it and produces `BehavioralSummary`. You might ask: why not skip the intermediate shape and produce `BehavioralSummary` directly from the adapter?

Three reasons:

1. **Testability.** `assembleSummary(raw)` is a pure function that can be tested with hand-crafted input. No fixtures, no compiler, no files. The extractor test suite runs in <50ms.
2. **Logic centralization.** Gap detection, confidence assessment, predicate normalization, opaque-wrapping, and `expectedInput` pass-through all live in one place. Language adapters don't re-implement them.
3. **Contributor isolation.** A framework pack author never touches adapter code. An adapter bug doesn't affect the extractor. The extractor doesn't care what language the raw structure came from.

The pipeline contract is strict: the adapter fills in `RawCodeStructure` (including `RawBranch.expectedInput` for client call sites), the extractor produces `BehavioralSummary` from it. No post-assembly patching — everything the summary needs must come through `RawCodeStructure`.

## Framework packs are data, not code

A framework pack is a `PatternPack` object describing patterns:

- **Discovery patterns** — how to find code units (`namedExport` for React Router loaders, `registrationCall` for ts-rest handlers, `clientCall` for ts-rest `initClient` / `fetch`, `decorator` for FastAPI, `fileConvention` for Next.js)
- **Terminal patterns** — what counts as output (`returnShape` for `{ status, body }`, `parameterMethodCall` for `res.json()`, `throwExpression` for `throw httpErrorJson(...)`, `returnStatement` for any return in client functions)
- **Binding extraction** — how to derive the HTTP method and path (from a registration call argument, from the filename, from a contract, from a client method name, or as a literal)
- **Contract reading** — if the framework has declared contracts, how to find and read them
- **Input mapping** — how inputs reach the handler (`singleObjectParam`, `positionalParams`, `destructuredObject`) with role annotations

The adapter interprets these patterns against a language's AST. This means adding a new framework with a similar pattern to an existing one (e.g., Fastify after Express) is mostly copy-edit work.

### Known tension: provider-shaped interface carries client patterns

The `PatternPack` interface was designed around provider-side extraction. Client/consumer discovery was added via `clientCall` match and `returnStatement` terminal, which works correctly but creates structural noise:

- `inputMapping` is meaningless for clients (they don't receive framework-structured inputs). Client packs set it to `positionalParams: []`.
- `terminals` for clients is boilerplate — every client pack repeats `returnStatement` + `throwExpression` identically.
- `contractReading` is provider-only but lives at the top level.

This isn't worth refactoring while there are only two client packs (ts-rest, fetch). If a third client pack lands and the boilerplate becomes a pattern, the right move is to split `PatternPack` into `provider` / `client` sub-shapes with sensible defaults for client terminals.

## Degradation strategy

Static analysis of production codebases is always imperfect. suss handles this explicitly rather than pretending it doesn't:

- **Opaque predicates** — when the adapter can't decompose a condition expression, it preserves the source text and marks the predicate `opaque`. Downstream tools see an explicit "we don't know" rather than a fabricated decomposition.
- **Gaps** — cases the code unit doesn't handle (declared-but-not-produced, produced-but-not-declared, uncaught exceptions, fall-through branches) are top-level output, not errors.
- **Confidence levels** (`high` / `medium` / `low`) — computed from the ratio of opaque to structured predicates. A summary with 80% opaque conditions is labeled "low confidence" so consumers can treat it with appropriate skepticism.
- **Graceful dependency resolution** — in-project code gets full extraction; typed external dependencies get type info; untyped ones are opaque. No configuration needed.

## Boundary semantics are HTTP-shaped today

Everything downstream of extraction — the checker, the pairing logic, the pack interfaces, the stubs — currently assumes REST-over-HTTP. The IR types themselves are mostly protocol-agnostic (every `Output` is a typed shape, every `Predicate` operates on `ValueRef`s), but the *cross-boundary* plumbing hardcodes HTTP status codes as the outcome discriminator, response bodies as the payload, and `(method, normalizedPath)` as the pairing key.

This is a known shape and not a design flaw — suss has one concrete boundary semantics today, and designing a protocol-abstraction layer in the abstract (before a second concrete case forces the seams) tends to put the seams in the wrong places. When a second semantics lands (GraphQL is the planned forcing function, because it shares transport with REST but has totally different discriminator / payload / pairing shape), the checker gets refactored around a `BoundarySemantics` interface and `BoundaryBinding` splits into transport / semantics / recognition. See [`boundary-semantics.md`](boundary-semantics.md) for the target shape and the reasoning.

Until then, small decisions that *could* stretch either way default to the shape that makes the eventual refactor cheaper — e.g. HTTP-scoped summary metadata is already namespaced under `metadata.http.*` so future semantics can own sibling namespaces without migration.

## What's deliberately not here

- **A full control flow graph.** suss identifies terminals and their gating conditions. It doesn't build a CFG or do data flow analysis. This is a cost/value tradeoff — a CFG would capture more but costs orders of magnitude more in complexity.
- **Cross-service aggregation.** `@suss/checker` compares two summaries at a time (one provider, one consumer). Aggregating across an organization, tracking boundaries over commits, or alerting on regressions are separate concerns that consume pairwise findings as input. See [`cross-boundary-checking.md`](cross-boundary-checking.md).
- **Runtime tracing.** Everything is static. No instrumentation, no production data.
- **Semantic understanding of dependency calls.** When the extractor sees `await db.findById(id)`, it knows the subject is `"the result of db.findById"`. It doesn't know what Prisma's `findById` actually does. That's fine — cross-boundary comparison only needs subjects to be *stable*, not *semantically understood*.
- **A shared adapter abstraction layer.** The TypeScript adapter contains ~2000 lines of analysis logic (condition parsing, subject resolution, shape extraction, field tracking). A Python adapter would need analogous logic using a different AST library. Some patterns are conceptually language-agnostic ("find all property accesses on a variable within a subtree"), but extracting a shared `@suss/adapter-core` is premature with one adapter. When the second adapter starts, the right move is to extract shared patterns as they emerge from the second implementation, not design them upfront.

## Strategic direction

The checker currently matches transitions by **status code**. The IR was designed for deeper comparison (structured predicates, subject trees, body shapes), and the infrastructure exists (`subjectsMatch`, `predicatesMatch`, `bodyShapesMatch`, `providerCoversConsumerFields`). The near-term priority is wiring that infrastructure into the actual checks — predicate-level transition matching, automatic boundary pairing — so the checker catches the field-level and condition-level mismatches that no existing tool (Pact, OpenAPI diff, type systems) can detect statically.

Language breadth (Python adapter, React components) is valuable but is a *multiplier* on analysis depth. Deeper analysis first, then more languages to multiply the value across polyglot codebases.
