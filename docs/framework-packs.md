# Framework Packs

A framework pack teaches suss how to find and interpret code written for a specific framework — ts-rest, React Router, Express, FastAPI, etc. Packs are **declarative data**: a `FrameworkPack` object describing patterns. The language adapter interprets the patterns against the AST.

This document is for people writing or modifying framework packs. If you're using an existing pack, see `docs/architecture.md`.

## What a pack describes

A pack answers four questions about a framework:

1. **Discovery**: How do I find handlers/loaders/components in source files?
2. **Terminals**: What does a response or output look like?
3. **Inputs**: How are inputs delivered to the handler?
4. **Contracts**: *(optional)* If the framework has declared contracts, how do I read them?

The `FrameworkPack` shape:

```typescript
interface FrameworkPack {
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

### `TerminalExtraction`

Once a terminal is matched, how to pull out the status code and body:

```typescript
{
  statusCode?:
    | { from: "property"; name: string }                        // { status: 200 } → "status"
    | { from: "argument"; position: number; minArgs?: number }  // res.status(200) → position: 0
    | { from: "constructor" };                                  // new HttpError.NotFound → 404
  body?:
    | { from: "property"; name: string }                        // { body: data } → "body"
    | { from: "argument"; position: number; minArgs?: number }; // res.json(data) → position: 0
}
```

Both fields are optional — not all terminals have a body (e.g., `void`), and not all have a status code (e.g., `res.send("hi")` is implicitly 200).

The **`minArgs`** field handles overloaded call signatures where the same argument position means different things depending on arity. For example, Express `res.redirect(url)` has a URL at position 0, but `res.redirect(301, url)` has a status code at position 0. Setting `minArgs: 2` tells the adapter to only extract from position 0 when the call has at least 2 arguments.

The `{ from: "constructor" }` case is underspecified in v0 — it would need a mapping table of constructor names to status codes (`NotFound → 404`, `BadRequest → 400`). Left for when a framework actually needs it.

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
    index.ts           exports a function returning FrameworkPack
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
import type { FrameworkPack } from "@suss/extractor";

export function myFramework(): FrameworkPack {
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

### Step 4 — Write the tests

A pack test asserts structural correctness of the returned `FrameworkPack`, not extraction behavior. See `packages/framework/ts-rest/src/index.test.ts` for the shape: check that `pack.discovery[0].kind` is right, that `pack.terminals[0].match.type` is the expected variant, that `inputMapping.knownProperties` has the right role mappings.

Full extraction-against-fixtures testing lives in the adapter's integration tests, not in the pack's own tests. A pack is validated against real code in Phase 4 fixtures.

### What you don't need to know

A framework pack author doesn't need to understand:

- How ts-morph works
- How condition extraction works
- How the extraction engine assembles summaries
- How any other framework pack works

That's the whole point of the declarative design. If writing a new pack requires touching any file outside `packages/framework/<name>/`, the pattern system has a gap that needs to be filled properly — don't work around it in the pack.

## A worked example: adding Fastify support

Fastify handlers look like this:

```typescript
import Fastify from "fastify";

const fastify = Fastify();

fastify.get("/users/:id", async (request, reply) => {
  const user = await db.findById(request.params.id);
  if (!user) {
    return reply.code(404).send({ error: "not found" });
  }
  return reply.send(user);
});
```

Walking through the four questions:

**Discovery.** Handlers are registered via `fastify.get("/path", handler)` (and `.post`, `.put`, etc.). This is a `registrationCall` pattern:

```typescript
discovery: [
  {
    kind: "handler",
    match: {
      type: "registrationCall",
      importModule: "fastify",
      importName: "default",
      registrationChain: [".get", ".post", ".put", ".delete", ".patch"],
    },
    bindingExtraction: {
      method: { type: "fromRegistration", position: "methodName" },
      path: { type: "fromRegistration", position: 0 },
    },
  },
],
```

**Terminals.** Responses are produced via `reply.code(N).send(body)` or `reply.send(body)`, or by returning a value directly (Fastify serializes it). Three terminal patterns:

```typescript
terminals: [
  // reply.code(N).send(body)
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["code", "send"],
    },
    extraction: {
      statusCode: { from: "argument", position: 0 },
      body: { from: "argument", position: 0 },
    },
  },
  // reply.send(body) — implicit 200
  {
    kind: "response",
    match: {
      type: "parameterMethodCall",
      parameterPosition: 1,
      methodChain: ["send"],
    },
    extraction: {
      body: { from: "argument", position: 0 },
    },
  },
  // return value — implicit 200
  {
    kind: "response",
    match: { type: "returnShape" },
    extraction: {
      body: { from: "property", name: "" }, // whole return value
    },
  },
],
```

**Inputs.** Fastify uses `(request, reply) => ...` — positional:

```typescript
inputMapping: {
  type: "positionalParams",
  params: [
    { position: 0, role: "request" },
    { position: 1, role: "reply" },
  ],
},
```

**Contracts.** Fastify has JSON Schema-based validation schemas attached to route options, but they're not pre-declared elsewhere — the schema lives inline with the handler. For v0, skip contract reading and rely on inferred transitions alone.

That's the whole Fastify pack: ~60 lines. Plus a test file asserting the structure is well-formed, and a fixture in Phase 4 with a minimal Fastify handler + expected output.
