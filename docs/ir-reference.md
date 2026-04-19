# IR Reference

A type-by-type walkthrough of `@suss/behavioral-ir`. The authoritative source is `packages/ir/src/index.ts`; this document explains *why* each type has the shape it does, when to use which variant, and how they compose.

## `BehavioralSummary`

```typescript
interface BehavioralSummary {
  kind: CodeUnitKind;
  location: SourceLocation;
  identity: CodeUnitIdentity;
  inputs: Input[];
  transitions: Transition[];
  gaps: Gap[];
  confidence: ConfidenceInfo;
  metadata?: Record<string, unknown>;
}
```

This is what extraction produces and what downstream tools consume. It's a flat, JSON-serializable structure with no cycles (except for the recursive `ValueRef` and `Predicate` types, which are trees).

**Why `metadata` is an unstructured bag.** Framework-specific information that doesn't fit the universal shape goes here — declared contracts, source file paths relative to the project, framework-specific annotations. Downstream tools can look at it if they care; if they don't, they can ignore it. The core shape stays clean.

**Keys are namespaced by boundary semantics.** HTTP-scoped entries live under `metadata.http.{declaredContract, bodyAccessors, statusAccessors}`. Future semantics (GraphQL, Lambda-invoke, queue messages) would own sibling namespaces (`metadata.graphql.*`, `metadata.lambda.*`). Semantics-neutral keys (e.g. `metadata.derivedFromWrapper` recording wrapper-expansion provenance) stay at the top level. See [`boundary-semantics.md`](boundary-semantics.md).

## `CodeUnitKind`

```typescript
type CodeUnitKind =
  | "handler"    // HTTP request → response
  | "loader"     // React Router / Next.js loader
  | "action"     // React Router / Next.js action (mutation)
  | "component"  // React/Vue/Svelte component
  | "hook"       // Custom React hook
  | "middleware" // Express middleware
  | "resolver"   // GraphQL resolver
  | "consumer"   // Message consumer (Kafka, SQS)
  | "client"     // API client call site (fetch, ts-rest initClient)
  | "worker"     // Background worker, scheduled task
  | "library";   // Function exposed through a package's public export surface
```

The kind determines the behavioral model — specifically, how inputs arrive and what counts as output. Handlers take a request and produce a response. Components take props and state and produce a UI tree. Consumers take a message and produce effects. Clients call an upstream API and branch on the response.

**`consumer` vs `client`.** Both sit on the receiving side of a boundary, but the behavioral model differs. A `consumer` receives a message and produces effects (mutation, emission, delegation). A `client` makes a request, branches on the response status, and reads fields from the response body — the interesting behavior is *what does the client expect the response to look like*, which feeds into cross-boundary body-shape comparison. The distinction matters because the checker applies different rules: client transitions carry `expectedInput` (the body shape the client reads), while consumer transitions carry effects.

**`library`.** Provider side of an in-process `function-call` boundary — a function reached through a package's public export surface. Produced by the `packageExports` discovery variant (see `framework-packs.md`); the resulting binding carries `package` + `exportPath` identity. Distinct from `handler` (no HTTP shape), `component` (no JSX), and `hook` (not a React convention). The consumer counterpart (intra-repo import sites) is planned but not shipped.

**Why it's a closed union.** Open strings would lose type safety. Framework packs can't invent new kinds; if a new framework needs a new kind, it needs an IR update first. This is deliberate — each kind carries assumptions about how the rest of the extraction works, and those assumptions need to be explicit.

## `SourceLocation` and `CodeUnitIdentity`

```typescript
interface SourceLocation {
  file: string;
  range: { start: number; end: number };
  exportName: string | null;  // null for anonymous/inner functions
}

interface CodeUnitIdentity {
  name: string;
  exportPath: string[] | null;  // null for unexported code
  boundaryBinding: BoundaryBinding | null;  // null for unbound code
}
```

Location is file + line range. Identity is symbolic: *what* is this code unit, regardless of *where* it lives. The separation matters for cross-boundary checking — when you refactor `services/api/handlers/users.ts` into `services/api/routes/users/index.ts`, the location changes but the identity (`getUser` handler bound to `GET /users/:id`) stays the same.

**`exportPath` as a string array, not a dotted string.** Deep module namespaces (`namespace.submodule.getUser`) show up in some frameworks; arrays are easier to compare than strings.

**`boundaryBinding` is explicitly nullable.** Utility functions, custom hooks, and internal helpers don't participate in cross-service contracts. They can still have behavioral summaries, but they don't have a boundary to bind to. Explicit `null` forces consumers to handle that case.

## `BoundaryBinding`

```typescript
interface BoundaryBinding {
  protocol: string;            // "http" today; will split when we add a second protocol
  method?: string;             // "GET", "POST", etc. for HTTP
  path?: string;               // "/users/:id" for HTTP
  framework: string;           // "ts-rest", "express", "react-router", "fetch", "axios"
  declaredResponses?: number[];
}
```

Where a code unit connects to the outside world. A REST endpoint is the same boundary whether it's served at `/api/v1/users` or `/api/v2/members` — the *identity* of the boundary is separate from the address. For v0, we use the address as the identity; adding stable boundary IDs is a future concern.

**This shape is HTTP-biased today.** `protocol` is doing the work of both *transport* (wire protocol) and *semantics* (what the participants think they're doing); `framework` is doing the work of recognition (the specific library). `method` / `path` are REST-specific and would be empty for any non-REST boundary even if it's HTTP-transported. When a second boundary semantics lands (GraphQL is the planned forcing function), these fields split into `transport` + `semantics` (a discriminated union) + `recognition`. See [`boundary-semantics.md`](boundary-semantics.md) for the target shape. Until then, the checker, the pairing logic, and the pack interfaces all assume REST semantics.

## `Transition`

```typescript
interface Transition {
  id: string;
  conditions: Predicate[];  // AND-joined; all must hold
  output: Output;
  effects: Effect[];
  location: { start: number; end: number };
  isDefault: boolean;
  confidence?: ConfidenceInfo;
  expectedInput?: TypeShape;
}
```

A transition says: "when all of these conditions hold, this output is produced and these effects occur". A code unit's complete behavior is its set of transitions. Transitions are logically exhaustive — every execution path through the code unit maps to exactly one transition. When the set isn't exhaustive (fall-through to framework defaults, uncaught exceptions), the holes are recorded as `Gap`s.

**`conditions` is a flat AND.** `OR` composition happens inside `Predicate` via the `compound` variant. This keeps transition comparison simple: two transitions have the same precondition iff their condition lists are structurally equal.

**`isDefault`** marks the fall-through transition — the case with no explicit conditions, or only early-return guards. It's the "everything else" case. Most handlers have exactly one default transition; some have none (all paths are explicitly gated) and some have multiple (each returning early from different guards).

**`id` is content-addressable**, not an index. It's generated as `${functionName}:${terminalKind}:${statusKey}:${hash7}`, where `hash7` is the first 7 hex chars of a SHA-1 over the ordered condition chain's canonical source text. This makes `diffSummaries` robust under branch reordering (identities survive) while semantic edits — changing a status code, a condition, or a terminal kind — mint a new ID as expected. Condition order is part of identity because short-circuit semantics make `a && b` and `b && a` observably different. Source-location offsets are deliberately excluded: whitespace shouldn't re-mint IDs.

**`expectedInput`** is populated for `client` transitions. After branching on a response status code, the client function reads fields from the response body — `result.body.name`, `data.users[0].id`, etc. These accesses are collected into a `TypeShape` representing what the client actually expects the upstream response to contain for this status code. The checker compares this against the provider's produced body shape:

```json
{
  "conditions": [{ "type": "comparison", "left": <result.status>, "op": "eq", "right": { "type": "literal", "value": 200 } }],
  "output": { "type": "return", "value": { "type": "record", "properties": { "name": { "type": "text" } } } },
  "expectedInput": {
    "type": "record",
    "properties": {
      "name": { "type": "text" },
      "email": { "type": "text" }
    }
  }
}
```

Here the client reads `body.name` and `body.email` — if the provider's `200` transition returns a body without `email`, the checker flags a mismatch. `expectedInput` is absent on provider transitions and on client transitions where field tracking couldn't resolve the accesses.

## `Predicate`

```typescript
type Predicate =
  | { type: "nullCheck"; subject: ValueRef; negated: boolean }
  | { type: "truthinessCheck"; subject: ValueRef; negated: boolean }
  | { type: "comparison"; left: ValueRef; op: ComparisonOp; right: ValueRef }
  | { type: "typeCheck"; subject: ValueRef; expectedType: string }
  | { type: "propertyExists"; subject: ValueRef; property: string; negated: boolean }
  | { type: "compound"; op: "and" | "or"; operands: Predicate[] }
  | { type: "negation"; operand: Predicate }
  | { type: "call"; callee: string; args: ValueRef[] }
  | { type: "opaque"; sourceText: string; reason: OpaqueReason };
```

Conditions that gate transitions. A discriminated union over test types, where each variant carries exactly the fields it needs — no optional bag of fields.

**`truthinessCheck` vs. `nullCheck`.** JavaScript's `if (x)` tests truthiness, which is *not* the same as `x != null` — `0`, `""`, and `false` are also falsy. These are kept separate because cross-boundary reasoning about them is different: a nullness check is about the *value's existence*; a truthiness check is about its usefulness. Conflating them would cause false matches.

**`compound` vs. `negation` as separate variants.** `compound` handles `and` and `or` but not `not`, because `not` of a `not` collapses to the operand. Keeping `negation` separate makes simplification rewrites easy.

**`opaque` is an explicit variant, not an error.** When the extractor can't decompose a condition expression, it wraps it in an opaque predicate that preserves the source text and records why. Downstream tools get the message "this branch exists but we don't know exactly what gates it" and can decide how to handle it.

**Why no `allof`/`anyof` with n-ary arrays directly.** `compound` already does that. Keeping one n-ary form (via the `operands` array) rather than adding separate binary and n-ary variants reduces the surface area.

## `ValueRef`

```typescript
type ValueRef =
  | { type: "input"; inputRef: string; path: string[] }
  | { type: "dependency"; name: string; accessChain: string[] }
  | { type: "derived"; from: ValueRef; derivation: Derivation }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "state"; name: string }
  | { type: "unresolved"; sourceText: string };
```

A reference to a value within a code unit. Each variant identifies where the value *came from* — its origin — without trying to understand its semantics.

**`input`** — the value is a function parameter. `inputRef` is the parameter name; `path` is the property chain from the parameter to the tested value (`args.params.id` → `{ inputRef: "args", path: ["params", "id"] }`).

**`dependency`** — the value is the return value of a call. `name` is the callee expression text (e.g., `"db.findById"`, `"prisma.containerV2.findUnique"`), `accessChain` is any property access before the value is tested.

**`derived`** — a composed reference. `from` is a parent `ValueRef`, `derivation` is how this reference was produced (property access, method call, destructured field, awaited, indexed). `derived` lets `ValueRef` form a tree — `container.repository.lastAnalyzedCommitHash` is a `derived` of a `derived` of a `dependency`.

**`literal`** — a literal value, typically the right-hand side of a comparison.

**`state`** — a value from component state, closure variable, or module-level variable. Used for React hooks and components.

**`unresolved`** — the extractor couldn't determine the origin. The source text is preserved so the opaque fallback still shows *what* was tested, even if we don't know *where it came from*.

**Why the shape is shallow.** The goal is cross-boundary comparison, not full semantic understanding. Two predicates that both test `the result of db.findById(id).deletedAt` should be recognizable as referring to the same subject — even if the extractor has no idea what `findById` does semantically. Shallow references are:

1. **Stable** — mechanical renames don't change them
2. **Cheap to compute** — no type inference, no deep following of calls
3. **Language-agnostic** — Python's `db.find_by_id(id)` produces an analogous `ValueRef`

## `Output`

```typescript
type Output =
  | { type: "response"; statusCode: ValueRef | null; body: TypeShape | null;
      headers: Record<string, ValueRef> }
  | { type: "throw"; exceptionType: string | null; message: string | null }
  | { type: "render"; component: string; props?: Record<string, unknown> }
  | { type: "return"; value: TypeShape | null }
  | { type: "delegate"; to: string }
  | { type: "emit"; event: string; payload?: TypeShape }
  | { type: "void" };
```

What terminals produce — the universal set of output shapes. The framework pack determines which variants matter; the output type itself is framework-agnostic.

**`response`** — an HTTP response. `statusCode` is a `ValueRef` (not a raw number) because it might be a dynamic value (`res.status(code).json(...)`). A literal 200 comes through as `{ type: "literal", value: 200 }`. This is a recent fix — earlier versions used `number | null` and lost the ability to represent dynamic codes.

**`throw`** — an exception. `exceptionType` is the constructor expression text (e.g., `"HttpError.NotFound"`, `"new Error(...)"`). Not the actual JavaScript class — we can't resolve that statically in general.

**`render`** — a component render result. Used for React components, Vue render functions, etc.

**`return`** — a plain return value. `value` is a `TypeShape` because for functions like hooks and utilities, the shape is the contract.

**`delegate`** — passing control to the next middleware or handler. `to` is a symbolic name (e.g., `"next"`, `"fallthrough"`).

**`emit`** — producing an event or message on a channel. For Kafka producers, EventBridge dispatchers, etc.

**`void`** — explicit void return or fall-through with no observable output.

## `TypeShape`

```typescript
type TypeShape =
  | {
      type: "record";
      properties: Record<string, TypeShape>;
      spreads?: Array<{ sourceText: string }>;
    }
  | { type: "dictionary"; values: TypeShape }
  | { type: "array"; items: TypeShape }
  | { type: "literal"; value: string | number | boolean; raw?: string }
  | { type: "text" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "undefined" }
  | { type: "union"; variants: TypeShape[] }
  | { type: "ref"; name: string }
  | { type: "unknown" };
```

A simplified type shape, sufficient for describing response bodies and return values without trying to reproduce the full TypeScript or Python type system. `ref` is an escape hatch — "the extractor knows this is typed as `User` but doesn't inline the definition".

**Record vs. dictionary.** `record` is a *closed struct*: a fixed set of named fields known statically. `dictionary` is an *index-signature* type (`Record<string, T>`, `{ [key: string]: T }`): the key set is open, every access returns a `T`. Consumers comparing two shapes must keep these distinct — a dictionary accepts any key, a record accepts only the listed ones.

**Why not reuse the TypeScript type system directly.** `TypeShape` is language-agnostic. A Python adapter produces the same shape. Serializing actual compiler types would leak compiler-specific details and make cross-language comparison impossible.

### Serialization semantics

`TypeShape` describes values **as they cross a serialization boundary** — HTTP response bodies, messages on a queue, return values inspected by a caller. This is not the in-memory type system of the source language. Two consequences fall out of that:

1. **Numeric precision.** JavaScript's `number` is IEEE 754 double. Integers beyond `Number.MAX_SAFE_INTEGER` (2^53 − 1), high-precision decimals, hex / scientific notation, and underscore separators all lose information through `number` coercion. For numeric `literal` shapes, the `raw` field carries the exact source text so a consumer needing precision or faithful wire representation never has to re-parse or guess. Strings and booleans roundtrip losslessly and have no `raw`.

2. **Types without a native wire form.** `BigInt`, `Date`, `Map`, `Set`, `Buffer`, `Error`, regexes, etc. have no canonical JSON representation. The extractor surfaces them as `ref` with the declared type name (`"bigint"`, `"Date"`, …) rather than inventing a structural expansion. The wire format for these is **consumer-defined**: a `Date` may be serialized as an ISO 8601 string by `toJSON`, as an epoch number, or not at all — that contract lives between the producer and consumer, not in the IR.

#### `undefined` on the wire

`undefined` is modeled for source fidelity (optional fields, explicit `undefined` returns), but JSON omits it. A record with `email: undefined` serializes to a response body where `email` is absent. Downstream contract checkers should treat `{ value: T | undefined }` and `{ value?: T }` as equivalent at the wire boundary.

#### Serde / codec contracts (open design space)

The IR captures *what* data flows — not the codec that produced it. Two producers emitting a `Date` may put ISO strings, epoch numbers, or `{seconds, nanos}` records on the wire, and the IR can only say "some Date-shaped thing was referenced." This is deliberate for v0: codec contracts are a separate concern from shape contracts. A future direction is an explicit serde variant such as `{ type: "serialized"; wire: TypeShape; reconstructs: TypeShape }` so that cross-boundary tooling can reason about "the producer writes ISO string, the consumer expects Date — is that compatible?" without baking a specific codec into every producer's shape. For now, producers and consumers must agree on a codec out of band, and the IR treats `ref` values as opaque beyond the name.

## `Effect`

```typescript
type Effect =
  | { type: "mutation"; target: string; operation: "create" | "update" | "delete" }
  | { type: "invocation"; callee: string; args: unknown[]; async: boolean }
  | { type: "emission"; event: string; payload?: unknown }
  | { type: "stateChange"; variable: string; newValue?: unknown };
```

Side effects observed within a transition. For v0, effects are recorded but not deeply analyzed — the presence of a database mutation is noted, but we don't model what it mutates. Downstream tools can use the effect list for impact analysis ("this PR changes a handler that writes to `users`; here are consumers of `users`").

Effect tracking is deliberately shallow in v0. Full effect analysis (who reads what, transaction boundaries, eventual consistency) is a future concern.

## `Input`

```typescript
type Input =
  | { type: "parameter"; name: string; position: number; role: string; shape: TypeShape | null }
  | { type: "injection"; name: string; mechanism: string; shape: TypeShape | null }
  | { type: "hookReturn"; hook: string; destructuredFields: string[] }
  | { type: "contextValue"; context: string; accessedFields: string[] }
  | { type: "closure"; name: string };
```

How inputs reach a code unit. Most of these are for React/Vue components; HTTP handlers typically only have `parameter` inputs. The `role` field on parameters carries framework-specific meaning (`"request"`, `"response"`, `"pathParams"`, `"requestBody"`, etc.) — it's what `InputMappingPattern` in the framework pack sets.

**`hookReturn`, `contextValue`, `closure`** are for components and hooks. A hook call like `const [user, setUser] = useUser()` produces a `hookReturn` input with `destructuredFields: ["user", "setUser"]`. The full React component support isn't implemented yet — Phase 2 will start building toward it.

## `Gap`

```typescript
interface Gap {
  type: "unhandledCase";
  conditions: Predicate[];
  consequence: "frameworkDefault" | "implicitThrow" | "fallthrough" | "unknown";
  description: string;
}
```

A case the code unit doesn't explicitly handle. Gaps are top-level output, not errors — "I can see that this case exists but I can't determine what happens" is useful information for downstream tools.

**`consequence`** tells you what actually happens in the unhandled case:

- **`frameworkDefault`** — the framework will produce a default (e.g., Express will serve a 500 error page)
- **`implicitThrow`** — an unhandled rejection will propagate up
- **`fallthrough`** — control passes to the next middleware / handler
- **`unknown`** — the extractor can't determine the consequence

The extractor populates `gaps` in two scenarios today: (1) a declared contract response that the handler never produces, and (2) a produced status code that isn't in the declared contract. Phase 2 will add more: uncaught exceptions, branch paths with no terminal, fall-through from switch.

## `ConfidenceInfo`

```typescript
interface ConfidenceInfo {
  source: "inferred_static" | "inferred_ai" | "declared" | "stub";
  level: "high" | "medium" | "low";
}
```

How much of the behavior was structurally analyzed vs. opaque, and where the information came from.

- **`inferred_static`** — structural analysis of the source code (the common case)
- **`inferred_ai`** — future: LLM-assisted semantic labels on opaque predicates
- **`declared`** — the summary was authored, not extracted (e.g., for community stubs)
- **`stub`** — a placeholder with no extracted information

Level is computed as the ratio of opaque predicates to total predicates:

- `ratio == 0` → `high`
- `ratio < 0.5` → `medium`
- `ratio >= 0.5` → `low`

Consumers use confidence to decide how strictly to enforce findings. High-confidence provider/consumer mismatches are almost certainly user-visible bugs. Low-confidence ones might be false positives from opaque predicates; they deserve review but not a broken build.

## `Finding`

```typescript
type FindingKind =
  | "unhandledProviderCase"
  | "deadConsumerBranch"
  | "providerContractViolation"
  | "consumerContractViolation"
  | "lowConfidence";

type FindingSeverity = "error" | "warning" | "info";

interface FindingSide {
  summary: string;         // stable identifier, e.g., "src/handlers/users.ts::getUser"
  transitionId?: string;   // omitted when the finding isn't tied to a single transition
  location: SourceLocation;
}

interface Finding {
  kind: FindingKind;
  boundary: BoundaryBinding;
  provider: FindingSide;
  consumer: FindingSide;
  description: string;
  severity: FindingSeverity;
}
```

What the pairwise checker emits. Each finding names the boundary, both sides of it, and a human-readable description. The full algorithm and each finding kind live in [`cross-boundary-checking.md`](cross-boundary-checking.md); this section covers the type surface.

**Why both sides are always named.** Even when only one side is at fault (e.g., `providerContractViolation` is structurally about provider-vs-contract), the finding still points at the consumer summary it was checked against — so tooling can attribute the finding to a specific pairing rather than a free-floating provider. `transitionId` is the optional field; the two `summary` references are required.

**Why findings live in `@suss/behavioral-ir`, not in the checker package.** Other tools (diff viewers, aggregation layers, the product) consume findings the same way they consume summaries. Keeping the shape in the IR package means no downstream consumer depends on `@suss/checker` only to read a finding.

**Severity drives CLI exit codes.** `suss check` exits non-zero when any `error`-severity finding is present; `warning` and `info` are reported but don't fail the process. Contract violations and unhandled provider cases are errors; dead consumer branches are warnings; `lowConfidence` is informational.

## `RawCodeStructure`

The adapter-to-extractor interface. Defined in `@suss/extractor`, not `@suss/behavioral-ir`, because it's an implementation boundary inside the pipeline rather than part of the public output.

```typescript
interface RawCodeStructure {
  identity: { name; kind; file; range; exportName; exportPath }
  boundaryBinding: { protocol; method; path; framework } | null;
  parameters: RawParameter[];
  branches: RawBranch[];
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
}

interface RawBranch {
  conditions: RawCondition[];
  terminal: RawTerminal;
  effects: RawEffect[];
  location: { start: number; end: number };
  isDefault: boolean;
  expectedInput?: TypeShape | null;
}
```

Every field is plain JSON — no AST nodes, no compiler types. An adapter's job is to read source code and produce this shape; the extractor's job is to turn this shape into a `BehavioralSummary`.

**`RawBranch.expectedInput`** is populated by the adapter for client code units. After branching on a response status code, the consumer accesses fields on the response body — the adapter traces those accesses and builds a `TypeShape`. The extractor copies `expectedInput` through to `Transition.expectedInput` during assembly. This ensures the pipeline contract is preserved: everything the summary needs comes through `RawCodeStructure`, no post-assembly patching.

This split exists for three reasons:

1. **The extractor can be tested without a compiler.** Hand-written `RawCodeStructure` values drive the whole test suite in milliseconds.
2. **Logic lives in one place.** Opaque wrapping, gap detection, confidence assessment, `expectedInput` pass-through, and the final `BehavioralSummary` shape are all decided in the extractor. Adapters don't re-implement them.
3. **Adding a language is adding an adapter.** A Python adapter produces the same `RawCodeStructure`; the extractor doesn't know or care which compiler filled it in. Client field tracking works automatically for any adapter that populates `RawBranch.expectedInput`.

See `docs/extraction-algorithm.md` for how the TypeScript adapter produces `RawCodeStructure` from source files.
