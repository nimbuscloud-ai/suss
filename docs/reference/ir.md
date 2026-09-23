---
title: IR types
description: Every type in the behavioral IR, field by field, grouped by what it describes.
---

# IR types

The types below come from two packages. `@suss/behavioral-ir` defines the summary, the transition and the finding. `@suss/ir-core` defines the primitives every suss IR shares, which are the boundary binding, the type shape, the source location and the confidence block. Both are generated from zod schemas, and the JSON Schema the package publishes is generated from those at build time.

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

suss writes one of these per code unit. It is flat JSON with no cycles, apart from the recursive `ValueRef`, `Predicate`, `TypeShape` and `RenderNode` trees.

- **`schemaVersion`** is absent on a summary written by 0.3.x, which the parsers read as version 1. Version 6 is current. [Summary format](/reference/summary-format#versions) lists what each version changed.
- **`definitions`** is the table a `ref` shape points into, keyed the way `typeDefinitionKey` in `@suss/ir-core` builds a key. `withDefinitionsInlined` puts a definition back into a shape, and every comparison reads the inlined form.
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

How inputs arrive and what counts as output depend on the kind. A handler takes a request and produces a response. A component takes props and state and produces a UI tree. A consumer takes a message and produces effects.

**`consumer` against `client`.** Both are downstream of a boundary, but suss models them differently. A consumer receives a message and produces effects. A client makes a request, branches on the response status and reads fields off the body, so a client's transitions have `expectedInput` on them where a consumer's have effects. The checker applies different rules to each.

**`library` and `caller`** are the two sides of an in-process `function-call` boundary. The `packageExports` discovery variant produces the `library` side, one per function reachable through the package's `package.json` entry points. The `packageImport` variant produces the `caller` side, one per (enclosing function, consumed binding). They pair by `fn:<package>::<exportPath>`.

**`module-init`** is what a source file does at import time, one per file, and it is always a consumer: it reads channels other units declare. **`scheduled-callback`** is a function the runtime calls at some later point, and what it reaches is recorded on its own summary.

The union is closed, so a pack cannot add a kind. The rest of extraction makes assumptions about each kind, and a new framework that needs a new kind needs an IR change first.

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

Location tells you where the code is. Identity tells you what it is, whatever file somebody moves it to. Move `services/api/handlers/users.ts` to `services/api/routes/users/index.ts` and the location changes, while the identity, a `getUser` handler bound to `GET /users/:id`, stays the same.

- **`range` and `span`.** The line range is for a reader and an editor link. The character span is what identity and joins measure with, because two functions can share a line and never an offset range. A summary with no source position behind it, such as one read from a contract artifact, has no `span`.
- **`workspace`** is the extracted project's own name. Paths are relative to wherever the extract ran, so two services in one repository both report `src/handlers.ts`. Once their summaries are merged, the workspace is how you tell them apart.
- **`id`** is workspace, file and export path together. A name on its own collides with other names too often to identify a unit.
- **`nameKind`** records where the name came from. `"binding"` means other code can call the unit by it. `"label"` means discovery made the name up, and a label is never used as a binding.
- **`exportPath`** is an array, because deep module namespaces (`namespace.submodule.getUser`) turn up in some frameworks and an array is easier to compare than a dotted string.
- **`boundaryBinding`** is nullable on purpose. A utility function or an internal helper doesn't take part in any contract. An explicit `null` forces a consumer to handle that case.
- **`deployableUnit`** records what runs this code, where the pack can work it out: the Lambda's logical id from a SAM template, or the container or deployment name elsewhere. The checker joins on it. Several Lambdas can each subscribe to one channel with their own handler, and the channel alone doesn't tell you which handler runs where. The field is optional, because a React component or a library export is never deployed on its own, so there is nothing to record.

## Boundaries

### `BoundaryBinding`

```typescript
interface BoundaryBinding {
  transport: string;    // the wire: "http", "aws_sqs", "in-process", "os"
  semantics: Semantics; // the pairing rule, discriminated on `name`
  recognition: string;  // which pack matched, or "reachable"
}
```

`recognition: "reachable"` marks a unit found through the transitive closure of a unit a pack recognised. No pack pattern matched it directly. Such a unit has no pairing identity, so nothing cross-checks it, and its transitions and effects are extracted in full.

Each protocol is one module under `packages/ir-core/src/semantics`, which defines its schema, its pairing key and its agreement rule:

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
  | { name: "storage"; storageSystem: string | null; scope: string;
      container: string | null; accessPath: string | null }
  | { name: "message-bus"; messageBus: MessageBus; channel: string | null }
  | { name: "metric"; metricSystem: string; metricType: string | null }
  | { name: "unit-invocation"; deploymentTarget: string;
      instanceName: string | null };

type MessageBus =
  | "aws_sqs" | "aws.sns" | "s3" | "eventbridge"
  | "aws_kinesis" | "aws_firehose" | "gcp_pubsub"
  | "bullmq" | "kafka" | "nats"
  | "cloudflare-queues" | "cloudflare-cron" | "cloudflare-tail";
```

An identity field is null when the source does not say what it is. The empty string is invalid there, because every empty string would pair with every other. REST's `method` also takes `"*"`, for a handler that serves every method, and it pairs with whatever method each consumer uses.

`runtime-config` and `unit-invocation` both take their two fields from `DeployableUnit`, because the pairing key is a deployed unit, and one deployed unit has both of those boundaries on it. `unit-invocation` makes `instanceName` nullable, since only the provider side always has the name.

Storage's `container` and `accessPath` use the boundary-name syntax: a literal (`orders-v1`), a pattern with deploy-time holes (`{stage}-orders-v1`), or a reference to somewhere else that has the value (`{ORDER_TABLE}`). You can tell the three apart by the braces. `parseBoundaryName` in `@suss/ir-core` is the only function that parses that syntax, and the package's README describes the three forms. A REST `path` also uses braces, but a route parameter stops at the `/` between segments, so the two conventions do not collide.

[Boundary semantics](/theory/boundary-semantics) describes each variant's pairing rule and the builder helpers packs use.

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

One transition records that when all of these conditions hold, this output comes out and these effects fire. A unit's behavior is its set of transitions, and every execution path through the unit maps to exactly one of them. Where the set is not exhaustive, the hole is recorded as a `Gap`.

- **`conditions` is a flat AND.** `OR` composition happens inside a `Predicate`, through the `compound` variant. Two transitions then have the same precondition when their condition lists are structurally equal, with nothing else to work out.
- **`isDefault`** marks the fall-through case, the one with no explicit conditions or only early-return guards. Most handlers have one. Some have none, because every path is gated, and some have several, one per early return.
- **`id` is content-addressed.** It reads `${functionName}:${terminalKind}:${statusKey}:${hash7}`, where the hash is the first seven hex characters of a SHA-1 over the ordered condition chain's canonical source text. `diffSummaries` then survives branch reordering, while changing a status, a condition or a terminal kind gives you a new id. Condition order is part of the identity, because short-circuit evaluation makes `a && b` and `b && a` behave differently. Source offsets are left out, so reformatting a file doesn't change an id.
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

- **`truthinessCheck` against `nullCheck`.** JavaScript's `if (x)` tests truthiness, which is a different test from `x != null`, since `0`, `""` and `false` are falsy too. A nullness check is about whether the value is there at all. Treating the two as one condition would pair up branches that guard against different things.
- **`compound` against `negation`.** `compound` covers `and` and `or`, and leaves `not` to its own variant. A `not` of a `not` collapses to the operand, and keeping negation separate makes that rewrite straightforward. `compound` takes any number of operands, so there is no separate binary form.
- **`opaque` is a normal variant.** When the extractor cannot take a condition apart, it keeps the source text and records why. A downstream tool then knows the branch exists and decides for itself how to treat it.

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

`Output` is what a terminal produces. Each pack uses the variants its framework needs, and the union itself has nothing framework-specific in it.

- **`response`** is an HTTP response. `statusCode` is a `ValueRef`, because the status can be dynamic (`res.status(code).json(...)`). A literal 200 arrives as `{ "type": "literal", "value": 200 }`.
- **`throw`** keeps the constructor expression as text (`"HttpError.NotFound"`), because the class itself cannot be resolved statically in general.
- **`render`** is a component render result. `component` is the root element's name. `root` is the whole tree, filled in by packs that read their language's render form, so a checker can compare structural output against a contract source such as a Storybook story.
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

`RenderNode` is the tree under `Output.render.root`. `attrs` gives attribute values as source text, quotes included, and a boolean shorthand such as `<input disabled>` maps to the empty string. `target` records where the tag's component is declared, when the walk managed to resolve it, using the file and name that child's summary is keyed on. A checker can then join this render edge to that summary. A host tag leaves `target` unset. On a `conditional`, a null `whenFalse` covers both `{cond && <X/>}` and an else written as `null`, since React renders nothing either way.

### `Effect`

```typescript
type Effect = ({ count?: number }) & (
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
      interaction: Interaction }
);

interface DeclarationPlace {
  file: string;
  span: { start: number; end: number };
}
```

An effect is what a transition does besides producing a value. Effects come in two layers.

A transition lists each effect once. `count` says how many sites on that path produced it, so a path that validates the same schema thirteen times has one effect with `count: 13`. It is absent when there was only one, and a call written across several lines counts with the same call written on one, since `callee` is the source text with its whitespace collapsed.

**Coarse effects** (`mutation`, `invocation`, `emission`, `stateChange`) record that something happened: a call fired, a state variable was set, an event went out. They are there for impact analysis, the kind where you want to say "this change edits a handler that writes `users`, and here is who reads `users`".

On an `invocation`, `summary` is the summary this call reaches, the one whose unit is declared where the type checker resolved `callee`. It is absent when the callee is declared outside the run, when more than one summary describes that unit, or when nothing resolved and no summary in the same file has that name. `declaredAt` and `argsDeclaredAt` are the raw declaration places an adapter sets while extracting; naming turns them into `summary` and `argsSummary` and removes them, so you see them only in the extraction cache. `calleeParameter` is set when the callee is one of this unit's own parameters, and gives its index among them, so a caller that passes a function into that parameter reaches this call through it.

**`interaction` effects** are the typed boundary crossings. Each one includes the `BoundaryBinding` of the resource it reaches, plus a payload discriminated on `class`:

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
  | { class: "metadata-read"; name: string }
  | { class: "schedule"; via: string; hasDelay: boolean;
      callbackRef:
        | { type: "literal" }
        | { type: "identifier"; name: string }
        | { type: "opaque"; reason: string } };
```

- **`storage-access`** covers Prisma calls, Drizzle queries, ActiveRecord chains and raw SQL. It pairs against a storage provider on `(storageSystem, scope, container, accessPath)`, and a provider whose `storageSystem` is null, which is a store whose deploy configuration picks its engine from a variable, meets an access on any engine. `relationPath` is the relation fields the access travelled through from the container in the binding; only the provider's contract says where a relation points, so the pairing pass resolves the path and moves the access to the container it arrives at. `relationKey` marks an access whose columns come from the contract's own declaration for the last relation in the path, instead of from columns the call spells out. A Prisma `connect` is the usual case.
- **`service-call`** covers fetch, axios, a ts-rest client, an Apollo client. It pairs against a REST or GraphQL provider.
- **`message-send`** covers SQS, Kafka and BullMQ producers. It pairs against a message-bus consumer on `(messageBus, channel)`.
- **`message-receive`** is the fields a consumer pulls out of a message. It doesn't state a channel, because a handler signature never tells you which channel it is for, so the checker reads the channel off the enclosing summary's binding instead.
- **`unit-invoke`** is calling a deployed unit by name. It pairs on `(deploymentTarget, instanceName)`, once the invoking unit's environment resolves a name that only exists at deploy time.
- **`config-read`** is a `process.env.X` access or its equivalent. It pairs against a runtime-config provider on the variable name plus the code scope.
- **`metadata-read`** is a read of something the runtime provides on its own: `__dirname`, `import.meta.url`, `process.cwd`, `process.platform`. It goes on the same runtime-config boundary as a config read, and nothing pairs against it, because no deploy file declares these.
- **`schedule`** is a callback handed to `setTimeout`, `process.nextTick` or a library hook. Nothing pairs against these, so the enclosing binding uses `function-call` semantics and the interaction is there for dataflow and for `inspect`. `hasDelay` records only that a delay argument was passed, without its value.

Adding a class is an additive IR change. Each class maps one to one onto a `binding.semantics.name` by convention. The IR does not enforce that, but every shipped recognizer follows it. See [Pack patterns](/packs/patterns#recognizers) for the recognizers that emit them.

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

An `Input` is one way a value reaches a code unit. An HTTP handler usually has only `parameter` inputs; the rest are mostly for components and hooks.

`role` records what the parameter means to the framework (`"request"`, `"response"`, `"pathParams"`, `"requestBody"`), and `InputMappingPattern` in the pack sets it. When suss cannot work out a parameter's role, it writes null and records a gap saying why. A role often depends on something the reader had to work out first. If the route's path went unread, for instance, there is no way to separate a path parameter from a query parameter.

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

A gap is something the summary could not account for. The run keeps going and the gap goes into the output, so you can see that a case exists even where suss could not work out what happens in it.

**`unhandledCase`** is about the code. The declared contract lists a response no transition produces, or a transition produces a status the contract never declared. The checker turns each one into a `providerContractViolation` at error severity.

**`unreadOutcome`** is about how suss read the code. A `return` didn't match any of the terminal shapes the pack looks for:

```json
{
  "type": "unreadOutcome",
  "consequence": "unknown",
  "description": "One return in this function matches none of the terminal shapes this pack looks for, so what it produces is not described here"
}
```

The handler may well be responding correctly, in a form the pack has no pattern for yet, so the checker reports `lowConfidence` at info severity. Add that terminal shape to the pack and the gap goes away.

**`unfollowedCall`** is the other one about how suss read the code. The walk met a call it could not resolve to a function with a body, so whatever runs behind it is missing from this summary and from every effect derived from it. `callee` gives the call as the source writes it:

```json
{
  "type": "unfollowedCall",
  "consequence": "unknown",
  "description": "The call to db.findById lands on a declaration with no body, so whatever runs there is missing from this summary",
  "callee": "db.findById"
}
```

A call into a dependency is unfollowable too, and suss doesn't record a gap for it. The run already describes that as a boundary crossing, and a gap on every `JSON.parse` would bury the stops you can actually do something about. So a gap here always means a call whose callee the project itself declares. `suss inspect` prints these under `Could not follow:`.

**`consequence`** records what happens in the unhandled case. `frameworkDefault` means the framework produces something (Express serves a 500 page). `implicitThrow` means an unhandled rejection propagates up. `fallthrough` means control passes to the next middleware or handler. `unknown` means the extractor could not tell.

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

A `ValueRef` points at a value inside a code unit. Each variant records where the value came from, without interpreting it.

- **`input`**, a function parameter. `inputRef` is the parameter name and `path` is the property chain from there (`args.params.id` becomes `{ inputRef: "args", path: ["params", "id"] }`).
- **`dependency`**, the result of a call. `name` is the callee expression as text (`"db.findById"`), and `accessChain` is any property access before the value is tested.
- **`derived`**, a composed reference. `from` is the parent and `derivation` is how this one was produced. That pairing is what makes a `ValueRef` a tree: `container.repository.lastCommit` is a `derived` of a `derived` of a `dependency`.
- **`literal`**, a constant, usually the right-hand side of a comparison.
- **`state`**, component state, a closure variable or a module-level variable.
- **`unresolved`**, the extractor could not work out where the value came from. It keeps the source text, so the reference still shows you what was tested.

The structure is shallow on purpose. Two predicates that both test the result of `db.findById(id).deletedAt` have to be recognizable as the same subject, even though the IR records nothing about what `findById` does. Shallow references survive a mechanical rename and cost nothing to compute. They also mean the same thing in another language: Python's `db.find_by_id(id)` produces an analogous `ValueRef`.

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

A `TypeShape` has enough structure to describe a response body or a return value without reproducing a whole type system. The Python adapter produces these same shapes. Serializing each language's compiler types instead would leave nothing that compares across languages.

**Record against dictionary.** A `record` is a closed struct with a fixed set of named fields. A `dictionary` is an index signature (`Record<string, T>`), where the key set is open and every access returns a `T`. A comparison has to keep them apart, because a dictionary accepts any key and a record accepts only the ones listed.

**`ref` is the escape hatch.** It means the extractor got as far as "this is typed as `User`" and did not inline the definition. A name on its own does not identify a type: two modules can each declare a `User`, and every instantiation of one generic reports the generic's own name, so `Omit<User, "secret">` and `Omit<Order, "total">` are both `Omit`. `from` says which file declares the type, when the project declares it, and `def` is the key into the summary's `definitions` table, built from what the type actually is. A type the language or a dependency declares has neither.

#### What crosses the wire

`TypeShape` describes values as they cross a serialization boundary: HTTP bodies, messages on a queue, return values a caller reads. It does not model the source language's in-memory types, which leads to the points below.

**Numeric precision.** JavaScript's `number` is an IEEE 754 double. Integers past `Number.MAX_SAFE_INTEGER`, high-precision decimals, hex and scientific notation, and underscore separators all lose information through it. A numeric `literal` keeps the exact source text in `raw`, so a consumer that needs the precision never has to guess. Strings and booleans round-trip and have no `raw`.

**Types with no wire form.** `BigInt`, `Date`, `Map`, `Set`, `Buffer`, a regex: none of these has a canonical JSON representation. The extractor records them as a `ref` with the declared name. What goes on the wire is up to the producer and consumer: a `Date` may be an ISO string from `toJSON`, an epoch number, or absent.

**`undefined`.** It is modelled for source fidelity, for optional fields and explicit `undefined` returns, and JSON omits it. A record with `email: undefined` serializes to a body where `email` is absent, so a contract checker should treat `{ value: T | undefined }` and `{ value?: T }` as the same thing at the wire boundary.

**Codecs are out of scope for v0.** The IR describes what data flows, without recording which codec produced it, so all it can tell you is that a `Date`-shaped thing was referenced. A future direction is an explicit serde variant such as `{ type: "serialized"; wire: TypeShape; reconstructs: TypeShape }`, which would let a checker ask whether a producer writing an ISO string satisfies a consumer expecting a `Date`. Until then the two sides agree on a codec out of band and the IR treats a `ref` as opaque past the name.

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

`ConfidenceInfo` records how much of the behavior suss read, and where the claim came from.

- **`inferred_static`**, structural analysis of the source, which is the common case.
- **`inferred_ai`**, reserved for LLM-assisted labels on opaque predicates. Nothing writes it today.
- **`declared`**, a summary somebody wrote by hand, such as a stub for a dependency suss cannot read.
- **`derived`**, produced by a contract source such as an OpenAPI document.

A return the pack could not read sets the level to `low` on its own, and suss applies that rule before any other. A function whose returns all went unread has no conditions either, and counting zero opaque predicates out of zero would otherwise come out `high`. Where no return went unread, the level is the share of predicates that came out opaque: `0` gives `high`, under half gives `medium`, and half or more gives `low`.

`corroboration` is what came of running the code with `suss corroborate`. Inputs satisfying the claim's own conditions are generated and run through the function, and the observation either agreed every time (`observed`), disagreed at least once (`refuted`, with the input that disagreed), or never produced a verdict (`untested`, with the reason). Corroboration adds evidence to a derivation and never rewrites the derived claim.

The checker does not change a finding's severity because of confidence, though a tool reading the findings is free to. A high-confidence mismatch is almost certainly a bug your users will hit. Look at a low-confidence one before you break the build over it.

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

A `Finding` is what the pairwise checker emits. The [findings catalog](/reference/findings) lists every `kind` with its severity, when it fires and what to do about it; `FindingKindSchema` in `packages/behavioral-ir/src/schemas.ts` is the authoritative enumeration.

- **Both sides are always named.** Even when only the provider is at fault, as with `providerContractViolation`, the finding still points at a consumer summary, often the same one, used as the pairing anchor. Tooling can then attribute every finding to a pairing.
- **`aspect`** records which side of a field the finding concerns. `send` and `receive` are a payload's two directions, `construct` is a scenario setting an input, and `selector` is a query's `where` clause. It is absent where the aspect is irrelevant or spans several.
- **`sources`** is set when the dedupe pass collapses identical findings from several providers. Each entry matches a `FindingSide.summary`, so a tool can surface every contributor without re-running the checker.
- **`suppressed`** is set when a `.sussignore` rule matched. `mark` keeps the finding visible and drops it from the exit code, `downgrade` drops the severity one level and still counts it, `hide` keeps it out of both and survives only in the JSON. See [Accept a finding](/guides/accept-a-finding).

Findings live in `@suss/behavioral-ir`, because diff viewers, aggregation layers and other downstream tools read findings the same way they read summaries, and none of them should have to depend on `@suss/checker` to do it.

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

A `RunFinding` reports a problem with the run itself. A boundary finding points at two sides that disagree. A run finding has no two sides to point at, so these go in their own list under `run`, each with a `remedy` telling you what to do next.

### `SummaryDiff`

```typescript
interface SummaryDiff {
  addedTransitions: Transition[];
  removedTransitions: Transition[];
  changedTransitions: Array<{ before: Transition; after: Transition }>;
}
```

`diffSummaries` returns one of these for each unit. A transition counts as changed when its `id` survives and its content moved. Transition ids leave source offsets out for that reason.

## The adapter interface

### `RawCodeStructure`

An adapter reads source and produces this; the extractor turns it into a `BehavioralSummary`. It is defined in `@suss/extractor`, because it is a boundary inside the pipeline and it changes more often than the published output does.

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

Every field is plain JSON, with no AST nodes or compiler types in it. Three things follow from that split.

1. **The extractor can be tested without a compiler.** Hand-written `RawCodeStructure` values drive its whole test suite in milliseconds.
2. **The hard parts happen in one place.** The extractor does the opaque wrapping, gap detection, confidence and the final summary structure, so no adapter reimplements them.
3. **Adding a language is adding an adapter.** The Python adapter produces the same structure, and nothing in the extractor depends on which compiler filled it in.

[The extraction algorithm](/theory/extraction-algorithm) describes how the TypeScript adapter produces one from source files.
