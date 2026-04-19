# Framework Packs

A framework pack teaches suss how to find and interpret code written for a specific framework — ts-rest, React Router, Express, FastAPI, etc. Packs are **declarative data**: a `PatternPack` object describing patterns. The language adapter interprets the patterns against the AST.

This document is for people writing or modifying framework packs. If you're using an existing pack, see `docs/architecture.md`.

**Scope today: HTTP.** Every shipping pack describes an HTTP boundary (REST semantics). The pack shape reflects that — `statusCode`, `body`, and response-property mappings are HTTP-biased. When a non-HTTP boundary semantics lands (GraphQL, Lambda-invoke, queue messages, React render), the pack interface grows per-semantics extensions rather than stretching the HTTP vocabulary. See [`boundary-semantics.md`](boundary-semantics.md) for the layered transport / semantics / recognition model this is heading toward.

## What a pack describes

A pack answers four questions about a framework:

1. **Discovery**: How do I find handlers/loaders/components in source files?
2. **Terminals**: What does a response or output look like?
3. **Inputs**: How are inputs delivered to the handler?
4. **Contracts**: *(optional)* If the framework has declared contracts, how do I read them?

The `PatternPack` shape:

```typescript
interface PatternPack {
  name: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
}
```

## Anatomy of a pack

Let's walk through the ts-rest pack (`packages/framework/ts-rest/src/index.ts`) piece by piece.

### Protocol

Every pack declares a `protocol` string, used as the default `BoundaryBinding.protocol` for discovered units. `protocol` identifies the *transport class* — what shape the boundary crosses — not the framework itself (that's `BoundaryBinding.framework`, which comes from `pack.name`).

Conventions shipped today:

- **`"http"`** — any HTTP-transported boundary. REST APIs (ts-rest, Express, Fastify, React Router), HTTP clients (fetch, axios), OpenAPI / CloudFormation stubs describing HTTP endpoints. GraphQL-over-HTTP also uses `"http"` when it lands — the distinguishing semantics will live on a sibling field once `BoundarySemantics` is formalised.
- **`"in-process"`** — boundaries that don't cross a network hop. React components (component ↔ DOM, render ↔ handler), custom hooks, intra-module cross-unit calls. Anything whose runtime is the language itself.

Frameworks with new transport classes introduce new protocol strings. Plausible future values:

- `"aws-sdk"` — AWS SDK calls where the transport-level envelope (`StatusCode`, `FunctionError`, `Payload`) is distinct from HTTP even though it rides HTTPS.
- `"queue"` — message-queue boundaries (Kafka, SQS, SNS) where pairing is by topic, not URL.
- `"grpc"` — gRPC calls; gRPC status codes live in a separate code space from HTTP.

Rule of thumb: if your pack's pairing shape and payload semantics match an existing protocol's, reuse the string. If they don't, pick a new string that reads as "transport class," not as "framework name." React isn't a protocol (it has no wire format); `"in-process"` names what the boundary *is*.

Note: `protocol` is a v0 shorthand. The `BoundarySemantics` refactor ([`docs/boundary-semantics.md`](boundary-semantics.md)) will eventually split transport from semantics as separate fields on `BoundaryBinding`. Current pack declarations remain valid when that lands — the new shape is strictly additive.

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

ts-rest handlers are registered via `initServer().router(contract, handlers)`, where each property in `handlers` is a route handler function. The discovery pattern says:

- **`kind: "handler"`** — what kind of code unit this discovers. This becomes `BehavioralSummary.kind`.
- **`match.type: "registrationCall"`** — look for a registration call chain starting from a specific import.
- **`match.importModule / importName`** — find an import of `initServer` from `@ts-rest/express`.
- **`match.registrationChain: [".router"]`** — from the import, follow method calls matching this chain. The handlers are in the *last argument* of `.router()`.
- **`bindingExtraction`** — the HTTP method and path come from the contract, not from the handler code.

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

A ts-rest handler produces responses by returning `{ status, body }` objects. The terminal pattern says:

- **`kind: "response"`** — what *kind of output* this terminal produces (not how to match it). This maps to `Output.type`.
- **`match.type: "returnShape"`** — match `ReturnStatement` nodes whose expression is an object literal.
- **`match.requiredProperties`** — only match if the object has all of these properties. This is how we avoid matching *any* return of an object literal.
- **`extraction.statusCode / body`** — once matched, pull out the status code and body fields. `{ from: "property", name: "status" }` reads the `status` property of the returned object.

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

ts-rest contracts are separate files that declare expected responses. The pack tells the adapter:

- **Where to find contracts** — look for `initContract().router(...)` from `@ts-rest/core`.
- **Where to read responses** — the `responses` property of each route definition.
- **Where to read params** — the `pathParams` property.

The adapter reads the contract and produces `RawDeclaredContract`, which the extractor uses for gap detection.

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

ts-rest handlers receive a destructured object: `({ params, body, query }) => { ... }`. The pack maps each property name to a semantic role. The `role` ends up on `Input.role`, which downstream tools use to correlate inputs across services — "the consumer's `pathParams.id` matches the provider's `pathParams.id`".

## Pattern reference

### `DiscoveryMatch` variants

#### `namedExport`
```typescript
{ type: "namedExport"; names: string[] }
```
Find code units by exported name. Used by React Router (`loader`, `action`, `default`), Next.js App Router (`GET`, `POST`, etc.), SvelteKit (`load`).

#### `registrationCall`
```typescript
{
  type: "registrationCall";
  importModule: string;
  importName: string;
  registrationChain: string[];
}
```
Find code units registered via a call chain starting from an import. Used by ts-rest (`initServer().router`), Express (`express.Router().get`), Fastify (`fastify.register`).

The `registrationChain` is a list of method/property accesses to follow from the import. The adapter walks each import reference, follows the chain, and extracts handler functions from the chain's endpoint.

#### `decorator`
```typescript
{ type: "decorator"; decoratorModule: string; decoratorName: string }
```
Find functions with specific decorators. Used by FastAPI (`@app.get`), NestJS (`@Controller`, `@Get`), Flask-RESTful. *Primarily a Python / Python-adjacent pattern.*

#### `fileConvention`
```typescript
{ type: "fileConvention"; filePattern: string; exportNames: string[] }
```
Find code units by file path + expected export names. Used by Next.js App Router (`app/**/route.ts` with `GET`/`POST` exports), SvelteKit (`+page.server.ts` with `load`/`actions`).

#### `clientCall`
```typescript
{
  type: "clientCall";
  importModule: string;  // or "global" for built-ins like fetch
  importName: string;    // e.g. "initClient", "fetch"
  methodFilter?: string[];
}
```
Find client call sites — the consumer side of a boundary. The adapter finds imports of `importName` from `importModule`, resolves variables initialized from that import, and walks their method calls. For globals like `fetch`, all bare calls to `importName` match. If `methodFilter` is set, only calls to those methods are discovered. The enclosing function becomes the code unit (kind `"client"`).

Used by ts-rest (`initClient` from `@ts-rest/core`) and `@suss/runtime-web` (`fetch` as global).

#### `packageExports`
```typescript
{
  type: "packageExports";
  packageJsonPath: string;     // absolute path
  subPaths?: string[];         // filter (default: all)
  excludeNames?: string[];     // e.g. ["default"]
}
```
Treat a TypeScript package's public export surface as a boundary. The adapter reads the given `package.json`, resolves every reachable entry point (root `.` plus any sub-path `exports` like `./schemas`), follows barrel re-exports through `ts-morph`, and emits one unit per exported function — provider side of an in-process `function-call` boundary.

Produced bindings carry the stronger identity
`{ transport: "in-process", semantics: { name: "function-call", package, exportPath }, recognition: <pack.name> }`,
so sub-path exports identify as e.g. `@suss/behavioral-ir/schemas::BehavioralSummarySchema` (`exportPath = ["schemas", "BehavioralSummarySchema"]`). Root exports omit the sub-path segment.

Used by the dogfood script — see `docs/internal/dogfooding.md` — to publish per-package contracts to `dist/suss-summaries.json`. The consumer half (cross-boundary checking against `import { fn } from "pkg"` sites) is not shipped yet; providers pair in the `function-call` direction once it lands.

v0 scope: resolves the `types` / `default` / `import` conditions on `exports`, falls back to `types` + `main` + `module` when no `exports` field is set. Pattern exports (`./utils/*`) and `development`-conditional resolution are deferred and surface as warnings on the resolver result.

### `BindingExtraction`

How to derive the HTTP method and path from a discovered code unit:

```typescript
{
  method:
    | { type: "fromRegistration"; position: "methodName" | number }
    | { type: "fromExportName" }       // Next.js: export name IS the method
    | { type: "fromContract" }         // ts-rest: method comes from contract
    | { type: "literal"; value: string };
  path:
    | { type: "fromRegistration"; position: number }
    | { type: "fromFilename" }         // file-based routing
    | { type: "fromContract" };
}
```

- **`fromRegistration`** — extract from the registration call. `position: "methodName"` means the method *is* the HTTP method (`app.get` → `"GET"`). `position: 0` means it's the first argument.
- **`fromExportName`** — the export name *is* the HTTP method. Next.js App Router convention.
- **`fromContract`** — both method and path live in a separate contract definition.
- **`fromClientMethod`** — the method or path is derived from the client call site's method name via the contract. Used by ts-rest client discovery: `client.getUser(...)` resolves `getUser` back through the contract to find `method: "GET"`, `path: "/users/:id"`.
- **`fromArgumentLiteral`** — the path is a string literal at a given argument position. Used by `@suss/runtime-web`: `fetch("/users")` extracts `"/users"` from argument 0.
- **`fromArgumentProperty`** — the method is a property on an options argument. Used by `@suss/runtime-web`: `fetch(url, { method: "POST" })` extracts `"POST"` from argument 1, property `method`. Supports a `default` value (e.g., `"GET"` when no options are passed).
- **`fromFilename`** — file-based routing (React Router, Next.js, SvelteKit). The adapter derives the path from the file path.
- **`literal`** — hard-code the value. React Router loaders are always `GET`.

### `TerminalMatch` variants

#### `returnShape`
```typescript
{ type: "returnShape"; requiredProperties?: string[] }
```
Match `ReturnStatement` with an object literal. If `requiredProperties` is set, the object must have all of them. Used by ts-rest (`{ status, body }`), Next.js App Router Response (`Response.json(...)`).

#### `parameterMethodCall`
```typescript
{
  type: "parameterMethodCall";
  parameterPosition: number;
  methodChain: string[];
}
```
Match method calls on a specific parameter. Used by Express (`res.status(200).json(...)`) and similar. The `methodChain` is the sequence of method names — an empty chain means any call, `["json"]` matches `res.json(...)`, `["status", "json"]` matches `res.status(...).json(...)`.

#### `throwExpression`
```typescript
{ type: "throwExpression"; constructorPattern?: string }
```
Match `throw` statements. If `constructorPattern` is set, the thrown expression must match it textually. Used by React Router (`throw httpErrorJson(...)`), custom HTTP error libraries.

#### `functionCall`
```typescript
{ type: "functionCall"; functionName: string }
```
Match calls to a named function (not a method on an object). Used by React Router (`json(data)`, `data(value)`, `redirect(url)`). Only matches bare `Identifier` callees — `res.json(...)` won't match a `functionName: "json"` pattern because the callee is a property access, not an identifier.

#### `returnStatement`
```typescript
{ type: "returnStatement" }
```
Match any `ReturnStatement`, regardless of what's being returned. Used by client code units where the consumer function returns arbitrary values (not structured `{ status, body }` objects). The return value is captured as `Output.return`. Every client pack uses this as its primary terminal.

### `TerminalExtraction`

Once a terminal is matched, how to pull out the status code and body:

```typescript
{
  statusCode?:
    | { from: "property"; name: string }                              // { status: 200 } → "status"
    | { from: "argument"; position: number; minArgs?: number }        // res.status(200) → position: 0
    | { from: "constructor"; codes: Record<string, number> };         // throw new NotFound() → 404 via { NotFound: 404 }
  body?:
    | { from: "property"; name: string }                              // { body: data } → "body"
    | { from: "argument"; position: number; minArgs?: number };       // res.json(data) → position: 0
}
```

Both fields are optional — not all terminals have a body (e.g., `void`), and not all have a status code (e.g., `res.send("hi")` is implicitly 200).

The **`minArgs`** field handles overloaded call signatures where the same argument position means different things depending on arity. For example, Express `res.redirect(url)` has a URL at position 0, but `res.redirect(301, url)` has a status code at position 0. Setting `minArgs: 2` tells the adapter to only extract from position 0 when the call has at least 2 arguments.

The **`{ from: "constructor"; codes }`** case maps constructor names to status codes for HTTP error libraries that encode the code in the exception type. Matching is:

1. **Full-text first.** Given `throw new HttpError.NotFound()`, the adapter looks up `codes["HttpError.NotFound"]`.
2. **Last dot-segment fallback.** If the full name misses, it tries the final segment: `codes["NotFound"]`. This lets packs write `{ NotFound: 404 }` once and have it work for both bare `NotFoundError` and namespaced `createError.NotFound` styles.

Only `throwExpression` matchers carry an exception type, so `from: "constructor"` is a no-op for other matcher types (it returns null rather than guessing).

### `InputMappingPattern` variants

#### `singleObjectParam`
```typescript
{
  type: "singleObjectParam";
  paramPosition: number;
  knownProperties: Record<string, string>;
}
```
The handler takes a single object parameter. `knownProperties` maps property names to semantic roles. Used by React Router (`({ request, params, context }) => ...`).

#### `positionalParams`
```typescript
{
  type: "positionalParams";
  params: Array<{ position: number; role: string }>;
}
```
The handler takes positional parameters with fixed roles. Used by Express (`(req, res, next) => ...`).

#### `destructuredObject`
```typescript
{
  type: "destructuredObject";
  knownProperties: Record<string, string>;
}
```
Like `singleObjectParam` but always destructured at position 0. Used by ts-rest. The semantic distinction from `singleObjectParam` is that the framework *always* destructures — there's no case where the handler takes the whole object as a single value.

## Contributing a new pack

### Step 1 — Create the package

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

The quickest way is to copy an existing pack directory and rename. Each pack is 50-80 lines of declarative data plus a small test file.

### Step 2 — Answer the four questions

Before writing code, write down:

1. **Discovery**: Describe in one sentence how you'd find handlers by reading the source. "They're exported as a function named `loader`." Or: "They're methods on an object passed to `router(contract, ...)`." Pick the `DiscoveryMatch` variant that fits.
2. **Terminals**: What does producing a response look like? `return { status, body }`? `res.json(...)`? `throw new HttpError(...)`? Pick the matching `TerminalMatch` variant.
3. **Inputs**: What does the handler's signature look like? `(req, res, next)`? `({ params, body })`? `({ request, params })`? Pick the matching `InputMappingPattern` variant.
4. **Contracts** *(optional)*: Does the framework have declarative contracts? If so, where do they live and how are they structured?

If an existing pattern variant doesn't fit, talk to the maintainers before adding a new one — extending the pattern types has ripple effects through the adapter.

### Step 3 — Write the pack as a function

```typescript
import type { PatternPack } from "@suss/extractor";

export function myFramework(): PatternPack {
  return {
    name: "my-framework",
    languages: ["typescript"],
    discovery: [/* ... */],
    terminals: [/* ... */],
    inputMapping: { /* ... */ },
  };
}

export default myFramework;
```

Export both a named function and a default for dynamic imports from the CLI.

**Shared discovery shape for HTTP servers.** Most Node HTTP frameworks register handlers the same way (`app.get(path, handler)` / `router.post(...)`) with variation only in the library name, the method list, and whether the library exports a default or named factory. `@suss/extractor` exposes `httpRouteDiscovery` so packs don't have to hand-write the repeated `registrationCall` + `bindingExtraction` shape per import name:

```typescript
import { httpRouteDiscovery } from "@suss/extractor";

discovery: httpRouteDiscovery({
  importModule: "express",
  importNames: ["Router", "express"],
  methods: [".get", ".post", ".put", ".delete", ".patch"],
}),
```

This emits one `DiscoveryPattern` per name with binding extraction (`method` from the registration method, `path` from argument 0) wired up. The Express and Fastify packs use this; anything with a different registration shape (`@ts-rest/express`'s `initServer().router()`, decorators, file-convention) should declare `discovery` entries directly.

### Step 4 — Write the tests

A pack test has two layers:

1. **Pack shape** — structural correctness of the returned `PatternPack`. Check `pack.discovery[i].kind`, `pack.terminals[i].match.type`, `inputMapping.knownProperties`.
2. **Integration** — build an in-memory ts-morph project over `fixtures/<framework>/*.ts`, run `createTypeScriptAdapter({ project, frameworks: [yourPack()] }).extractAll()`, and assert on the resulting `BehavioralSummary[]`: transition counts, status codes, isDefault flags, input roles, gaps (if the pack has `contractReading`). Share the summaries via `beforeAll` so ts-morph setup runs once per file — raise the hook timeout to 30s under turbo concurrency.

See `packages/framework/ts-rest/src/index.test.ts` for a pack with contract reading and `packages/framework/express/src/index.test.ts` for a pack without.

### What you don't need to know

A framework pack author doesn't need to understand:

- How ts-morph works
- How condition extraction works
- How the extraction engine assembles summaries
- How any other framework pack works

That's the whole point of the declarative design. If writing a new pack requires touching any file outside `packages/framework/<name>/`, the pattern system has a gap that needs a structural fix — don't work around it in the pack.

## A worked example: the Fastify pack

The shipped Fastify pack lives in [`packages/framework/fastify/`](https://github.com/nimbuscloud-ai/suss/tree/main/packages/framework/fastify) — read it alongside this section. Fastify handlers look like:

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

**Discovery.** Handlers are registered via `app.<verb>("/path", handler)` where `app` is the result of calling the imported `Fastify` (or named-import `fastify`). This is a `registrationCall` pattern. The pack ships two discovery entries — one for the default-import shape (`importName: "Fastify"`) and one for the named-import shape (`importName: "fastify"`) — because `defaultImport.getText() === match.importName` matches against the local binding name.

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

**Inputs.** Fastify's handler signature is `(request, reply) => ...` — positional:

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

**Limitations the pack documents.** Fastify also lets handlers serialise a returned value as the response body (`return user`). The current `TerminalExtraction` has no shape for "the whole returned expression as the body" — it can only read named properties of an object literal. So the Fastify pack doesn't match `return value` shapes today; users wanting full coverage write `return reply.send(value)` instead.

The whole pack is ~120 lines of declarative data plus an integration test against an in-memory ts-morph project.
