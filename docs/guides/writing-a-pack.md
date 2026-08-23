# Writing a pack

Step-by-step instructions for creating a new framework, client, or runtime pack. For the conceptual overview of what packs are, see [`packs.md`](../packs.md). For the full pattern catalogue and interface contracts, see [`reference/pack-patterns.md`](../reference/pack-patterns.md).

The steps below walk through two existing packs, ts-rest and runtime-node, with a longer Fastify example at the end.

## Step 1: Create the package

```
packages/framework/<name>/
  package.json         @suss/framework-<name>, deps: @suss/extractor workspace:*
  tsconfig.json        extends ../../../tsconfig.base.json
  src/
    index.ts           exports a function returning PatternPack
    index.test.ts
  tsup.config.ts
  vitest.config.ts
```

For runtime packs use `packages/runtime/<name>/`; for client packs use `packages/client/<name>/`. Everything else is the same. The quickest way is to copy an existing pack directory and rename it. Each pack is 50-300 lines of declarative data plus a small test file.

## Step 2: Decide on pack kind

- **Discovery-driven** (most framework + client packs). Populate `discovery`, `terminals`, `inputMapping`. Optionally `contractReading` if the framework has declarative contracts.
- **Recognizer-only** (runtime packs, library-specific framework packs like aws-sqs / prisma). Leave `discovery: []` and `terminals: []`. Populate `invocationRecognizers` / `accessRecognizers` / `subUnits`. Add `requiresImport` if scoped to a specific library.

## Step 3: Answer the questions

**For discovery-driven packs:**

1. **Discovery**: Describe in one sentence how you'd find handlers by reading the source. "They're exported as a function named `loader`." Or: "They're methods on an object passed to `router(contract, ...)`." Pick the `DiscoveryMatch` variant that fits.
2. **Terminals**: What does producing a response look like? `return { status, body }`? `res.json(...)`? `throw new HttpError(...)`? Pick the matching `TerminalMatch` variant.
3. **Inputs**: What does the handler's signature look like? `(req, res, next)`? `({ params, body })`? `({ request, params })`? Pick the matching `InputMappingPattern` variant.
4. **Contracts** *(optional)*: Does the framework have declarative contracts? If so, where do they live and how are they structured?

**For recognizer-only packs:**

1. **Calls or accesses**: Which library-specific call expressions or property accesses should produce typed effects? What `interaction.class` does each map to? What pairing identity does the binding need?
2. **Sub-units** *(optional)*: Does the call schedule an inline callback whose body should be analyzed as its own unit?
3. **Import gate** *(optional)*: Is the pack scoped to a specific library? Set `requiresImport`.

If an existing pattern variant doesn't fit, talk to the maintainers before adding a new one. Extending the pattern types has ripple effects through the adapter.

## Step 4: Write the pack as a function

```typescript
import type { PatternPack } from "@suss/extractor";

export function myPack(): PatternPack {
  return {
    name: "my-pack",
    protocol: "http",
    languages: ["typescript"],
    discovery: [/* ... */],
    terminals: [/* ... */],
    inputMapping: { /* ... */ },
  };
}

export default myPack;
```

Export both a named function and a default for dynamic imports from the CLI.

**Only hardcode what your library defines.** Every identifier a pack hardcodes has to be one that the library the pack is about declares. A project's own wrapper goes in the pack's options instead, which the CLI fills from `-f <pack>=config.json`:

```typescript
export interface MyPackOptions {
  /** Decorators this project composes the library's own into. */
  classDecorators?: string[];
}

export function myPack(options: MyPackOptions = {}): PatternPack {
  return {
    // ...
    classDecorators: ["Controller", ...(options.classDecorators ?? [])],
  };
}
```

A name a specific codebase chose gives every other user false matches, and it inflates coverage measured against that codebase, because discovery finds those units by name rather than by pattern. Declare each identifier the pack hardcodes in `vocabulary.json` at the package root, mapped to where in the library it comes from, and `npm run check:vocabulary` checks that you did:

```json
{ "Controller": "@nestjs/common: class decorator marking a REST controller" }
```

**Shared discovery pattern for HTTP servers.** Most Node HTTP frameworks register handlers the same way (`app.get(path, handler)` / `router.post(...)`), varying only in the library name, the method list, and whether the library exports a default or a named factory. `@suss/extractor` exposes `httpRouteDiscovery` so packs don't have to hand-write the repeated `registrationCall` + `bindingExtraction` pair for each import name:

```typescript
import { httpRouteDiscovery } from "@suss/extractor";

discovery: httpRouteDiscovery({
  importModule: "express",
  importNames: ["Router", "express"],
  methods: [".get", ".post", ".put", ".delete", ".patch"],
}),
```

This emits one `DiscoveryPattern` per name with binding extraction (`method` from the registration method, `path` from argument 0) wired up. The Express and Fastify packs use this. Anything that registers handlers a different way (`@ts-rest/express`'s `initServer().router()`, decorators, file-convention) should declare `discovery` entries directly.

## Step 5: Write the tests

A pack test has two layers:

1. **Pack shape**, meaning the returned `PatternPack` is put together correctly. Check `pack.discovery[i].kind`, `pack.terminals[i].match.type`, `inputMapping.knownProperties`.
2. **Integration**, meaning you build an in-memory ts-morph project over `fixtures/<name>/*.ts`, run `createTypeScriptAdapter({ project, frameworks: [yourPack()] }).extractAll()`, and assert on the resulting `BehavioralSummary[]`: transition counts, status codes, isDefault flags, input roles, gaps (if the pack has `contractReading`), effects (for recognizer-only packs). Share the summaries via `beforeAll` so ts-morph setup runs once per file, and raise the hook timeout to 30s under turbo concurrency.

See `packages/framework/ts-rest/src/index.test.ts` for a discovery-driven pack with contract reading, `packages/framework/express/src/index.test.ts` for one without, and `packages/runtime/node/src/scheduling.test.ts` for a recognizer-only pack.

Once the pack runs against a project, `suss extract --explain` prints a health block that says which stage it stopped at. [Why a pack found nothing](pack-health.md) covers what each code means.

## What you don't need to know

A pack author doesn't need to understand:

- How ts-morph works (beyond using the handles passed to recognizers / sub-units).
- How condition extraction works.
- How the extraction engine assembles summaries.
- How any other pack works.

That's the whole point of the declarative design. A pattern you can only express by reaching past the pack's own directory into the engine is a gap in the pattern system, so flag it rather than working around it in the pack.

## Where a pack gets registered

Your pack runs as soon as it is installed beside the project, whatever else you skip: `suss extract -f <name>` resolves `@suss/framework-<name>` and then `@suss/<name>` for a name it does not already know. The rest of this list decides how the pack is found rather than whether it works.

- `BUILTIN_FRAMEWORKS` in `packages/cli/src/extract.ts`, and a dependency on your package in `packages/cli/package.json`. Together these bundle the pack with the CLI, so `-f <name>` resolves for somebody who installed the CLI alone. Every shipped pack is here.
- The dependency table in `packages/cli/src/init.ts`. This is what makes `suss init` suggest your pack when it sees the library in a project's `package.json`. A pack nobody suggests still runs when it is asked for by name.
- `scripts/coverage-packages.mjs`, so the coverage gate reads your package.
- `docs/reference/packages.md`, and the package counts in `CONTRIBUTING.md`, `docs/internal/releasing.md` and `docs/internal/dogfooding.md`.

The counts are maintained by hand today and go stale on their own.

## Anatomy of a framework pack: ts-rest

The ts-rest pack (`packages/framework/ts-rest/src/index.ts`) is a discovery-driven framework pack with contract reading. Walking through its fields:

### Discovery

```typescript
discovery: [
  {
    kind: "handler",
    match: {
      type: "registrationCall",
      importModule: "@ts-rest/express",
      importName: "initServer",
      registrationChain: [".router"],
    },
    bindingExtraction: {
      method: { type: "fromContract" },
      path: { type: "fromContract" },
    },
  },
],
```

ts-rest handlers are registered via `initServer().router(contract, handlers)`, where each property in `handlers` is a route handler function. The discovery pattern says: look for a `registrationCall` chain starting from an `initServer` import, follow the `.router` method call, and extract handler functions from the last argument. The HTTP method and path come from the contract, not from the handler code.

### Terminals

```typescript
terminals: [
  {
    kind: "response",
    match: {
      type: "returnShape",
      requiredProperties: ["status", "body"],
    },
    extraction: {
      statusCode: { from: "property", name: "status" },
      body: { from: "property", name: "body" },
    },
  },
],
```

A ts-rest handler produces responses by returning `{ status, body }` objects. The `returnShape` matcher requires both properties, which avoids matching arbitrary object literals. Once matched, status and body are pulled from their respective properties.

### Contract reading

```typescript
contractReading: {
  discovery: {
    importModule: "@ts-rest/core",
    importName: "initContract",
    registrationChain: [".router"],
  },
  responseExtraction: { property: "responses" },
  paramsExtraction: { property: "pathParams" },
},
```

ts-rest contracts are separate files that declare expected responses. The pack tells the adapter where to find them and where to read responses and params. The adapter reads the contract and produces `RawDeclaredContract`, which the extractor uses for gap detection.

### Input mapping

```typescript
inputMapping: {
  type: "destructuredObject",
  knownProperties: {
    params: "pathParams",
    body: "requestBody",
    query: "queryParams",
    headers: "headers",
  },
},
```

ts-rest handlers receive a destructured object: `({ params, body, query }) => { ... }`. Each property name maps to a semantic role. The role ends up on `Input.role`, which downstream tools use to correlate inputs across services, "the consumer's `pathParams.id` matches the provider's `pathParams.id`".

## Anatomy of a runtime pack: runtime-node

The runtime-node pack (`packages/runtime/node/src/`) is recognizer-only. It has no `discovery` and no `terminals`. Its job is to fire on calls and property accesses inside whatever unit other packs (Express handlers, React components, etc.) have already discovered.

### Pack declaration

```typescript
return {
  name: "node",
  protocol: "in-process",
  languages: ["typescript", "javascript"],
  discovery: [],
  terminals: [],
  inputMapping: { type: "positionalParams", params: [] },
  invocationRecognizers: [schedulingRecognizer],
  accessRecognizers: [
    processSurfaceRecognizer,
    importMetaRecognizer,
    fileLocationRecognizer,
  ],
  subUnits: nodeSchedulingSubUnits,
};
```

`discovery: []` and `terminals: []` are explicit no-ops, because runtime-node doesn't claim any unit. The interface requires `inputMapping`, but nothing uses it here. The work happens in the three recognizer fields plus `subUnits`.

### Invocation recognizer

`schedulingRecognizer` fires on every `CallExpression` the adapter walks. It checks whether the call is one of `setImmediate`, `setTimeout`, `setInterval`, `queueMicrotask`, or `process.nextTick`, and if so emits an `interaction` effect with `class: "schedule"`:

```typescript
export const schedulingRecognizer: InvocationRecognizer = (call, _ctx) => {
  const c = call as CallExpression;
  if (!Node.isCallExpression(c)) return null;
  const primitive = recognizePrimitive(c);
  if (primitive === null) return null;

  const callback = describeCallback(c.getArguments()[0]);
  // ... build callbackRef ...

  const effect: Effect = {
    type: "interaction",
    binding: functionCallBinding({
      transport: "in-process",
      recognition: "@suss/runtime-node",
    }),
    callee: c.getExpression().getText(),
    interaction: {
      class: "schedule",
      via: primitive.via,
      callbackRef,
      hasDelay: primitive.hasDelayArg && c.getArguments().length >= 2,
    },
  };
  return [effect];
};
```

The recognizer returns `null` for any call that isn't a scheduling primitive. The adapter dispatches every CallExpression to every recognizer; a recognizer's only job is "is this my call? If yes, emit; if no, return null."

One more rule applies on top of that: a recognizer that matched records the crossing. When the code does not give an identity field, write null:

```typescript
// QueueUrl came from a variable. The send still happened.
messageBusBinding({
  recognition: "@suss/framework-aws-sqs",
  messageBus: "aws_sqs",
  channel: null,
});
```

Returning `null` from the recognizer means only "not my call". A field the pack could not read is a different thing, so record the crossing and leave the field null. The builders throw on an empty string. Three packs each broke this rule a different way, and every one made a crossing disappear from the summaries.

### Access recognizer

`processSurfaceRecognizer` fires on `PropertyAccessExpression` and `ElementAccessExpression` nodes. It recognizes `process.argv`, `process.cwd`, `process.platform`, `process.argv[N]`, etc., but skips `process.env.X`, which the sibling `envVarRecognizer` in the same pack owns. The two recognizers split the `process.*` space between them, with no overlap:

```typescript
function recognizeProperty(node, deploymentTarget, instanceName): Effect[] | null {
  if (isProcessEnvVarRead(node)) return null;  // sibling envVarRecognizer owns these

  const subject = node.getExpression();
  const name = node.getName();

  if (isProcessIdentifier(subject) && name === "argv") {
    return [argvRead(deploymentTarget, instanceName, node.getText(), null)];
  }
  if (isProcessIdentifier(subject) && OPAQUE_PROPERTY_NAMES.has(name)) {
    return [opaqueProcessRead(node.getText(), `process.${name}`)];
  }
  return null;
}
```

The pattern is the same as for invocation recognizers: the adapter dispatches every access to every recognizer, and a recognizer returns `null` for accesses it doesn't claim.

### Sub-units

`nodeSchedulingSubUnits` walks a parent unit's body looking for scheduling calls whose first argument is an inline function expression. For each one, it synthesizes a `scheduled-callback` sub-unit:

```typescript
export function nodeSchedulingSubUnits(
  parent: DiscoveredSubUnitParent,
  _ctx: unknown,
): DiscoveredSubUnit[] {
  const out: DiscoveredSubUnit[] = [];
  parent.func.forEachDescendant((node, traversal) => {
    if (/* nested function body */) { traversal.skip(); return; }
    if (!Node.isCallExpression(node)) return;
    const primitive = recognizePrimitive(node);
    if (primitive === null) return;
    const arg = node.getArguments()[0];
    if (!isInlineFunction(arg)) return;

    out.push({
      func: arg,
      kind: "scheduled-callback",
      name: `${parent.name}.${primitive.via}#${idx}`,
      inputMapping: SCHEDULED_CALLBACK_INPUT,
      metadata: { node: { schedulingPrimitive: primitive.via } },
    });
  });
  return out;
}
```

The synthesized sub-unit flows through the adapter's normal pipeline: it gets terminals + effects extracted, recognizers fire on its body, and it produces its own `BehavioralSummary`. Identifier-referenced callbacks (`setTimeout(handleTick, 1000)` where `handleTick` is a function declared elsewhere) emit no sub-unit, and the recognizer's effect includes the identifier name for inspect to render instead.

### Why no `requiresImport` here

runtime-node is universal, because `setTimeout` works without importing anything. Other recognizer-only packs that target a specific library should declare `requiresImport`:

```typescript
// in @suss/framework-aws-sqs
requiresImport: ["@aws-sdk/client-sqs"],
```

This tells the adapter's pre-filter to only consider this pack applicable to source files importing one of the listed modules. Without it, a recognizer-only pack walks every file in the project. That still gives the right answer, but it is wasted work in monorepos where most files don't import the library.

## A worked example: the Fastify pack

The shipped Fastify pack lives in [`packages/framework/fastify/`](https://github.com/nimbuscloud-ai/suss/tree/main/packages/framework/fastify), read it alongside this section. Fastify handlers look like:

```typescript
import Fastify from "fastify";

const app = Fastify();

app.get("/users/:id", async (request, reply) => {
  const user = await db.findById(request.params.id);
  if (!user) {
    return reply.code(404).send({ error: "not found" });
  }
  return reply.send(user);
});
```

Walking through the four questions:

**Discovery.** Handlers are registered via `app.<verb>("/path", handler)` where `app` is the result of calling the imported `Fastify` (or named-import `fastify`). This is a `registrationCall` pattern. The pack ships two discovery entries, one for the default-import form (`importName: "Fastify"`) and one for the named-import form (`importName: "fastify"`), because `defaultImport.getText() === match.importName` matches against the local binding name.

```typescript
discovery: [
  {
    kind: "handler",
    match: {
      type: "registrationCall",
      importModule: "fastify",
      importName: "Fastify",
      registrationChain: [".get", ".post", ".put", ".delete", ".patch", ".head", ".options"],
    },
    bindingExtraction: {
      method: { type: "fromRegistration", position: "methodName" },
      path: { type: "fromRegistration", position: 0 },
    },
  },
  // ...same shape with importName: "fastify" for the named-import form
],
```

**Terminals.** Responses are produced via `reply.code(N).send(body)`, `reply.status(N).send(body)`, or implicit-200 `reply.send(body)`. Plus `reply.redirect(...)` and `throw`. Each becomes a `parameterMethodCall` matcher on parameter position 1 (`reply`):

```typescript
terminals: [
  {
    kind: "response",
    match: { type: "parameterMethodCall", parameterPosition: 1, methodChain: ["code", "send"] },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 0 },
    },
  },
  {
    kind: "response",
    match: { type: "parameterMethodCall", parameterPosition: 1, methodChain: ["send"] },
    extraction: {
      body: { from: "argument", position: 0 },
      defaultStatusCode: 200, // implicit 200 for bare reply.send()
    },
  },
  // ...status-aliased and redirect variants
  {
    kind: "throw",
    match: { type: "throwExpression" },
    extraction: {},
  },
],
```

The `defaultStatusCode: 200` field is important: without it the implicit-200 chain (`reply.send(body)`) would emit a transition with `statusCode: null`, and inspect would render `???`. The pack declares the framework-level default and the adapter applies it when extraction can't pull a numeric value from the call.

**Inputs.** Fastify's handler signature is `(request, reply) => ...`, positional:

```typescript
inputMapping: {
  type: "positionalParams",
  params: [
    { position: 0, role: "request" },
    { position: 1, role: "reply" },
  ],
},
```

**Contracts.** Fastify supports JSON Schema validation attached to route options inline with the handler. v0 doesn't declare a `contractReading` and relies on inferred transitions alone.

**Bare `return value` bodies.** Fastify also lets handlers serialise a returned value as the response body (`return user` or `return { id, name }`). The pack covers that path with a `returnStatement` terminal that uses `excludeCallReturns: true`, so `return reply.send(...)` (already a `parameterMethodCall` match) doesn't double-fire. Bare `return;` exits, the kind that follow `reply.code(404).send(...)` early-return guards, are skipped, because they don't produce a value.

The whole pack is ~120 lines of declarative data plus an integration test against an in-memory ts-morph project.
