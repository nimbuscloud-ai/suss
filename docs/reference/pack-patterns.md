# Pack patterns

Reference for the `PatternPack` interface and every pattern variant a pack can use. For the conceptual overview of what packs are and how they're categorized, see [`packs.md`](../packs.md). For step-by-step instructions on writing a new pack, see [`guides/writing-a-pack.md`](../guides/writing-a-pack.md).

## The `PatternPack` interface

```typescript
interface PatternPack {
  name: string;
  /**
   * Pack version stamp, which feeds the cache invalidation key. Bump on
   * any change that affects discovered units / extracted summaries.
   * Optional: the CLI folds a hash of the pack file it loaded, and of
   * any config it passed, into this stamp, so a pack run through the
   * CLI invalidates warm caches on an edit either way.
   */
  version?: string;
  languages: string[];
  /**
   * Wire transport used in BoundaryBinding.transport of discovered units.
   * Required. Identifies the transport class — what shape the boundary
   * crosses — not the framework itself.
   */
  protocol: string;
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
  responseSemantics?: ResponsePropertyMapping[];
  invocationRecognizers?: InvocationRecognizer[];
  accessRecognizers?: AccessRecognizer[];
  subUnits?: (parent, ctx) => DiscoveredSubUnit[];
  discoverUnits?: (sourceFile, ctx) => DiscoveredCustomUnit[];
  requiresImport?: string[];
}
```

### Protocol

`protocol` identifies the *transport class*, what shape the boundary crosses, not the framework itself (that's `BoundaryBinding.recognition`, derived from `pack.name`).

Conventions in shipped packs:

- **`"http"`**: any HTTP-transported boundary. Covers REST APIs (e.g. ts-rest, Express, or React Router), HTTP clients (fetch and axios), GraphQL-over-HTTP (Apollo and NestJS GraphQL, distinguished by `BoundarySemantics`), and OpenAPI or CloudFormation contracts describing HTTP endpoints.
- **`"in-process"`**: boundaries that don't cross a network hop. React components, custom hooks, and package-export call sites.
- **`"queue"`**: message-queue boundaries. AWS SQS today; pairing is by topic, not URL.
- **`"storage"`**: database access boundaries. Prisma reads, writes, and selectors.

Frameworks with new transport classes introduce new protocol strings. Plausible future values include `"aws-sdk"` for AWS SDK calls (where the transport-level envelope is distinct from HTTP), or `"grpc"` for gRPC calls (whose status codes live in a separate code space from HTTP).

Rule of thumb: if your pack's pairing shape and payload semantics match an existing protocol's, reuse the string. If they don't, pick a new string that reads as "transport class," not as "framework name." React isn't a protocol (it has no wire format); `"in-process"` names what the boundary *is*.

The `BoundarySemantics` refactor ([`boundary-semantics.md`](../boundary-semantics.md)) splits transport from semantics as separate fields on `BoundaryBinding`. Current pack declarations remain valid as that work expands; the new shape is additive.

## `DiscoveryMatch` variants

### `namedExport`
```typescript
{ type: "namedExport"; names: string[] }
```
Find code units by exported name. Used by React Router (`loader`, `action`, `default`), Next.js App Router (`GET`, `POST`, etc.), and SvelteKit (`load`).

### `registrationCall`
```typescript
{
  type: "registrationCall";
  importModule: string;
  importName: string;
  registrationChain: string[];
}
```
Find code units registered via a call chain starting from an import. Used by ts-rest (`initServer().router`), Express (`express.Router().get`), and Fastify (`fastify.register`).

The `registrationChain` is a list of method/property accesses to follow from the import. The adapter walks each import reference, follows the chain, and extracts handler functions from the chain's endpoint.

### `decorator`
```typescript
{ type: "decorator"; decoratorModule: string; decoratorName: string }
```
Find functions or methods with specific decorators. Used by NestJS (`@Controller`, `@Get`, `@Resolver`, `@Query`) and Apollo (`@FieldResolver`). Also applies to Python frameworks like FastAPI (`@app.get`) and Flask-RESTful when a Python adapter exists.

### `fileConvention`
```typescript
{ type: "fileConvention"; filePattern: string; exportNames: string[] }
```
Find code units by file path and expected export names. Used by Next.js App Router (`app/**/route.ts` with `GET`/`POST` exports) and SvelteKit (`+page.server.ts` with `load`/`actions`).

### `clientCall`
```typescript
{
  type: "clientCall";
  importModule: string;  // or "global" for built-ins like fetch
  importName: string;    // e.g. "initClient", "fetch"
  methodFilter?: string[];
}
```
Find client call sites, the consumer side of a boundary. The adapter finds imports of `importName` from `importModule`, resolves variables initialized from that import, and walks their method calls. For globals like `fetch`, all bare calls to `importName` match. If `methodFilter` is set, only calls to those methods are discovered. The enclosing function becomes the code unit (kind `"client"`).

Used by ts-rest (`initClient` from `@ts-rest/core`), Apollo client (`useQuery` from `@apollo/client`), and `@suss/client-web` (`fetch` as global).

### `packageExports`
```typescript
{
  type: "packageExports";
  packageJsonPath: string;     // absolute path
  subPaths?: string[];         // filter (default: all)
  excludeNames?: string[];     // e.g. ["default"]
}
```
Treat a TypeScript package's public export surface as a boundary. The adapter reads the given `package.json`, resolves every reachable entry point (root `.` plus any sub-path `exports` like `./schemas`), follows barrel re-exports through `ts-morph`, and emits one unit per exported function, provider side of an in-process `function-call` boundary.

Produced bindings carry the stronger identity
`{ transport: "in-process", semantics: { name: "function-call", package, exportPath }, recognition: <pack.name> }`,
so sub-path exports identify as e.g. `@suss/behavioral-ir/schemas::BehavioralSummarySchema` (`exportPath = ["schemas", "BehavioralSummarySchema"]`). Root exports omit the sub-path segment.

Used by the dogfood script, see [`internal/dogfooding.md`](../internal/dogfooding.md), to write per-package contracts to `.suss/suss-summaries.json`. Paired against consumer-side summaries produced by `packageImport`.

v0 scope: resolves the `types` / `default` / `import` conditions on `exports`, falls back to `types` + `main` + `module` when no `exports` field is set. Pattern exports (`./utils/*`) and `development`-conditional resolution are deferred and surface as warnings on the resolver result.

### `packageImport`
```typescript
{
  type: "packageImport";
  packages: string[];  // exact module specifiers to match
}
```
Consumer side of the package-export boundary. Scans source files for imports of the named packages and records every call site; each enclosing function becomes one `caller`-kind code unit per imported binding it invokes. Produced bindings identify as `function-call { package, exportPath }` matching the `packageExports` providers, so the checker's `pairSummaries` pairs them by `fn:<package>::<exportPath>`.

Pass exact module specifiers (with any sub-path, e.g. `"@suss/behavioral-ir/schemas"`). Imports of any other package are ignored. Multiple call sites inside the same enclosing function to the same imported binding collapse to one unit; call sites to different bindings produce one unit each.

v0 scope: named and default imports with bare-identifier call expressions. Namespace imports (`import * as X`) and member-call chains (`X.method()`) are deferred.

## `BindingExtraction`

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

- **`fromRegistration`**: extract from the registration call. `position: "methodName"` means the method *is* the HTTP method (`app.get` → `"GET"`). `position: 0` means it's the first argument.
- **`fromExportName`**: the export name *is* the HTTP method. Next.js App Router convention.
- **`fromContract`**: both method and path live in a separate contract definition.
- **`fromClientMethod`**: the method or path is derived from the client call site's method name via the contract. Used by ts-rest client discovery: `client.getUser(...)` resolves `getUser` back through the contract to find `method: "GET"`, `path: "/users/:id"`.
- **`fromArgumentLiteral`**: the path is a string literal at a given argument position. Used by `@suss/client-web`: `fetch("/users")` extracts `"/users"` from argument 0.
- **`fromArgumentProperty`**: the method is a property on an options argument. Used by `@suss/client-web`: `fetch(url, { method: "POST" })` extracts `"POST"` from argument 1, property `method`. Supports a `default` value (e.g., `"GET"` when no options are passed).
- **`fromFilename`**: file-based routing (React Router, Next.js, SvelteKit). The adapter derives the path from the file path.
- **`literal`**: hard-code the value. React Router loaders are always `GET`.

## `TerminalMatch` variants

### `returnShape`
```typescript
{ type: "returnShape"; requiredProperties?: string[] }
```
Match `ReturnStatement` with an object literal. If `requiredProperties` is set, the object must have all of them. Used by ts-rest (`{ status, body }`) and Next.js App Router Response (`Response.json(...)`).

### `parameterMethodCall`
```typescript
{
  type: "parameterMethodCall";
  parameterPosition: number;
  methodChain: string[];
}
```
Match method calls on a specific parameter. Used by Express (`res.status(200).json(...)`) and similar. The `methodChain` is the sequence of method names, an empty chain means any call, `["json"]` matches `res.json(...)`, `["status", "json"]` matches `res.status(...).json(...)`.

### `throwExpression`
```typescript
{ type: "throwExpression"; constructorPattern?: string }
```
Match `throw` statements. If `constructorPattern` is set, the thrown expression must match it textually. Used for a project's own error helper and for custom HTTP error libraries.

### `functionCall`
```typescript
{ type: "functionCall"; functionName: string }
```
Match calls to a named function (not a method on an object). Used by React Router (`json(data)`, `data(value)`, `redirect(url)`). Only matches bare `Identifier` callees, `res.json(...)` won't match a `functionName: "json"` pattern because the callee is a property access, not an identifier.

### `returnStatement`
```typescript
{
  type: "returnStatement";
  excludeCallReturns?: boolean;
}
```
Match any `ReturnStatement`, regardless of what's being returned. Used by client code units where the consumer function returns arbitrary values (not structured `{ status, body }` objects). The return value is captured as `Output.return`. Every client pack uses this as its primary terminal.

`excludeCallReturns: true` skips both bare `return;` (control-flow exits with no value) and `return <call>` / `return new <Ctor>(...)`. Used by frameworks like Fastify where `return reply.send(...)` is already covered by a `parameterMethodCall` matcher and shouldn't double-fire here. `await` / `as` / parens / non-null wrappers around the call are unwrapped before the check, so `return await reply.send(...)` is also skipped. Bare value-returns (`return user`, `return { id }`, `return await db.find(id)`) still match.

When `extraction.defaultStatusCode` is set on a `kind: "response"` `returnStatement` terminal, the synthesised response uses that status. This is how Fastify maps `return user` to a 200 response.

## `TerminalExtraction`

Once a terminal is matched, how to pull out the status code and body:

```typescript
{
  statusCode?:
    | { from: "property"; name: string }                              // { status: 200 } → "status"
    | { from: "argument"; position: number; minArgs?: number }        // res.status(200) → position: 0
    | { from: "constructor"; codes: Record<string, number> }          // throw new NotFound() → 404 via { NotFound: 404 }
    | {
        from: "argumentConstructor";
        position: number;
        codes: Record<string, number>;
      };                                                              // throw wrap(new NotFound()) → 404 via the arg's class
  body?:
    | { from: "property"; name: string }                              // { body: data } → "body"
    | { from: "argument"; position: number; minArgs?: number };       // res.json(data) → position: 0
}
```

Both fields are optional, not all terminals have a body (e.g., `void`), and not all have a status code (e.g., `res.send("hi")` is implicitly 200).

The **`minArgs`** field handles overloaded call signatures where the same argument position means different things depending on arity. For example, Express `res.redirect(url)` has a URL at position 0, but `res.redirect(301, url)` has a status code at position 0. Setting `minArgs: 2` tells the adapter to only extract from position 0 when the call has at least 2 arguments.

The **`{ from: "constructor"; codes }`** case maps constructor names to status codes for HTTP error libraries that encode the code in the exception type. Matching is:

1. **Full-text first.** Given `throw new HttpError.NotFound()`, the adapter looks up `codes["HttpError.NotFound"]`.
2. **Last dot-segment fallback.** If the full name misses, it tries the final segment: `codes["NotFound"]`. This lets packs write `{ NotFound: 404 }` once and have it work for both bare `NotFoundError` and namespaced `createError.NotFound` styles.

Only `throwExpression` matchers carry an exception type, so `from: "constructor"` is a no-op for other matcher types (it returns null rather than guessing).

The **`{ from: "argumentConstructor"; position; codes }`** case is the wrapper-shaped variant: when the thrown expression wraps a constructed error (`throw wrap(new HttpError.NotFound("..."))`), the status sits on the *arg's* class, not the top-level thrown function. Set `position` to the arg's index in the wrapper call. Resolution uses the same full-text-first / last-segment fallback as `from: "constructor"`. Only `throwExpression` matchers reach this source, for other terminals it returns null.

For a returnShape terminal where no extraction explicitly selects a property, the body defaults to the full returned object's shape, the natural reading of "the returned object IS the body." Configure `body: { from: "property", name: "..." }` only when the body is one named property of a `{ status, body }` -style return object.

## `InputMappingPattern` variants

### `singleObjectParam`
```typescript
{
  type: "singleObjectParam";
  paramPosition: number;
  knownProperties: Record<string, string>;
}
```
The handler takes a single object parameter. `knownProperties` maps property names to semantic roles. Used by React Router (`({ request, params, context }) => ...`).

### `positionalParams`
```typescript
{
  type: "positionalParams";
  params: Array<{ position: number; role: string }>;
}
```
The handler takes positional parameters with fixed roles. Used by Express (`(req, res, next) => ...`).

### `destructuredObject`
```typescript
{
  type: "destructuredObject";
  knownProperties: Record<string, string>;
}
```
Like `singleObjectParam` but always destructured at position 0. Used by ts-rest. The semantic distinction from `singleObjectParam` is that the framework *always* destructures, there's no case where the handler takes the whole object as a single value.

## Recognizers

Recognizers fire on every relevant AST node inside a code unit's body, regardless of which pack discovered the unit. Two kinds:

```typescript
type InvocationRecognizer<TCtx = unknown> = (
  call: unknown,        // CallExpression handle (opaque at this level)
  ctx: TCtx,            // adapter context (TsRecognizerContext for TS)
) => Effect[] | null;

type AccessRecognizer<TCtx = unknown> = (
  access: unknown,      // PropertyAccessExpression handle
  ctx: TCtx,
) => Effect[] | null;
```

**`InvocationRecognizer`** fires on every `CallExpression` in the function body. **`AccessRecognizer`** fires on every `PropertyAccessExpression`. Both skip nested function bodies (those are their own units with their own recognizer dispatch).

Contract:

- **Cross-pack visibility.** Recognizers fire regardless of which pack discovered the enclosing function. `@suss/framework-prisma`'s recognizer can fire on Prisma calls inside an `@suss/framework-express` handler. Pack authors don't need to coordinate.
- **Emission semantics.** Returning effects ADDS them to the enclosing default-branch transition; the generic `invocation` effect is preserved either way. Returning `null` or `[]` is the no-match path.
- **Dedup is the recognizer's responsibility.** The dispatcher doesn't dedupe across calls. A recognizer that wants to fire once per identifier (e.g., to dedupe reads bound to a const used N times) tracks its own state across invocations.
- **Exceptions are caught.** A recognizer that throws is logged to stderr with file path + line number and skipped for that call; the extraction continues. Buggy recognizers don't crash the run.

The `ctx` parameter is the adapter's recognizer context. For TypeScript that's `TsRecognizerContext` (source file handle, `extractArgs()` helper). Recognizers cast both `call` / `access` and `ctx` to the adapter context they're written against, the cast is the explicit "this pack requires the TypeScript adapter" contract.

## Sub-units

The `subUnits` hook synthesizes additional code units from a parent unit's body, "one user-authored construct implicitly spawns multiple runtime-scheduled units." Used when a framework's runtime schedules callbacks that aren't visible as top-level declarations: React event handlers on JSX elements, React `useEffect` bodies, Node scheduling primitives, class-component lifecycle methods.

```typescript
subUnits?: (
  parent: DiscoveredSubUnitParent,
  ctx: unknown,
) => DiscoveredSubUnit[];

interface DiscoveredSubUnitParent {
  func: unknown;     // parent's function body handle (opaque here)
  name: string;      // discovered name (e.g. "Counter")
  kind: string;      // discovered kind (e.g. "component")
}
```

Returned units are fed through the adapter's extraction pipeline the same way top-level discovered units are. Each becomes its own `BehavioralSummary`. Carry per-unit `terminals` and `inputMapping` on the `DiscoveredSubUnit` if the sub-unit's shape differs from the parent pack's defaults.

## Custom discovery

The `discoverUnits` hook is the discovery-layer sibling of `subUnits`: when a framework's discovery convention doesn't fit one of the data-driven `DiscoveryMatch` variants, the pack ships its own walker. The adapter calls it once per source file alongside the data-driven dispatch.

```typescript
discoverUnits?: (sourceFile: unknown, ctx: unknown) => DiscoveredCustomUnit[];
```

Use this for framework-specific shapes that don't generalize: React's component-export heuristic (PascalCase + JSX-return), Vue's `.vue` SFC slots, Storybook's `.stories.tsx` file convention. Baking each into the central `DiscoveryMatch` union would force every unrelated pack to know about them.

When the callback discovers a unit at the same `(func, kind)` as one from another pack's data-driven discovery, the cross-pack claim dedup in the adapter keeps the first claimant. Pack ordering in the framework list is the precedence signal.

## `requiresImport`

```typescript
requiresImport?: string[];
```

Pack-level import gate. When set, the adapter's pre-filter only considers this pack applicable to source files whose imports include at least one of the listed modules (prefix match, `"@aws-sdk/client-sqs"` matches that module and any `"@aws-sdk/client-sqs/sub-path"`).

Useful for recognizer-only packs that target a specific library: `@suss/framework-aws-sqs` declares `["@aws-sdk/client-sqs"]`, `@suss/framework-prisma` declares `["@prisma/client"]`. Without a gate, recognizer-only packs walk every file in the project.

Discovery-pattern packs already have per-pattern `requiresImport` on `DiscoveryPattern`; this is the pack-level equivalent for packs whose only mechanism is recognizers. Empty / undefined means "no gate", the pack walks every file (the default for universal recognizers like runtime-node).
