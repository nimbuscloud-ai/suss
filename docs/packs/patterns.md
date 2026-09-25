---
title: Pack patterns
description: Every pattern variant a pack can use, the code each one matches, and the shipped pack that uses it.
---

# Pack patterns

Each variant a `PatternPack` can use is listed below, with the code it matches and a pack that uses it. For what a pack is and how a run loads one, see [What a pack is](/packs/what-a-pack-is). For building one, see [Write a pack](/packs/write-a-pack).

## The `PatternPack` interface

```typescript
interface PatternPack {
  name: string;
  protocol: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  inputMapping: InputMappingPattern;

  // Everything below is optional.
  version?: string;
  contractReading?: ContractPattern;
  responseSemantics?: ResponsePropertyMapping[];
  failureDelivery?: "response" | "exception";
  invocationRecognizers?: InvocationRecognizer[];
  accessRecognizers?: AccessRecognizer[];
  subUnits?: (parent, ctx) => DiscoveredSubUnit[];
  discoverUnits?: (sourceFile, ctx) => DiscoveredCustomUnit[];
  requiresImport?: string[];
  projectHelpers?: ProjectHelpers;
  transparentWrappers?: TransparentWrapper[];
  environmentObjects?: string[];
  libraryEnvVars?: Array<{ module: string; prefixes?: string[]; names?: string[] }>;
  discoveryInputs?: (files: readonly string[]) => string[];
  declarations?: PackDeclarations;
}
```

### Protocol

`protocol` is the transport class the boundary crosses. The framework is recorded separately, in `BoundaryBinding.recognition`, which comes from `pack.name`.

The shipped packs use these strings:

- `"http"`, any HTTP-transported boundary: REST providers and clients, GraphQL over HTTP, OpenAPI and CloudFormation contracts.
- `"in-process"`, boundaries with no network hop: React components, package-export call sites, Node's own runtime surface.
- `"queue"`, message-queue boundaries, which pair by channel.
- `"storage"`, database and object-store access.

Reuse a string when your pack pairs the way an existing protocol pairs and its payloads mean the same things. Otherwise pick a new one that describes a transport instead of a library. React is not a protocol, because it has no wire format, so a React boundary uses `"in-process"`. [Boundary semantics](/theory/boundary-semantics) explains how transport and semantics are kept apart.

## `DiscoveryMatch` variants

### `registrationCall`

```typescript
{
  type: "registrationCall";
  importModule: string;
  importName: string;
  registrationChain: string[];
}
```

`registrationCall` matches a unit registered through a call chain that starts from an import. Most HTTP frameworks work this way. The adapter walks each reference to the import, follows the chain, and takes the handler functions off the end of it.

```ts
const app = express();
app.get("/users/:id", handler);   // importName "express", chain [".get"]
```

Express, Fastify and Hono all build this through `httpRouteDiscovery`, which emits one pattern per exported name plus the loop pattern below. ts-rest declares it directly, for `initServer().router(contract, handlers)`.

### `registrationLoop`

```typescript
{
  type: "registrationLoop";
  elementShape: { methodKey: string; pathKey: string; handlerKey: string };
  receiver?: { importModule: string; importNames: string[] };
}
```

`registrationLoop` covers routes registered by looping over an array of specs, which registration-call discovery cannot see.

```ts
for (const route of routes) {
  app[route.method](route.path, route.handler);
}
```

`receiver` ties the loop to a variable built from the same import the calls use, so an unrelated loop in a file that happens to import the library is left alone. `httpRouteDiscovery` adds this for every HTTP pack.

### `registrationTemplate`

```typescript
{
  type: "registrationTemplate";
  helperName: string;
  importModule?: string;
  subject?: { argument: number; importModule: string; importNames: string[] };
  registrations: Array<{ method: string; pathTemplate: string; handlerArg: string }>;
}
```

`registrationTemplate` expands one call to a project's own helper into the several routes it registers.

```ts
registerCrud(app, "users", userHandlers);
```

`{N}` in `pathTemplate` and `handlerArg` substitutes the call's Nth argument, and `{N}.prop` reads a property off it. No pack writes these by hand. `routeHelperIndex` reads the helper's body before extraction and emits one template per route it finds. Express, Fastify and Hono cover a project's own route helpers this way.

### `namedExport`

```typescript
{ type: "namedExport"; names: string[] }
```

`namedExport` finds units by their exported name.

```ts
export async function loader({ params }) { ... }
```

React Router uses it for `loader`, `action` and `default`, and the React pack uses it for `default`.

### `fileConvention`

```typescript
{ type: "fileConvention"; filePattern: string; exportNames: string[] }
```

`fileConvention` picks out units by where the file is and what it exports. Next.js uses it twice: `**/app/**/route.{ts,tsx,js,jsx,mts,mjs}` exporting `GET`, `POST` and the rest, and `**/pages/api/**/*` exporting `default`.

### `decoratedRoute`

```typescript
{
  type: "decoratedRoute";
  importModule: string | string[];
  classDecorators: string[];
  methodDecoratorRouteMap: Record<string, string>;
}
```

`decoratedRoute` matches route handlers written as decorated methods on a decorated class.

```ts
@Controller("users")
class UsersController {
  @Get(":id")
  find(@Param("id") id: string) { ... }
}
```

The path comes from both decorators together, so the pair above gives `/users/:id`, and a constant passed by name resolves to the string it was written with. The file has to import at least one of the method decorators from `importModule` or nothing in it is discovered. NestJS REST declares it with `{ Get: "GET", Post: "POST", ... }`. NestJS microservices declares it for `@EventPattern` and `@MessagePattern`.

### `decoratedMethod`

```typescript
{
  type: "decoratedMethod";
  importModule: string | string[];
  classDecorators: string[];
  methodDecorators: string[];
  methodDecoratorTypeMap: Record<string, string>;
}
```

`decoratedMethod` finds GraphQL resolvers written as decorated methods, the way NestJS declares them. It selects units the same way `decoratedRoute` does, then reads a resolver from each one.

```ts
@Resolver(() => User)
class UserResolver {
  @Query(() => User)
  user(@Args("id") id: string) { ... }

  @ResolveField()
  posts(@Parent() user: User) { ... }
}
```

`methodDecoratorTypeMap` is for the decorators that set their own type. `@Query` puts its field on the root `Query` type however the class is decorated, so it goes in the map. `@ResolveField` needs the class to say which type, so it is left out and `@Resolver(() => User)` supplies it. The field name is the method's name unless the decorator overrides it with `@Query(() => User, { name: "foo" })`.

Python decorators go through `decoratedFunctionRoute` and `decoratedClassRoute`, which the Python adapter defines for itself. See [Read Python or Ruby](/guides/python-and-ruby).

### `clientCall`

```typescript
{
  type: "clientCall";
  importModule: string;        // or "global" for built-ins like fetch
  importName: string;
  methodFilter?: string[];
  factoryMethods?: string[];   // ["create"] for axios.create(...)
  callable?: boolean;          // the import itself sends, as axios(config) does
  basePathOption?: string;     // "baseURL" for axios.create({ baseURL })
}
```

`clientCall` finds call sites, the consumer side of a boundary. The adapter finds imports of `importName` from `importModule`, resolves variables initialized from that import, and walks their method calls. For a global, every bare call to `importName` matches. The enclosing function becomes a `client`-kind unit.

```ts
const api = axios.create({ baseURL: "https://shop.example.com/api" });
await api.get(`/orders/${id}`);
```

`basePathOption` is the property on the factory call's configuration that sets the base path for every request made through the instance. The adapter reads it from the factory call the receiver resolves to, and puts it in front of the call's own path, so a client with a base pairs with a spec whose `servers[0].url` states the same prefix. An absolute base keeps only its path, a base of `/` adds nothing, and a base the evaluator cannot resolve leaves the path as the call site wrote it.

The fetch pack uses it with `importModule: "global"`, axios with `factoryMethods` and `callable`, ts-rest with `initClient`, and the Python and Ruby client packs (requests, httpx, aiohttp, Faraday, Net::HTTP) through their own adapters.

### `graphqlHookCall`

```typescript
{
  type: "graphqlHookCall";
  importModule: string;
  hooks: Array<{ hookName: string; operationType: "query" | "mutation" | "subscription" }>;
}
```

Apollo Client and urql are normally used through hooks, and `graphqlHookCall` matches one of those hook calls on the consumer side. Each call becomes a `client`-kind unit with `graphql-operation` semantics.

```ts
const GET_USER = gql`query GetUser($id: ID!) { user(id: $id) { id } }`;
const { data } = useQuery(GET_USER, { variables: { id } });
```

The document can be an inline `gql` template, a const in this module or an imported one, a `.graphql` file import, or a generated `TypedDocumentNode`. When the body cannot be read, the operation header falls back to the `TypedDocumentNode` type arguments, and the per-hook `operationType` supplies the type. A document that still cannot be resolved is kept on the summary as `metadata.graphql.unresolvedDocument`. The Apollo client pack uses it.

### `graphqlImperativeCall`

```typescript
{
  type: "graphqlImperativeCall";
  importModule: string;
  importName: string;
  methods: Array<{ method: string; documentProperty: string }>;
}
```

`graphqlImperativeCall` covers the imperative form, where the document is passed on a configuration property.

```ts
const client = new ApolloClient({ uri });
await client.query({ query: GET_USER, variables: { id } });
```

Discovery fires only when the named constructor is imported, since otherwise any object with a `query` method would look like a match. When the document's header is anonymous, the method name sets the operation type. A named header takes precedence. The Apollo client pack uses it.

### `resolverMap`

```typescript
{
  type: "resolverMap";
  importModule: string;
  importName: string;
  mapProperty: string;
  excludeTypes?: string[];
}
```

A code-first GraphQL server passes a configuration object with a two-level resolver map on it to a constructor or factory. `resolverMap` matches that call.

```ts
new ApolloServer({
  typeDefs,
  resolvers: {
    Query: { users: async () => { ... } },
    User: { fullName: (parent) => `${parent.first} ${parent.last}` },
  },
});
```

Each inner function becomes one unit with `graphql-resolver(typeName, fieldName)` semantics. Both `new Ctor(cfg)` and `ctor(cfg)` match, since Apollo's standalone server uses `new` and yoga uses a bare call. The Apollo pack declares `mapProperty: "resolvers"`.

### `jsxElementRoute`

```typescript
{
  type: "jsxElementRoute";
  importModule: string | string[];
  routeElement: string;
  pathAttribute: string;
  elementAttribute: string;
  indexAttribute?: string;
}
```

`jsxElementRoute` reads routes declared as JSX elements, the way client-side routers write them.

```tsx
<Routes>
  <Route path="/orders" element={<Orders />}>
    <Route path=":id" element={<OrderDetail />} />
  </Route>
</Routes>
```

It covers the nested tree form, where a child path joins its parent's and an index route takes the parent's path, and the object-array form, where a factory call takes an array of route objects using the same property names. A route whose component cannot be read is still reported, as a boundary with nothing behind it. A route whose path cannot be read gets no path, and suss records a gap saying why. React Router uses it.

### `packageExports`

```typescript
{
  type: "packageExports";
  packageJsonPath?: string;   // absolute; omit when `workspaces` is set
  workspaces?: true;
  subPaths?: string[];
  excludeNames?: string[];
}
```

`packageExports` treats a package's public exports as a boundary. The adapter reads the manifest, resolves every reachable entry point (the root `.` plus any sub-path in `exports`), follows barrel re-exports, and emits one `library`-kind unit per exported function, the provider side of an in-process `function-call` boundary.

`workspaces: true` applies the pattern once per package the workspace manifest declares, since the package list is a property of the project itself. Each binding is identified by `{ package, exportPath }`, so a sub-path export comes out as `@suss/behavioral-ir/schemas::BehavioralSummarySchema`. Root exports leave the sub-path segment out. The package-exports pack uses it.

It resolves the `types`, `default` and `import` conditions on `exports`, and falls back to `types`, `main` and `module` when there is no `exports` field. Pattern exports (`./utils/*`) and `development`-conditional resolution are not done yet, and come back as warnings on the resolver result.

### `packageImport`

```typescript
{ type: "packageImport"; packages: string[] }
```

`packageImport` finds the consumer side of that same boundary. The adapter scans for imports of the listed packages and records every call site, and each enclosing function becomes one `caller`-kind unit per imported binding it invokes. Each binding is identified as `function-call { package, exportPath }`, matching the `packageExports` providers, so the checker pairs them by `fn:<package>::<exportPath>`.

Pass exact module specifiers, sub-path included. Several call sites inside one function to the same binding collapse to one unit, and call sites to different bindings produce one unit each. Named and default imports with bare-identifier calls are covered. Namespace imports (`import * as X`) and member-call chains (`X.method()`) are not done yet. The package-exports pack uses it.

## `BindingExtraction`

`bindingExtraction` on a discovery pattern says where the HTTP method and path come from.

### Method

| Variant | What it reads |
|---|---|
| `{ type: "fromRegistration"; position: "methodName" \| number; nameMap? }` | The registration call. `"methodName"` means the method registered on is the HTTP method, so `app.get` gives `GET`. A number reads it out of that argument instead. `nameMap` covers a registration recorded as something other than its own name uppercased, the way `.all` is recorded as `"*"`. |
| `{ type: "fromExportName" }` | The export name is the method, which is the Next.js App Router convention. |
| `{ type: "fromContract" }` | A separate contract definition, as ts-rest has. |
| `{ type: "fromClientMethod" }` | The client call's method name, resolved back through the contract. `client.getUser(...)` finds `GET`. |
| `{ type: "fromArgumentProperty"; position; property; default? }` | A property on an options argument. The fetch pack reads `method` off argument 1 and falls back to `"GET"`. |
| `{ type: "literal"; value }` | Fixed. A React Router loader is always `GET`. |

### Path

| Variant | What it reads |
|---|---|
| `{ type: "fromArgument"; position }` | The argument at that position, on either side of the boundary. `app.get("/users", h)` and `fetch("/users")` both give `/users`. A name bound to a string is followed to what it was written as, so `app.get(USERS, h)` gives `/users`, and a template is read hole by hole, so `` `${BASE}/items/:id` `` with `BASE = "/api"` gives `/api/items/:id`. A hole suss cannot follow becomes `{name}`, which the path normalizer treats the same way as `:name`. |
| `{ type: "fromArgumentProperty"; position; property }` | A property on the argument, the way a route object built by Hono's `createRoute` stores its path. |
| `{ type: "fromFilename"; root; dropBasenames?; dynamic?; dropParenthesized?; flat? }` | Where the file is on disk. `root` says where a route path starts, `dropBasenames` lists filenames that only say what kind of file it is and contribute no path segment, and `dynamic` says how the framework writes a parameter (`"brackets"` for Next.js's `[id]`, `"dollarPrefix"` for `$id`). `app/api/orders/[id]/route.ts` under `{ root: "app", dropBasenames: ["route"], dynamic: "brackets" }` gives `/api/orders/{id}`, which pairs with an Express provider writing `/api/orders/:id`. Next.js uses it. |
| `{ type: "fromContract" }` / `{ type: "fromClientMethod" }` | As above. |

### A binding the pattern states outright

`bindingExtraction` only describes REST bindings, so a pattern whose boundary is a queue uses `binding` instead:

```typescript
binding: {
  semantics: "message-bus";
  messageBus: MessageBusTechnology;
  channel:
    | { from: "decoratorArgument"; position: number }
    | { from: "literal"; value: string }
    | { from: "unstated" };
}
```

`decoratorArgument` reads the channel from the decorator that selected the handler, so `@EventPattern("order.placed")` gives `order.placed`. `unstated` means suss has the message bus but not the channel, and the binding pairs the way any null channel pairs. NestJS microservices uses it.

## `TerminalMatch` variants

### `returnShape`

```typescript
{ type: "returnShape"; requiredProperties?: string[] }
```

`returnShape` matches a return of an object literal. With `requiredProperties` the object has to have all of them, so the terminal does not match arbitrary literals.

```ts
return { status: 404, body: { error: "not found" } };
```

ts-rest and React Router use it. Where no extraction picks a property, the body is the whole returned object.

### `returnStatement`

```typescript
{ type: "returnStatement"; excludeCallReturns?: boolean }
```

`returnStatement` fires on any return, whatever the value, and records it as `Output.return`. Every client pack uses it as its primary terminal, and so do the packs whose units return arbitrary values (package-exports, the NestJS packs, Apollo, React, Next.js server actions, Cloudflare Workers).

`excludeCallReturns: true` skips a bare `return;` and a `return <call>` or `return new <Ctor>(...)`. Fastify sets it, so `return reply.send(...)` does not fire twice, once here and once as a `parameterMethodCall` on the inner call. `await`, `as`, parentheses and non-null wrappers are stripped before the check. Bare value returns (`return user`, `return { id }`, `return await db.find(id)`) still match.

### `parameterMethodCall`

```typescript
{
  type: "parameterMethodCall";
  parameterPosition: number;
  methodChain: string[];
  passThroughMethods?: string[];
}
```

`parameterMethodCall` matches a method call on a particular parameter.

```ts
res.status(201).json(order);   // position 1, chain ["status", "json"]
c.json(order, 201);            // position 0, chain ["json"]
```

An empty chain matches any call. `passThroughMethods` lists methods that return the response itself and change nothing the terminal reads, so `res.set(h).status(201).json(b)` still matches `["status", "json"]`. Express, Fastify, Hono and Next.js use it. Express is the one that needs the pass-through list.

### `throwExpression`

```typescript
{ type: "throwExpression"; constructorPattern?: string }
```

`throwExpression` fires on a `throw`. With `constructorPattern`, the thrown expression has to match it textually. Almost every framework pack declares one.

```ts
throw new HTTPException(404, { message: "no such order" });
```

Set `producesResponse: true` on the terminal when the framework turns the thrown status into the wire response, which HTTP packs do. A pack reading a non-HTTP code space off a throw leaves it off and the throw stays a throw.

### `functionCall`

```typescript
{ type: "functionCall"; functionName: string; requiresImport?: string[] }
```

`functionCall` matches a call to a named function. Only a bare identifier callee counts, so `res.json(...)` does not match `functionName: "json"`.

```ts
return json(user);
return redirect("/orders");
```

Set `requiresImport` whenever the function belongs to a library. Matching on a bare name otherwise picks up a project's own helper of the same name, and reading a library's argument order into one of those gives a wrong answer at high confidence. React Router, Next.js and Cloudflare Workers use it.

For a project's own response helper, declare the envelope with a `returnShape` terminal instead. The adapter follows a returned call into the project and reads the helper's parameters, which covers the helper whatever it is called and whatever order its arguments come in.

### `jsxReturn`

```typescript
{ type: "jsxReturn" }
```

`jsxReturn` fires on a return whose value is a JSX element or fragment. The root element or component name is recorded on the terminal. The React and React Router packs use it to classify component output as a `render`.

### `functionFallthrough`

```typescript
{ type: "functionFallthrough" }
```

When the last statement of a body is neither a return nor a throw, the body ends in an implicit fall-through, and `functionFallthrough` fires there. Without it, a handler that only runs side effects comes out with no transitions at all. A pack for callback bodies should include it. An HTTP pack that always expects an explicit return should leave it out. The NestJS packs, Apollo, AWS Lambda and Cloudflare Workers include it.

### `parameterCall`

```typescript
{ type: "parameterCall"; parameterPosition: number }
```

`parameterCall` matches a call to the parameter at that position, such as `next()` inside middleware. No pack declares this. The adapter builds it from `wraps.continuationParam`, so a wrapper path that hands control on ends in a `delegate` output and a path that responds first does not.

## `TerminalExtraction`

```typescript
{
  statusCode?:
    | { from: "property"; name: string }
    | { from: "argument"; position: number; minArgs?: number }
    | { from: "argumentProperty"; position: number; name: string }
    | { from: "constructor"; codes: Record<string, number> }
    | { from: "argumentConstructor"; position: number; codes: Record<string, number> };
  body?:
    | { from: "property"; name: string; unwrapJsonStringify?: boolean }
    | { from: "argument"; position: number; minArgs?: number };
  defaultStatusCode?: number;
}
```

Both fields are optional. Not every terminal has a body, and not every one has a status code.

`minArgs` handles an overloaded signature where the same position means different things depending on arity. Express's `res.redirect(url)` has the URL at position 0 and `res.redirect(301, url)` has the status there, so `minArgs: 2` extracts from position 0 only when the call has at least two arguments.

`argumentProperty` reads the status off a property of an argument, the way `NextResponse.json(body, { status: 404 })` does.

`from: "constructor"` maps constructor names to status codes, for error libraries that encode the code in the exception type. Resolution tries the full text first, so `throw new HttpError.NotFound()` looks up `codes["HttpError.NotFound"]`, then falls back to the last dot-segment, `codes["NotFound"]`. That lets a pack write `{ NotFound: 404 }` once and cover both `NotFoundError` and `createError.NotFound`. `argumentConstructor` is the same thing one level in, for a wrapped error: `throw wrap(new HttpError.NotFound("..."))` reads the class off the argument at `position`. Both sources apply only to a `throwExpression` match, and return null anywhere else.

`unwrapJsonStringify` unwraps a `JSON.stringify(x)` initializer back to the type of `x`. That covers the Lambda-proxy convention, where `body` contains the serialized payload instead of the payload itself. It is off by default.

`defaultStatusCode` is the framework's own default when extraction pulls no numeric value out. Hono's `c.json(body)` sends 200 and `c.redirect(url)` sends 302, so both terminals declare one. On a `kind: "response"` `returnStatement` terminal it is how Fastify maps `return user` to a 200.

## `InputMappingPattern` variants

### `positionalParams`

```typescript
{ type: "positionalParams"; params: Array<{ position: number; role: string }> }
```

`positionalParams` assigns fixed roles by position. Express declares `(req, res, next)`, and Hono declares one parameter with the role `context`.

### `objectParam`

```typescript
{
  type: "objectParam";
  paramPosition?: number;              // defaults to the first parameter
  knownProperties: Record<string, string>;
  wholeParamRole?: string;             // defaults to "request"
}
```

`objectParam` handles one object parameter whose properties are the inputs. React Router passes `{ params, request }` and ts-rest passes `{ params, body, query }`.

A handler that destructures gets one input per name it binds, with the role `knownProperties` gives it. A handler that takes the object whole gets a single input with the role from `wholeParamRole`, because the source does not say which properties it reads.

```ts
export async function loader({ params }: LoaderFunctionArgs) { ... }
// one input: name "params", role "pathParams"

export async function loader(args: LoaderFunctionArgs) { ... }
// one input: name "args", role "request"
```

### `componentProps`

```typescript
{ type: "componentProps"; paramPosition: number; wholeParamRole?: string }
```

`componentProps` reads component props. The prop names are whatever the component author wrote, so no pack can list them in advance. A destructured parameter gives one input per bound name, with the name as its role. An undestructured one gives a single input with the role from `wholeParamRole`, which defaults to `"props"`. Each input records the prop's type text, and the comparison of a component's props reads it. The React pack uses it.

### `decoratedParams`

```typescript
{ type: "decoratedParams"; decoratorRoleMap: Record<string, string>; defaultRole?: string }
```

`decoratedParams` takes roles from parameter decorators. The adapter reads each parameter's first decorator and looks its name up in the map. A parameter that matches nothing takes `defaultRole`, or is skipped when there is none. The NestJS packs use it, GraphQL with `{ Args: "args", Parent: "parent", Context: "context", Info: "info" }`. Decorators are matched by name alone, so two frameworks declaring `@Args` both map.

### `allPositional`

```typescript
{ type: "allPositional"; defaultRole?: string }
```

`allPositional` gives one input per declared parameter, in source order, with the parameter's own name as its role. It is used where no framework declares a set of roles and the name a caller sees is the role: the reachable-closure pass, the package-exports pack, and Next.js server actions. Destructured parameters are captured the way `objectParam` captures them, so `(ctx, { userId })` gives two inputs.

## Recognizers

Recognizers fire on nodes inside a unit's body, whichever pack discovered the unit.

```typescript
type InvocationRecognizer<TCtx = unknown> = (
  call: unknown,   // CallExpression handle, opaque at this level
  ctx: TCtx,       // adapter context, TsRecognizerContext for TypeScript
) => Effect[] | null;

type AccessRecognizer<TCtx = unknown> = (
  access: unknown, // property access, call, or tagged template
  ctx: TCtx,
) => Effect[] | null;
```

`invocationRecognizers` fire on every call expression in the body. `accessRecognizers` fire on every property access, and also on calls and tagged templates, since a library like Prisma takes its whole argument as one (`prisma.$queryRaw`). Both skip nested function bodies, which are their own units with their own dispatch.

The contract:

- **They fire across packs.** The Prisma pack's recognizer fires on Prisma calls inside an Express handler. Pack authors do not need to coordinate.
- **Returning effects adds them** to the enclosing default-branch transition, and the generic `invocation` effect is kept either way. Returning `null` or `[]` is the no-match path.
- **Deduping is the recognizer's job.** The dispatcher does not dedupe across calls. A recognizer that wants to fire once per identifier tracks that itself.
- **A recognizer that throws is caught**, logged to stderr with the file and line, and skipped for that one call. The run continues.

Returning `null` means only "not my call". A field the pack could not read is a different thing: record the crossing and write null for the field. The binding builders throw on an empty string, so there is no way to fake one.

```ts
// The queue URL came from a variable. The send still happened.
messageBusBinding({
  recognition: "@suss/framework-aws-sqs",
  messageBus: "aws_sqs",
  channel: null,
});
```

`ctx` is the adapter's recognizer context, `TsRecognizerContext` for TypeScript, with the source file handle and an `extractArgs()` helper. A recognizer casts both arguments to the context it was written against, and that cast is where the pack declares which adapter it needs.

## Sub-units

```typescript
subUnits?: (parent: DiscoveredSubUnitParent, ctx: unknown) => DiscoveredSubUnit[];

interface DiscoveredSubUnitParent {
  func: unknown;   // parent's function body handle
  name: string;    // e.g. "Counter"
  kind: string;    // e.g. "component"
}
```

`subUnits` returns extra units built from a parent's body. Use it when one construct the author wrote spawns several units that the runtime schedules: React event handlers on JSX elements, `useEffect` bodies, a Node `setTimeout` callback, class-component lifecycle methods.

Returned units go through the same pipeline top-level units do, and each becomes its own `BehavioralSummary`. Put per-unit `terminals` and `inputMapping` on the `DiscoveredSubUnit` when a sub-unit is written differently from the parent pack's defaults.

## Custom discovery

```typescript
discoverUnits?: (sourceFile: unknown, ctx: unknown) => DiscoveredCustomUnit[];
```

`discoverUnits` is the discovery counterpart of `subUnits`. When a framework's convention doesn't fit any of the `DiscoveryMatch` variants, the pack ships its own walker and the adapter calls it once per source file alongside the data-driven dispatch.

Use it for conventions that do not generalize, such as React's component-export heuristic (PascalCase plus a JSX return). Adding each of those to the central union would make every unrelated pack deal with them.

When this callback finds a unit at the same `(func, kind)` as one from another pack's data-driven discovery, suss keeps the unit from whichever pack claimed it first. The order of the packs in the run decides which one that is.

## Gates and per-project reading

### `requiresImport`

```typescript
requiresImport?: string[]
```

`requiresImport` gates the whole pack on its imports. The adapter's pre-filter only considers the pack applicable to files importing at least one of the listed modules, matched by prefix, so `"@aws-sdk/client-sqs"` matches that module and any sub-path of it.

It is for recognizer-only packs that target one library: the SQS pack declares `["@aws-sdk/client-sqs"]` and the Prisma pack `["@prisma/client"]`. Without a gate the pack walks every file, which is correct and wasteful. A discovery pattern has its own `requiresImport` for the same purpose, and an empty array is the deliberate "every file" choice, which the fetch pack makes because `fetch` is a global.

### `mount`

```typescript
mount?: { method: string; prefixPosition: number; targetPosition: number }
```

On a `registrationCall` pattern, `mount` says how the routable it discovers can itself be mounted under a prefix.

```ts
app.use("/api", ordersRouter);      // Express: { method: "use", ... }
app.route("/api", ordersApp);       // Hono:    { method: "route", ... }
```

The adapter composes the prefix into the path of every route on the mounted value, following it through an import to whichever file declares it, and a mount nested deeper composes too. A mount whose prefix is not a string literal, or whose target cannot be followed to a concrete value, contributes nothing and the routes under it keep the path they were written with.

### `wraps`

```typescript
wraps?:
  | { method: string; targetPosition: number; scopePosition?: number; arity?: number; ... }
  | { constructorOption: string; targetPosition: number; ... }
```

`wraps` describes how the framework registers a function that runs around a handler, such as middleware, an error handler or a validation hook. The registered function becomes a unit of its own, and every unit registered on the same routable records a reference to it.

Three parameter positions say how the framework invokes it. `continuationParam` is the one it calls to hand control on, absent for a wrapper that always responds. `throwParam` receives what the wrapped unit threw, and a wrapper declaring one runs only on the throwing path. `resultParam` receives a value the framework worked out first, such as the outcome of validating a request. Express tells its error handlers apart from its middleware by `arity` alone, because both are registered with `app.use(fn)`. Express and Hono use this, through `wrapperDiscovery`.

### `projectHelpers`

`projectHelpers` covers functions the project itself wrote around the library. suss reads them once across the whole project before it walks any file, and whatever the pack makes of them is used alongside its own patterns for the rest of the run. `routeHelperIndex` is the shipped one. Express, Fastify and Hono ask for the project's route helpers to be read, so suss works out what each helper registers from the code itself.

### `transparentWrappers`

```typescript
transparentWrappers?: Array<{ module: string; name: string; argument: number }>
```

`transparentWrappers` declares a library wrapper that returns the argument passed to it. For a factory inside the project the adapter works this out on its own by reading the body. A library's body is not there to read, so the pack has to declare it. The declaration says which module exports the wrapper and under what name, so a call matches however the project imports it: by name, renamed, or read off a namespace import under any name. AWS Lambda declares `wrapHandler` from `@sentry/aws-serverless`, and Hono declares `createRoute` from `@hono/zod-openapi`. A Python pack takes the same field. A Ruby pack takes it too, but the Ruby adapter does not record which module a callee comes from, so a Ruby declaration matches no call yet.

### `environmentObjects` and `libraryEnvVars`

`environmentObjects` lists objects whose properties are the process environment, written as the dotted path the code uses (`"process.env"`). The adapter records a fact for each read from one of these objects whose index is not a literal. With that fact, suss can report the reads of a helper that takes a variable's name as a parameter at the calls that supplied the name. The Node pack declares it.

`libraryEnvVars` lists environment variables the library reads from inside `node_modules`, where suss does not look. Declaring them stops the checker from reporting a variable in a template as unused when the library reads it on every invocation. AWS Lambda declares the Powertools prefixes.

### `discoveryInputs`

```typescript
discoveryInputs?: (files: readonly string[]) => string[]
```

Files under the project the pack reads that are not source files. Their content feeds the same cache key the pack's configuration does, so a run made after somebody edits one reads the project again. The AWS Lambda pack is the case this exists for: a SAM template declares which handlers exist, and no source file changes when that template does. Rails declares `config/routes.rb` the same way.

### `responseSemantics` and `failureDelivery`

```typescript
responseSemantics?: Array<{
  name: string;
  access: "property" | "method";
  semantics: { type: "statusCode" | "statusRange" | "body" | "headers"; min?; max? };
}>;
failureDelivery?: "response" | "exception";
```

`responseSemantics` describes what a property on the client's response object means, so the adapter turns `.ok` into a status range and `.json()` into a body. The fetch, axios and ts-rest packs declare it.

`failureDelivery` records how the client hands back a refused request. `fetch` returns a response and the caller reads the status off it, which is the `"response"` default. axios, requests, httpx, Faraday and Net::HTTP reject or raise instead, so every non-2xx reaches the caller through a `catch` and there is no status for a guard to read.

## Contract reading

```typescript
contractReading?: {
  discovery: { importModule: string; importName: string; registrationChain: string[] };
  responseExtraction: { property: string };
  methodProperty: string;
  pathProperty: string;
  paramsExtraction?: { property: string };
  endpoint?: { from: "registrationArgument"; position: number };
}
```

`contractReading` says where a framework's own declared responses live, so a handler returning a status the contract never declares becomes a finding.

Leave `endpoint` out and the ts-rest arrangement applies: one contract object contains every endpoint keyed by handler name, and the reader walks up from the handler to the enclosing router call. Set it and the zod-openapi arrangement applies instead, where `app.openapi(route, handler)` passes the endpoint's own contract as the handler's sibling argument. `methodProperty` and `pathProperty` are the library's own words for those keys, so the pack supplies them.
