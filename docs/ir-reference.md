# IR Reference

A type-by-type walkthrough of `@suss/behavioral-ir`. The authoritative source is `packages/ir/src/index.ts`; this document explains *why* each type has the shape it does, when to use which variant, and how they compose.

## `BehavioralSummary` — the top-level output

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
  | "worker";    // Background worker, scheduled task
```

The kind determines the behavioral model — specifically, how inputs arrive and what counts as output. Handlers take a request and produce a response. Components take props and state and produce a UI tree. Consumers take a message and produce effects.

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

**`boundaryBinding` is first-class nullable.** Utility functions, custom hooks, and internal helpers don't participate in cross-service contracts. They can still have behavioral summaries, but they don't have a boundary to bind to. Explicit `null` forces consumers to handle that case.

## `BoundaryBinding`

```typescript
interface BoundaryBinding {
  protocol: string;            // "http", "grpc", "graphql", "event", "invoke"
  method?: string;             // "GET", "POST", etc. for HTTP
  path?: string;               // "/users/:id" for HTTP
  framework: string;           // "ts-rest", "express", "react-router"
  declaredResponses?: number[];
}
```

Where a code unit connects to the outside world. A REST endpoint is the same boundary whether it's served at `/api/v1/users` or `/api/v2/members` — the *identity* of the boundary is separate from the address. For v0, we use the address as the identity; adding stable boundary IDs is a future concern.

## `Transition` — the atomic unit of behavior

```typescript
interface Transition {
  id: string;
  conditions: Predicate[];  // AND-joined; all must hold
  output: Output;
  effects: Effect[];
  location: { start: number; end: number };
  isDefault: boolean;
  confidence?: ConfidenceInfo;
}
```

A transition says: "when all of these conditions hold, this output is produced and these effects occur". A code unit's complete behavior is its set of transitions. Transitions are logically exhaustive — every execution path through the code unit maps to exactly one transition. When the set isn't exhaustive (fall-through to framework defaults, uncaught exceptions), the holes are recorded as `Gap`s.

**`conditions` is a flat AND.** `OR` composition happens inside `Predicate` via the `compound` variant. This keeps transition comparison simple: two transitions have the same precondition iff their condition lists are structurally equal.

**`isDefault`** marks the fall-through transition — the case with no explicit conditions, or only early-return guards. It's the "everything else" case. Most handlers have exactly one default transition; some have none (all paths are explicitly gated) and some have multiple (each returning early from different guards).

**`id` is a string**, not an incremental number. Right now IDs are generated as `${functionName}:${index}`, but this is known-fragile (inserting a transition in the middle shifts all later IDs and breaks `diffSummaries`). Phase 2 will revisit this with content-based IDs once we have real extraction data.

## `Predicate` — conditions that gate transitions

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

A discriminated union over test types. Each variant carries exactly the fields it needs — no optional bag of fields.

**`truthinessCheck` vs. `nullCheck`.** JavaScript's `if (x)` tests truthiness, which is *not* the same as `x != null` — `0`, `""`, and `false` are also falsy. These are kept separate because cross-boundary reasoning about them is different: a nullness check is about the *value's existence*; a truthiness check is about its usefulness. Conflating them would cause false matches.

**`compound` vs. `negation` as separate variants.** `compound` handles `and` and `or` but not `not`, because `not` of a `not` collapses to the operand. Keeping `negation` separate makes simplification rewrites easy.

**`opaque` is first-class, not an error.** When the extractor can't decompose a condition expression, it wraps it in an opaque predicate that preserves the source text and records why. Downstream tools get the message "this branch exists but we don't know exactly what gates it" and can decide how to handle it.

**Why no `allof`/`anyof` with n-ary arrays directly.** `compound` already does that. Keeping one n-ary form (via the `operands` array) rather than adding separate binary and n-ary variants reduces the surface area.

## `ValueRef` — references to values

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

1. **Stable** — trivial renames don't change them
2. **Cheap to compute** — no type inference, no deep following of calls
3. **Language-agnostic** — Python's `db.find_by_id(id)` produces an analogous `ValueRef`

## `Output` — what terminals produce

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

The universal set of output shapes. The framework pack determines which variants matter; the output type itself is framework-agnostic.

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
  | { type: "record"; properties: Record<string, TypeShape> }
  | { type: "array"; items: TypeShape }
  | { type: "text" }
  | { type: "integer" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "union"; variants: TypeShape[] }
  | { type: "ref"; name: string }
  | { type: "unknown" };
```

A simplified type shape, sufficient for describing response bodies and return values without trying to reproduce the full TypeScript or Python type system. `ref` is an escape hatch — "the extractor knows this is typed as `User` but doesn't inline the definition".

**Why not reuse the TypeScript type system directly.** `TypeShape` is language-agnostic. A Python adapter produces the same shape. Serializing actual compiler types would leak compiler-specific details and make cross-language comparison impossible.

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

A case the code unit doesn't explicitly handle. Gaps are first-class output, not errors — "I can see that this case exists but I can't determine what happens" is useful information for downstream tools.

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
- **`stub`** — a placeholder with no real information

Level is computed as the ratio of opaque predicates to total predicates:

- `ratio == 0` → `high`
- `ratio < 0.5` → `medium`
- `ratio >= 0.5` → `low`

Consumers use confidence to decide how strictly to enforce findings. High-confidence provider/consumer mismatches are almost certainly real bugs. Low-confidence ones might be false positives from opaque predicates; they deserve review but not a broken build.

## `RawCodeStructure` — the adapter-to-extractor interface

Defined in `@suss/extractor`, not `@suss/behavioral-ir`, because it's an implementation boundary inside the pipeline rather than part of the public output.

```typescript
interface RawCodeStructure {
  identity: { name; kind; file; range; exportName; exportPath }
  boundaryBinding: { protocol; method; path; framework } | null;
  parameters: RawParameter[];
  branches: RawBranch[];
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
}
```

Every field is plain JSON — no AST nodes, no compiler types. An adapter's job is to read source code and produce this shape; the extractor's job is to turn this shape into a `BehavioralSummary`.

This split exists for three reasons:

1. **The extractor can be tested without a compiler.** Hand-written `RawCodeStructure` values drive the whole test suite in milliseconds.
2. **Logic lives in one place.** Opaque wrapping, gap detection, confidence assessment, and the final `BehavioralSummary` shape are all decided in the extractor. Adapters don't re-implement them.
3. **Adding a language is adding an adapter.** A Python adapter produces the same `RawCodeStructure`; the extractor doesn't know or care which compiler filled it in.

See `docs/extraction-algorithm.md` for how the TypeScript adapter produces `RawCodeStructure` from source files.
