---
title: IR types
description: Every type in the behavioral IR, field by field, grouped by what it describes.
---

# IR types

The types below come from two packages. `@suss/behavioral-ir` owns the summary, the transition and the finding; `@suss/ir-core` owns the primitives every suss IR shares, which are the boundary binding, the type shape, the source location and the confidence block. Both are generated from zod schemas, and the JSON Schema the package publishes is generated from those at build time.

Install `@suss/behavioral-ir` (one peer dependency on `zod`) and call `parseSummaries(json)` to validate and narrow in one step, or `safeParseSummaries(json)` to handle errors without throwing. From another language, validate against the published [`behavioral-summary.schema.json`](https://github.com/nimbuscloud-ai/suss/blob/main/packages/behavioral-ir/schema/behavioral-summary.schema.json).

## The summary

### `BehavioralSummary`

```typescript
interface BehavioralSummary {
  schemaVersion?: number;
  kind: CodeUnitKind;
  location: SourceLocation;
  identity: CodeUnitIdentity;
  inputs: Input[];
  transitions: Transition[];
  gaps: Gap[];
  confidence: ConfidenceInfo;
  definitions?: Record<string, TypeShape>;
  inputReads?: Array<{ input: string; path: string[] }>;
  metadata?: Record<string, unknown>;
}
```

One of these per code unit. It is flat JSON with no cycles, apart from the recursive `ValueRef`, `Predicate`, `TypeShape` and `RenderNode` trees.

- **`schemaVersion`** is absent on a summary written by 0.3.x, which the parsers read as version 1. Version 6 is current. [Summary format](/reference/summary-format#versions) lists what each version changed.
- **`definitions`** is the table a `ref` shape points into, keyed the way `typeDefinitionKey` in `@suss/ir-core` builds a key. `withDefinitionsInlined` puts a definition back into a shape, which is what every comparison reads.
- **`inputReads`** records what the unit read out of the values it was given, once each, as an input name and a property path.
- **`metadata`** takes framework-specific data that does not fit the universal structure. Keys are namespaced by boundary semantics: HTTP-scoped entries go under `metadata.http.*`, GraphQL under `metadata.graphql.*`. Semantics-neutral keys such as `metadata.derivedFromWrapper` stay at the top level. A tool that does not need any of it can ignore the field.

### `CodeUnitKind`

```typescript
type CodeUnitKind =
  | "handler"             // HTTP request to response
  | "loader"              // React Router / Next.js loader
  | "action"              // React Router / Next.js action
  | "component"           // React / Vue / Svelte component
  | "hook"                // custom React hook
  | "middleware"          // Express middleware
  | "resolver"            // GraphQL resolver
  | "consumer"            // message consumer
  | "client"              // API client call site
  | "worker"              // background worker, scheduled task
  | "library"             // function reachable through a package's exports
  | "caller"              // function that calls into another package's exports
  | "module-init"         // what a module does when it is first imported
  | "scheduled-callback"; // a function handed to setTimeout or a library hook
```

The kind decides how inputs arrive and what counts as output. A handler takes a request and produces a response. A component takes props and state and produces a UI tree. A consumer takes a message and produces effects.

**`consumer` against `client`.** Both are downstream of a boundary and their models differ. A consumer receives a message and produces effects. A client makes a request, branches on the response status and reads fields off the body, so its transitions carry `expectedInput` and a consumer's carry effects. The checker applies different rules to each.

**`library` and `caller`** are the two sides of an in-process `function-call` boundary. The `packageExports` discovery variant produces the `library` side, one per function reachable through the package's `package.json` entry points. The `packageImport` variant produces the `caller` side, one per (enclosing function, consumed binding). They pair by `fn:<package>::<exportPath>`.

**`module-init`** is what a source file does at import time, one per file, and it is always a consumer: it reads channels other units declare. **`scheduled-callback`** is a function the runtime calls later rather than a request, so what it reaches is recorded on it rather than on the unit that scheduled it.

The union is closed. A pack cannot invent a kind, because each kind comes with assumptions the rest of extraction makes, and a new framework that needs a new kind needs an IR change first.

### `SourceLocation` and `CodeUnitIdentity`

```typescript
interface SourceLocation {
  file: string;
  range: { start: number; end: number };  // line numbers, for a person
  span?: { start: number; end: number };  // character offsets, for joins
  exportName: string | null;              // null for an anonymous function
  workspace?: string;
}

interface CodeUnitIdentity {
  id?: string;
  name: string;
  nameKind?: "binding" | "label";
  exportPath: string[] | null;            // null for unexported code
  boundaryBinding: BoundaryBinding | null;// null for unbound code
  deployableUnit?: DeployableUnit;
}

interface DeployableUnit {
  deploymentTarget: "lambda" | "ecs-task" | "container" | "k8s-deployment" | "worker";
  instanceName: string;
}
```

Location says where the code is. Identity says what it is, whatever file it moves to. Move `services/api/handlers/users.ts` to `services/api/routes/users/index.ts` and the location changes while the identity, a `getUser` handler bound to `GET /users/:id`, stays.

- **`range` and `span`.** The line range is for a reader and an editor link. The character span is what identity and joins measure with, because two functions can share a line and never an offset range. A summary no source position backs, one read from a contract artifact, has no `span`.
- **`workspace`** is what the project points at calls itself. Paths are relative to wherever the extract ran, so two services in one repository both report `src/handlers.ts`, and this is what tells them apart when their summaries are merged.
- **`id`** is workspace, file and export path together. Names alone collide by the hundreds.
- **`nameKind`** says where the name came from. `"binding"` means other code can call the unit by it. `"label"` means discovery coined it, and a label is never used as a binding.
- **`exportPath`** is an array rather than a dotted string, because deep module namespaces (`namespace.submodule.getUser`) turn up in some frameworks and arrays are easier to compare.
- **`boundaryBinding`** is nullable on purpose. A utility function or an internal helper takes part in no contract. An explicit `null` makes a consumer handle that case.
- **`deployableUnit`** says what runs this code, when the pack knows: the Lambda's logical id from a SAM template, the container or deployment name elsewhere. The checker joins on it. Several Lambdas can subscribe to one channel with a handler each, and the channel alone does not say which handler runs where. It is optional rather than nullable, because a React component or a library export is never deployed on its own and has nothing to say here.

## Boundaries

### `BoundaryBinding`

```typescript
interface BoundaryBinding {
  transport: string;    // the wire: "http", "aws_sqs", "in-process", "os"
  semantics: Semantics; // the pairing rule, discriminated on `name`
  recognition: string;  // which pack matched, or "reachable"
}
```

`recognition: "reachable"` marks a unit found through the transitive closure of a unit a pack recognised, rather than by a pack pattern of its own. Such a unit has no pairing identity, so nothing cross-checks it, and its transitions and effects are extracted in full.

Each protocol is one module under `packages/ir-core/src/semantics`, carrying its own schema, its pairing key and its agreement rule:

```typescript
type Semantics =
  | { name: "rest"; method: string | null; path: string | null;
      declaredResponses?: number[] }
  | { name: "function-call"; module?: string; exportName?: string;
      package?: string; exportPath?: string[] }
  | { name: "graphql-resolver"; typeName: string | null; fieldName: string }
  | { name: "graphql-operation"; operationName?: string;
      operationType: "query" | "mutation" | "subscription" }
  | { name: "runtime-config"; deploymentTarget: string; instanceName: string }
  | { name: "storage"; storageSystem: string; scope: string;
      container: string | null; accessPath: string | null }
  | { name: "message-bus"; messageBus: MessageBus; channel: string | null }
  | { name: "metric"; metricSystem: string; metricType: string | null }
  | { name: "unit-invocation"; deploymentTarget: string;
      instanceName: string | null };

type MessageBus =
  | "aws_sqs" | "aws.sns" | "s3" | "eventbridge" | "bullmq"
  | "kafka" | "nats"
  | "cloudflare-queues" | "cloudflare-cron" | "cloudflare-tail";
```

An identity field is null when the source does not say what it is. The empty string is invalid there, because one empty string agrees with every other. REST's `method` also takes `"*"`, for a handler that serves every method, and it pairs with whatever method each consumer uses.

`runtime-config` and `unit-invocation` both take their two fields from `DeployableUnit`, because the pairing key is exactly a deployed unit: one thing deployed, two boundaries on it. `unit-invocation` makes `instanceName` nullable, since only the provider always knows the name.

Storage's `container` and `accessPath` use the boundary-name syntax: a literal (`orders-v1`), a pattern with deploy-time holes (`{stage}-orders-v1`), or a reference saying where to go and ask (`{ORDER_TABLE}`). The braces alone say which. `parseBoundaryName` in `@suss/ir-core` is the one reader of that syntax, and the package's README covers the three forms. A REST `path` also uses braces, and a route parameter stops at the `/` between segments, so the two conventions stay apart.

[Boundary semantics](/theory/boundary-semantics) covers each variant's pairing rule and the builder helpers packs use.

## Behavior

### `Transition`

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
  metadata?: Record<string, unknown>;
}
```

One transition says: when all of these conditions hold, this output comes out and these effects fire. A unit's behavior is its set of transitions, and every execution path through the unit maps to exactly one of them. Where the set is not exhaustive, the hole is recorded as a `Gap`.

- **`conditions` is a flat AND.** `OR` composition happens inside a `Predicate`, through the `compound` variant. Two transitions then have the same precondition when their condition lists are structurally equal, with nothing else to work out.
- **`isDefault`** marks the fall-through case, the one with no explicit conditions or only early-return guards. Most handlers have one. Some have none, because every path is gated, and some have several, one per early return.
- **`id` is content-addressed**, not an index. It reads `${functionName}:${terminalKind}:${statusKey}:${hash7}`, where the hash is the first seven hex characters of a SHA-1 over the ordered condition chain's canonical source text. `diffSummaries` then survives branch reordering, while changing a status, a condition or a terminal kind mints a new id. Condition order is part of the identity, because short-circuit evaluation makes `a && b` and `b && a` behave differently. Source offsets are left out, so reformatting does not re-mint ids.
- **`expectedInput`** is set on `client` transitions. After branching on a status the client reads fields off the body, `result.body.name` and the like, and those reads are collected into a `TypeShape` saying what this client expects for this status. The checker compares it against the provider's body:

```json
{
  "conditions": [{ "type": "comparison", "left": { "...": "result.status" },
                   "op": "eq", "right": { "type": "literal", "value": 200 } }],
  "output": { "type": "return", "value": { "type": "record",
              "properties": { "name": { "type": "text" } } } },
  "expectedInput": {
    "type": "record",
    "properties": {
      "name": { "type": "text" },
      "email": { "type": "text" }
    }
  }
}
```

  The client reads `body.name` and `body.email`, so a provider `200` without `email` is a mismatch. The field is absent on provider transitions, and on client transitions where the field tracking could not resolve the accesses.

### `Predicate`

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

type ComparisonOp = "eq" | "neq" | "gt" | "gte" | "lt" | "lte";

type OpaqueReason =
  | "complexExpression" | "externalFunction"
  | "dynamicValue" | "unsupportedSyntax";
```

Each variant has exactly the fields it needs.

- **`truthinessCheck` against `nullCheck`.** JavaScript's `if (x)` tests truthiness, which is not the same test as `x != null`: `0`, `""` and `false` are falsy too. A nullness check asks whether the value exists and a truthiness check asks whether it is useful, so conflating them would match two conditions that are not the same.
- **`compound` against `negation`.** `compound` covers `and` and `or` but not `not`, because a `not` of a `not` collapses to the operand and keeping negation separate makes that rewrite easy. There is one n-ary form rather than a binary variant beside an n-ary one.
- **`opaque` is a variant, not an error.** When the extractor cannot take a condition apart, it keeps the source text and records why. A downstream tool then knows the branch exists and decides for itself how to treat it.

### `Output`

```typescript
type Output =
  | { type: "response"; statusCode: ValueRef | null; body: TypeShape | null;
      headers: Record<string, ValueRef> }
  | { type: "throw"; exceptionType: string | null; message: string | null }
  | { type: "render"; component: string; props?: Record<string, unknown>;
      root?: RenderNode }
  | { type: "return"; value: TypeShape | null }
  | { type: "delegate"; to: string }
  | { type: "emit"; event: string; payload?: TypeShape }
  | { type: "void" };
```

What a terminal produces. The pack decides which variants matter for its framework; the union itself is framework-agnostic.

- **`response`** is an HTTP response. `statusCode` is a `ValueRef` rather than a number because it can be dynamic (`res.status(code).json(...)`). A literal 200 arrives as `{ "type": "literal", "value": 200 }`.
- **`throw`** keeps the constructor expression as text (`"HttpError.NotFound"`), because the class itself cannot be resolved statically in general.
- **`render`** is a component render result. `component` is the root element's name. `root` is the whole tree, filled in by packs that understand their language's render form, so a checker can compare structural output against a contract source such as a Storybook story.
- **`return`** is a plain return. `value` is a `TypeShape`, because for a hook or a utility the shape is the contract.
- **`delegate`** passes control on, to the next middleware or handler. `to` is a symbolic name such as `"next"`.
- **`emit`** puts an event or a message on a channel.
- **`void`** is an explicit void return, or a fall-through producing nothing observable.

### `RenderNode`

```typescript
type RenderNode =
  | { type: "element"; tag: string; attrs?: Record<string, string>;
      target?: { file: string; name: string }; children: RenderNode[] }
  | { type: "text"; value: string }
  | { type: "expression"; sourceText: string }
  | { type: "conditional"; condition: string;
      whenTrue: RenderNode; whenFalse: RenderNode | null };
```

The tree under `Output.render.root`. `attrs` gives attribute values as source text, quotes included, and a boolean shorthand such as `<input disabled>` maps to the empty string. `target` says where the tag's component is declared when the walk resolved it, by the file and name that child's summary is keyed on, so a checker can join this render edge to that summary; a host tag leaves it unset. On a `conditional`, a null `whenFalse` covers both `{cond && <X/>}` and an else written as `null`, since React renders nothing either way.

### `Effect`

```typescript
type Effect =
  | { type: "mutation"; target: string; operation: "create" | "update" | "delete" }
  | { type: "invocation"; callee: string; args: unknown[]; async: boolean;
      summary?: string; declaredAt?: DeclarationPlace;
      argsDeclaredAt?: Record<string, DeclarationPlace>;
      argsSummary?: Record<string, string>;
      calleeParameter?: number;
      preconditions?: Predicate[] }
  | { type: "emission"; event: string; payload?: unknown }
  | { type: "stateChange"; variable: string; newValue?: unknown }
  | { type: "interaction"; binding: BoundaryBinding; callee?: string;
      groupId?: string; preconditions?: Predicate[];
      interaction: Interaction };

interface DeclarationPlace {
  file: string;
  span: { start: number; end: number };
}
```

What a transition does besides producing a value. There are two layers.

**Coarse effects** (`mutation`, `invocation`, `emission`, `stateChange`) record that something happened: a call fired, a state variable was set, an event went out. What they are for is impact analysis, as in "this change edits a handler that writes `users`, and here is who reads `users`".

On an `invocation`, `summary` is the summary this call reaches, the one whose unit is declared where the type checker resolved `callee`. It is absent when the callee is declared outside the run, when more than one summary describes that unit, or when nothing resolved and no summary in the same file has that name, because a guess is worse than a gap. `declaredAt` and `argsDeclaredAt` are the raw declaration places an adapter sets while extracting; naming turns them into `summary` and `argsSummary` and removes them, so you see them only in the extraction cache. `calleeParameter` is set when the callee is one of this unit's own parameters, and gives its index among them, so a caller that passes a function into that parameter reaches this call through it.

**`interaction` effects** are the typed boundary crossings. Each one includes the `BoundaryBinding` of the thing it talks to, plus a payload discriminated on `class`:

```typescript
type Interaction =
  | { class: "storage-access"; kind: "read" | "write"; fields: string[];
      selector?: string[]; operation?: string;
      relationPath?: string[]; relationKey?: boolean }
  | { class: "service-call"; method: string; payload?: unknown;
      responseShape?: TypeShape }
  | { class: "message-send"; body?: unknown; routingKey?: string }
  | { class: "message-receive"; body?: unknown }
  | { class: "unit-invoke"; payload?: unknown }
  | { class: "config-read"; name: string; defaulted: boolean }
  | { class: "schedule"; via: string; hasDelay: boolean;
      callbackRef:
        | { type: "literal" }
        | { type: "identifier"; name: string }
        | { type: "opaque"; reason: string } };
```

- **`storage-access`** covers Prisma calls, Drizzle queries, ActiveRecord chains and raw SQL. It pairs against a storage provider on `(storageSystem, scope, container, accessPath)`. `relationPath` is the relation fields the access travelled through from the container in the binding; only the provider's contract says where a relation points, so the pairing pass resolves the path and moves the access to the container it arrives at. `relationKey` says the columns are the ones the contract declares for the last name in the path rather than columns the call states, which is what a Prisma `connect` looks like.
- **`service-call`** covers fetch, axios, a ts-rest client, an Apollo client. It pairs against a REST or GraphQL provider.
- **`message-send`** covers SQS, Kafka and BullMQ producers. It pairs against a message-bus consumer on `(messageBus, channel)`.
- **`message-receive`** is the fields a consumer pulls out of a message. It states no channel, because a handler signature does not say which one it is for, so the checker reads the channel off the enclosing summary's binding.
- **`unit-invoke`** is calling a deployed unit by name. It pairs on `(deploymentTarget, instanceName)`, after the invoking unit's environment settles a name that only exists at deploy time.
- **`config-read`** is a `process.env.X` access or its equivalent. It pairs against a runtime-config provider on the variable name plus the code scope.
- **`schedule`** is a callback handed to `setTimeout`, `process.nextTick` or a library hook. Nothing pairs against these, so the enclosing binding uses `function-call` semantics and the interaction is there for dataflow and for `inspect`. `hasDelay` says a delay argument was passed, not what it was.

Adding a class is an additive IR change. Each class maps one to one onto a `binding.semantics.name` by convention; the IR does not enforce that and every shipped recognizer follows it. See [Pack patterns](/packs/patterns#recognizers) for the recognizers that emit them.

`preconditions` on `invocation` and `interaction` are the ancestor conditions gating the effect within its transition. They are absent for a call that always fires.

### `Input`

```typescript
type Input =
  | { type: "parameter"; name: string; position: number;
      role: string | null; shape: TypeShape | null }
  | { type: "injection"; name: string; mechanism: string; shape: TypeShape | null }
  | { type: "hookReturn"; hook: string; destructuredFields: string[] }
  | { type: "contextValue"; context: string; accessedFields: string[] }
  | { type: "closure"; name: string };
```

How values reach a code unit. An HTTP handler usually has only `parameter` inputs; the rest are mostly for components and hooks.

`role` says what the parameter means to the framework (`"request"`, `"response"`, `"pathParams"`, `"requestBody"`), and `InputMappingPattern` in the pack sets it. It is null when nobody could tell which role the parameter has, rather than a guess, and the summary then includes a gap saying why. A role often follows from something the reader had to work out first, and a route whose path went unread cannot tell a path parameter from a query parameter.

`const [user, setUser] = useUser()` produces a `hookReturn` input with `destructuredFields: ["user", "setUser"]`. The React pack discovers components, hooks and event handlers and fills these in.

### `Gap`

```typescript
interface Gap {
  type: "unhandledCase" | "unreadOutcome" | "unfollowedCall";
  conditions: Predicate[];
  consequence: "frameworkDefault" | "implicitThrow" | "fallthrough" | "unknown";
  description: string;
  callee?: string;
}
```

Something the summary could not account for. A gap is output rather than an error, because "this case exists and I cannot say what happens in it" is worth knowing.

**`unhandledCase`** is about the code. The declared contract lists a response no transition produces, or a transition produces a status the contract never declared. The checker turns each one into a `providerContractViolation` at error severity.

**`unreadOutcome`** is about how suss read the code. A `return` matched none of the terminal shapes the pack looks for:

```json
{
  "type": "unreadOutcome",
  "consequence": "unknown",
  "description": "One return in this function matches none of the terminal shapes this pack looks for, so what it produces is not described here"
}
```

The handler may be answering correctly in a form nobody taught the pack, so the checker reports `lowConfidence` at info severity rather than blaming the code. Teaching the pack that terminal shape is what makes it go away.

**`unfollowedCall`** is the other one about how suss read the code. The walk met a call it could not resolve to a function with a body, so whatever runs behind it is missing from this summary and from every effect derived from it. `callee` says which call, as the source writes it:

```json
{
  "type": "unfollowedCall",
  "consequence": "unknown",
  "description": "The call to db.findById lands on a declaration with no body, so whatever runs there is missing from this summary",
  "callee": "db.findById"
}
```

A call into a dependency is unfollowable too and leaves no gap: the run describes that as a boundary crossing, and a gap on every `JSON.parse` would bury the stops a reader can act on. What is recorded is a call whose callee the project itself declares. `suss inspect` prints these under `Could not follow:`.

**`consequence`** says what happens in the unhandled case. `frameworkDefault` means the framework produces something (Express serves a 500 page). `implicitThrow` means an unhandled rejection propagates up. `fallthrough` means control passes to the next middleware or handler. `unknown` means the extractor could not tell.

## Values and shapes

### `ValueRef`

```typescript
type ValueRef =
  | { type: "input"; inputRef: string; path: string[] }
  | { type: "dependency"; name: string; accessChain: string[] }
  | { type: "derived"; from: ValueRef; derivation: Derivation }
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "state"; name: string }
  | { type: "unresolved"; sourceText: string };

type Derivation =
  | { type: "propertyAccess"; property: string }
  | { type: "methodCall"; method: string; args: string[] }
  | { type: "destructured"; field: string }
  | { type: "awaited" }
  | { type: "indexAccess"; index: string | number };
```

A reference to a value inside a code unit. Each variant says where the value came from without trying to work out what it means.

- **`input`**, a function parameter. `inputRef` is the parameter name and `path` is the property chain from there (`args.params.id` becomes `{ inputRef: "args", path: ["params", "id"] }`).
- **`dependency`**, the result of a call. `name` is the callee expression as text (`"db.findById"`), and `accessChain` is any property access before the value is tested.
- **`derived`**, a composed reference. `from` is the parent and `derivation` is how this one was produced, which is what lets a `ValueRef` form a tree: `container.repository.lastCommit` is a `derived` of a `derived` of a `dependency`.
- **`literal`**, a constant, usually the right-hand side of a comparison.
- **`state`**, component state, a closure variable or a module-level variable.
- **`unresolved`**, the extractor could not tell where the value came from. The source text is kept, so the reference still says what was tested.

The structure is shallow on purpose. Two predicates that both test the result of `db.findById(id).deletedAt` have to be recognizable as the same subject even though nothing here knows what `findById` does. Shallow references survive a mechanical rename, cost nothing to compute, and mean the same thing in another language: Python's `db.find_by_id(id)` produces an analogous `ValueRef`.

### `TypeShape`

```typescript
type TypeShape =
  | { type: "record"; properties: Record<string, TypeShape>;
      spreads?: Array<{ sourceText: string }> }
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
  | { type: "ref"; name: string; def?: string; from?: string }
  | { type: "unknown" };
```

Enough structure to describe a response body or a return value, without reproducing a whole type system. A Python adapter produces the same shapes, which is the point: serializing compiler types would make cross-language comparison impossible.

**Record against dictionary.** A `record` is a closed struct with a fixed set of named fields. A `dictionary` is an index signature (`Record<string, T>`), where the key set is open and every access returns a `T`. A comparison has to keep them apart, because a dictionary accepts any key and a record accepts only the ones listed.

**`ref` is the escape hatch**, meaning the extractor knows this is typed as `User` and has not inlined the definition. A name on its own does not identify a type: two modules can each declare a `User`, and every instantiation of one generic reports the generic's own name, so `Omit<User, "secret">` and `Omit<Order, "total">` are both `Omit`. `from` says which file declares the type, when the project declares it, and `def` is the key into the summary's `definitions` table, built from what the type actually is. A name the language or a dependency owns has neither.

#### What crosses the wire

`TypeShape` describes values as they cross a serialization boundary: HTTP bodies, messages on a queue, return values a caller reads. It is not the in-memory type system of the source language, and two things follow from that.

**Numeric precision.** JavaScript's `number` is an IEEE 754 double. Integers past `Number.MAX_SAFE_INTEGER`, high-precision decimals, hex and scientific notation, and underscore separators all lose information through it. A numeric `literal` keeps the exact source text in `raw`, so a consumer that needs the precision never has to guess. Strings and booleans round-trip and have no `raw`.

**Types with no wire form.** `BigInt`, `Date`, `Map`, `Set`, `Buffer`, a regex: none of these has a canonical JSON representation. The extractor surfaces them as `ref` with the declared name rather than inventing a structural expansion. What goes on the wire is up to the producer and consumer: a `Date` may be an ISO string from `toJSON`, an epoch number, or absent.

**`undefined`.** It is modelled for source fidelity, for optional fields and explicit `undefined` returns, and JSON omits it. A record with `email: undefined` serializes to a body where `email` is absent, so a contract checker should treat `{ value: T | undefined }` and `{ value?: T }` as the same thing at the wire boundary.

**Codecs are out of scope for v0.** The IR says what data flows, not which codec produced it, so it can only say that a `Date`-shaped thing was referenced. A future direction is an explicit serde variant such as `{ type: "serialized"; wire: TypeShape; reconstructs: TypeShape }`, which would let a checker ask whether a producer writing an ISO string satisfies a consumer expecting a `Date`. Until then the two sides agree on a codec out of band and the IR treats a `ref` as opaque past the name.

### `ConfidenceInfo`

```typescript
interface ConfidenceInfo {
  source: "inferred_static" | "inferred_ai" | "declared" | "derived";
  level: "high" | "medium" | "low";
  corroboration?: Corroboration;
}

interface Corroboration {
  outcome: "observed" | "refuted" | "untested";
  runs: number;
  counterexample?: unknown;  // present when refuted
  reason?: string;           // present when untested
}
```

How much of the behavior suss read, and where the claim came from.

- **`inferred_static`**, structural analysis of the source, which is the common case.
- **`inferred_ai`**, reserved for LLM-assisted labels on opaque predicates. Nothing writes it today.
- **`declared`**, a summary somebody wrote by hand, such as a stub for a dependency suss cannot read.
- **`derived`**, produced from a contract source rather than from code.

A return the pack could not read sets the level to `low` on its own, and that check runs first: a function whose returns all went unread has no conditions either, and zero opaque out of zero used to come out `high`. Otherwise the level is the share of predicates that came out opaque, with `0` giving `high`, under half `medium`, and half or more `low`.

`corroboration` is what came of running the code with `suss corroborate`. Inputs satisfying the claim's own conditions are generated and run through the function, and the observation either agreed every time (`observed`), disagreed at least once (`refuted`, with the input that disagreed), or never produced a verdict (`untested`, with the reason). Corroboration adds evidence to a derivation and never rewrites the derived claim.

The checker does not change a finding's severity because of confidence. A consumer can: a high-confidence mismatch is almost certainly a user-visible bug, and a low-confidence one deserves a look rather than a broken build.

## Findings

### `Finding`

```typescript
interface Finding {
  kind: FindingKind;
  boundary: BoundaryBinding;
  provider: FindingSide;
  consumer: FindingSide;
  description: string;
  severity: "error" | "warning" | "info";
  aspect?: BoundaryAspect;
  sources?: string[];
  suppressed?: FindingSuppression;
}

interface FindingSide {
  summary: string;         // "src/handlers/users.ts::getUser"
  transitionId?: string;   // set when the finding is about one branch
  location: SourceLocation;
}

interface FindingSuppression {
  reason: string;
  effect: "mark" | "downgrade" | "hide";
  originalSeverity?: "error" | "warning" | "info";
}

type BoundaryAspect =
  | "read" | "write" | "send" | "receive" | "construct" | "selector";
```

What the pairwise checker emits. The [findings catalog](/reference/findings) lists every `kind` with its severity, when it fires and what to do about it; `FindingKindSchema` in `packages/behavioral-ir/src/schemas.ts` is the authoritative enumeration.

- **Both sides are always named.** Even when only the provider is at fault, as with `providerContractViolation`, the finding still points at a consumer summary, often the same one, used as the pairing anchor. Tooling can then attribute the finding to a pairing rather than to a free-floating provider.
- **`aspect`** says which side of a field the finding concerns. `send` and `receive` are a payload's two directions, `construct` is a scenario setting an input, and `selector` is a query's `where` rather than its data. It is absent where the aspect is irrelevant or spans several.
- **`sources`** is set when the dedupe pass collapses identical findings from several providers. Each entry matches a `FindingSide.summary`, so a tool can surface every contributor without re-running the checker.
- **`suppressed`** is set when a `.sussignore` rule matched. `mark` keeps the finding visible and drops it from the exit code, `downgrade` drops the severity one level and still counts it, `hide` keeps it out of both and survives only in the JSON. See [Accept a finding](/guides/accept-a-finding).

Findings live in `@suss/behavioral-ir` rather than in the checker, because diff viewers, aggregation layers and other downstream tools read findings the same way they read summaries, and none of them should have to depend on `@suss/checker` to do it.

Severity drives the exit code. `suss check` exits non-zero when any `error` finding is present; `--fail-on warning` or `--fail-on info` raises the gate. See [Exit codes](/reference/cli/exit-codes).

### `RunFinding`

```typescript
interface RunFinding {
  kind: "nothingPaired" | "unreadableInput" | "mostlyUnpaired";
  severity: "error" | "warning" | "info";
  description: string;
  remedy: string;
}
```

A problem with the run rather than with a boundary. A boundary finding points at two sides that disagree, and these have no two sides to point at, so they travel in their own list under `run` and say what to do next instead of naming a boundary.

### `SummaryDiff`

```typescript
interface SummaryDiff {
  addedTransitions: Transition[];
  removedTransitions: Transition[];
  changedTransitions: Array<{ before: Transition; after: Transition }>;
}
```

What `diffSummaries` returns for one unit. A transition counts as changed when its `id` survives and its content moved, which is why transition ids leave source offsets out.

## The adapter interface

### `RawCodeStructure`

An adapter reads source and produces this; the extractor turns it into a `BehavioralSummary`. It is defined in `@suss/extractor` rather than in the IR, because it is a boundary inside the pipeline rather than part of the published output, and it changes more often than the IR does.

```typescript
interface RawCodeStructure {
  identity: {
    name: string; nameKind?: "binding" | "label"; kind: CodeUnitKind;
    file: string; range: { start: number; end: number };
    span?: { start: number; end: number };
    exportName: string | null; exportPath: string[] | null;
  };
  boundaryBinding: BoundaryBinding | null;
  parameters: RawParameter[];
  branches: RawBranch[];
  dependencyCalls: RawDependencyCall[];
  declaredContract: RawDeclaredContract | null;
  // plus optional fields an adapter fills in where it can: the wrappers
  // registered around the unit, a GraphQL document as written, the body
  // accessors a client reads through, and the readings it passed along
  // uncollapsed. `packages/extractor/src/index.ts` has them all.
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

Every field is plain JSON: no AST nodes, no compiler types. Three things follow from that split.

1. **The extractor can be tested without a compiler.** Hand-written `RawCodeStructure` values drive its whole test suite in milliseconds.
2. **One place decides the hard parts.** Opaque wrapping, gap detection, confidence, and the final summary structure are all settled in the extractor, so no adapter reimplements them.
3. **Adding a language is adding an adapter.** The Python adapter produces the same structure and the extractor does not know which compiler filled it in.

[The extraction algorithm](/theory/extraction-algorithm) covers how the TypeScript adapter produces one from source files.
