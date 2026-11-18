---
title: Pack patterns
description: Every pattern variant a pack can use, the code each one matches, and the shipped pack that uses it.
---

# Pack patterns

Each variant a `PatternPack` can use is listed below, with the code it matches and a pack that uses it. For what a pack is and how a run loads one, see [What a pack is](/packs/what-a-pack-is). For building one, see [Write a pack](/packs/write-a-pack).

A TypeScript pack is a `PatternPack`. A Python pack is a `PythonPack` and a Ruby pack a `RubyPack`, each with route and job patterns of its own. All three take the same declarations from `@suss/recognize` for the calls a library offers, such as a store's queries, a client's requests or a callback the library runs later, and every adapter runs those declarations the same way. [Declared calls](#declared-calls) shows how they are written. The discovery patterns that say they are read through the module ops, `testCases` and `routeTable` are declared the same way in every language.

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
  requestSpelling?: RequestSpellingMetadata;
  responseSemantics?: ResponsePropertyMapping[];
  failureDelivery?: "response" | "exception";
  redirectDelivery?: "followed" | "response";
  requestRecognizers?: RequestRecognizer[];
  invocationRecognizers?: InvocationRecognizer[];
  accessRecognizers?: AccessRecognizer[];
  subUnits?: (parent, ctx) => DiscoveredSubUnit[];
  classBodies?: ClassBodyDeclaration[];
  words?: PackWords;
  requiresImport?: string[];
  requiresText?: string[];
  generatedModules?: {
    of: string;
    markers?: string[];
    dirs?: (fromDir: string) => readonly string[];
  };
  projectHelpers?: ProjectHelpers;
  transparentWrappers?: TransparentWrapper[];
  parameterSuppliers?: Array<{ module: string; name: string }>;
  environmentObjects?: string[];
  streamObjects?: string[];
  exitCodeWrites?: string[];
  argumentParsers?: ArgumentParser[];
  libraryEnvVars?: Array<{ module: string; prefixes?: string[]; names?: string[] }>;
  discoveryInputs?: (files: readonly string[]) => string[];
  declarations?: PackDeclarations;
  // The Apollo client pack also sets the graphqlClient* fields.
}
```

`pack()` from `@suss/recognize` builds the whole object for a pack that only declares calls, and a pack that also discovers units writes the object itself and fills the recognizer fields from its declarations.

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
{
  type: "namedExport";
  names?: string[];
  pattern?: string;          // "^[A-Z]"
  skipFiles?: string[];      // ["**/*.stories.*"]
  bodyEndsIn?: "element";
  members?: { named: Record<string, UnitSpec> };
}
```

`namedExport` finds units by their exported name.

```ts
export async function loader({ params }) { ... }
```

React Router uses it for `loader`, `action` and `default`. The React pack uses it for `default`, and again with `pattern: "^[A-Z]"`, its story and test files in `skipFiles`, and `bodyEndsIn: "element"` for every other component a module exports.

With only `names`, the TypeScript adapter reads it with its own handler. Any other field makes it a declared pattern, which every adapter reads the same way through the module ops: `pattern` takes the exports whose name the regular expression matches, `skipFiles` leaves out files the globs match, and `bodyEndsIn: "element"` keeps only a function one of whose returned values is a JSX element. `members` takes the listed members of the exported object instead of the export itself, each as the unit its `UnitSpec` says, so `names: ["default"]` with `fetch` and `queue` listed finds a Cloudflare Worker's handlers.

A `UnitSpec` can say which of the unit's parameters the platform fills when it calls the unit, with `handedIn: [{ at: 1, name: "env" }]`. The adapter records that on the parameter when it claims the unit, so a read chain off `handedIn("env")` reads `env.GREETING` in the body, whatever the parameter is called.

### `manifest`

```typescript
{ type: "manifest"; entries: (filePath: string) => ManifestEntry[] }
```

`manifest` finds the functions a deploy manifest beside the project says the platform calls in a file. The pack reads the manifest and returns one entry per function: the path of names to it, `["handler"]` or `["Reports", "Nightly"]` with `member: { name: "run", singleton: true }` for a Ruby class method, and the units to build on it. A name bound to a function is followed to the function. The AWS Lambda packs use it.

### `subclassOf`

```typescript
{
  type: "subclassOf";
  inherits: { from: string[]; named: string[] }[];
  members: { kind: "instance" | "singleton"; names?: string[]; pattern?: string };
  calls?: Record<string, NamingCall>;
  className?: { call?: string; suffixRemoved?: string };
  skipClasses?: string[];
}
```

`subclassOf` takes the methods of an exported class whose ancestry reaches any one of the bases `inherits` lists, through any of the project's own classes in between. A class reaches a base when it extends one of `named` as one of the modules in `from` exports it. Each unit is named `Class.method`. Ruby has no imports, so `from` lists the library's constant: `ViewComponent` for `ViewComponent::Preview`. `rubyConstants("ViewComponent::Preview")` from `@suss/recognize` builds that entry from the constant as a project writes it. A Ruby class written inside a module, as `module Billing; class Nightly < Workers::WorkerEntrypoint` writes one, is read too, and its units are named under its full name, `Billing::Nightly.fetch`. A TypeScript or Python class the file does not export is not read. A project class between the class and the base counts only when the run reads the file that declares it.

`calls` makes a unit of each call in the class body that it lists, for a library whose classes declare their members by calling a method:

```ruby
class CampaignType < Types::BaseObject
  field :launch_date, String
end
```

```typescript
{
  type: "subclassOf",
  inherits: rubyConstants("Types::BaseObject"),
  skipClasses: ["Types::BaseObject"],
  members: { kind: "instance", names: [] },
  className: { call: "graphql_name", suffixRemoved: "Type" },
  calls: {
    field: {
      name: { at: 0 },
      naming: { camel: { keyword: "camelize", default: true } },
      runs: [
        { classAt: { keyword: "mutation" }, method: "resolve" },
        { method: { keyword: "resolver_method" } },
        { method: "named" },
      ],
    },
  },
}
```

That declaration gives the class above one unit, `Campaign.launchDate`. Its name comes from two parts. `className` gives the class's part: the string a `graphql_name` call in the body writes, or else the class's own name with `suffixRemoved` taken off, so `CampaignType` becomes `Campaign`. `name` gives the unit's part from the call's first argument, and `naming` turns it to camel case unless the call writes `camelize: false`. `runs` says which method the unit runs, and the first pick whose keyword the call writes wins: `mutation: Mutations::Launch` runs that class's `resolve`, `resolver_method: :count_all` runs the class's `count_all`, and otherwise the unit runs the class's method under the argument's own name. `members` with an empty `names` list makes no unit of a plain method, and `skipClasses` keeps the base itself from being read as a type. The graphql-ruby pack declares its fields this way.

### `marked`

```typescript
{
  type: "marked";
  word: string;                                   // "use server"
  scopes: ("module" | "function")[];
  name: ("assignedName" | "countInFile")[];
  countedAs: string;                              // "serverAction"
  unit?: { terminals?: TerminalPattern[]; inputMapping?: InputMappingPattern };
}
```

`marked` reads a directive prologue. At module scope it makes every exported function a unit, under the name it is exported as, and at function scope it makes each function whose body opens with the directive one. A function is named by the first rule that gives a name: the variable or property it is assigned to, or `countedAs#0`, `countedAs#1` and so on in the file. Only TypeScript writes a directive.

Every unit is bound as a call of its module under the unit's name, since the framework exposes a marked function by that name, inline ones included. `unit` gives the terminals and input mapping each unit is read with when the pack's own do not fit, as a server action returns a value where the pack's route handlers send a response. The Next.js pack uses it for server actions.

### `registeredFunction`

```typescript
{
  type: "registeredFunction";
  start: ReceiverOrigin;                        // imported({ from: ["react-dom/client"], ... })
  method?: string;                              // "render"
  handler: { at: number; through?: "element" };
  nameAt?: { at: number; named: Record<string, UnitSpec> };
  in?: "moduleBody" | "file";                   // "file"
}
```

`registeredFunction` finds a function a call in the module body hands to a library, or with `in: "file"` a call anywhere in the file, when that call is the function's only mention: `addEventListener("fetch", handle)`, or `createRoot(el).render(<App />)` with `through: "element"`, which follows the element to the component its tag renders. With `method` the call is that method on a receiver the start accepts; without it the callee itself is the start. `nameAt` reads the unit's name from an argument, a literal or a name kept in a const, and keeps only the names it lists.

When the start is a global and there is no `method`, as with `global("addEventListener")`, the call has to be written with the global's name, so a file whose text never writes it is skipped before its calls are read. When every member of the start is an import or a construction from a module, the file's text has to write one of the modules, so the React pack's boot patterns read only files that write `react-dom`.

### `decorated`

```typescript
{
  type: "decorated";
  on: ReceiverOrigin;                           // constructedFrom({ from: ["fastapi"], named: ["FastAPI"] })
  named: Record<string, DecoratedUnitSpec>;     // { middleware: { kind: "middleware" } }
}
```

`decorated` finds a function written under a decorator that a library offers as a method of an object it made:

```python
app = FastAPI()

@app.middleware("http")
async def add_timing(request, call_next): ...
```

The keys of `named` are the decorator methods, and each one says what unit the function under it becomes. `on` is asked of the call the decorator's receiver was written as, `FastAPI()` for `app`, so an object a project function returns does not count. A decorator written with no call, `@app.before_request`, is read through the object it is read off. The unit takes the function's own name, and a function written inside another function or a class counts. A class under the decorator doesn't become a unit. Every adapter reads the pattern through the module ops, though only TypeScript and Python have decorators. The FastAPI and flask-restx packs declare their middleware and request hooks as `decoratedWrapper` forms, and the Python adapter reads each one through this pattern.

### `entryObject`

```typescript
{ type: "entryObject"; entry: string; target: string; inputs: string }
// { type: "entryObject", entry: "default", target: "component", inputs: "args" }
```

`entryObject` reads a module whose entry export says which unit the module is about, and whose other exports each give that unit one set of inputs. In a Storybook file the default export says the component, and each named export that comes to an object is a story with its args. Each member's inputs are the entry's, then its own, so a story's arg replaces the meta's under the same key. A member has no function, so this match never builds a unit, and a pack cannot list it in `discovery`. A contract reader calls `discoverEntryObject` from `@suss/recognize` over a file's module ops instead, and it reads the same way in TypeScript, Python and Ruby.

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
  defaultStatusCodes?: Record<string, number>;
  statusCodeDecorator?: string;
  globalPrefix?: {
    method: string;
    application: { importModule: string; importName: string; factory: string };
    exclude?: { option: string; pathKey: string; methodKey: string; methods: Record<number, string> };
  };
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

Three optional fields cover how the framework sets a status and a path that the handler does not write itself:

```ts
const app = await NestFactory.create(AppModule);
app.setGlobalPrefix("v2", { exclude: ["health"] });

@Post()
@HttpCode(202)
create(@Body() order: CreateOrder) { ... }
```

- `defaultStatusCodes` gives the status a handler sends when it returns without stating one, keyed by method decorator, for the verbs where that differs from the terminal's `defaultStatusCode`. NestJS REST declares `{ Post: 201 }`.
- `statusCodeDecorator` is a method decorator, imported from `importModule`, whose first argument sets that status instead, so the `create` above responds `202`. It wins over `defaultStatusCodes`.
- `globalPrefix` describes the call that puts one path in front of every route, so the routes above are served under `/v2`. `application` says how the application object is made, here `NestFactory.create` with `NestFactory` imported from `@nestjs/core`, and a call on any other object is not read. `exclude` says where the call's second argument lists routes the prefix leaves out: under `option`, as a path or as an object with the path under `pathKey` and the method under `methodKey`. `methods` maps each member of the library's method enum, by its number, to a verb, with `*` for every verb.

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
  importModule: string;   // "@ts-rest/core"
  importName: string;     // "initClient"
}
```

`clientCall` finds the calls on a client built from a contract, the consumer side of a contract-first library. The adapter finds what `importName` from `importModule` built, wherever the project keeps it, and every method called on it makes the enclosing function a `client`-kind unit. With `bindingExtraction: { method: { type: "fromClientMethod" }, path: { type: "fromClientMethod" } }`, the method and path are the ones the contract lists for the method being called, and the pack's `contractReading` says how to find the contract.

```ts
const client = initClient(contract, { baseUrl: "" });
await client.getUser({ params: { id } });
```

ts-rest uses it. A library whose calls state their own method and URL, such as fetch, axios, requests, httpx, aiohttp, Faraday and Net::HTTP, declares its requests with `@suss/recognize`'s `httpRequests` instead, as [Requests a client sends](#requests-a-client-sends) shows.

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

### `routeTable`

```typescript
{
  type: "routeTable";
  table: RouteTableDeclaration;
  through?: "element";
  unread: Record<RouteUnread, string>;
}
```

`routeTable` reads the routes a table in one file declares, such as the JSX elements a client-side router is written with.

```tsx
<Routes>
  <Route path="/orders" element={<Orders />}>
    <Route path=":id" element={<OrderDetail />} />
  </Route>
</Routes>
```

The table says which elements or objects are routes, which of their attributes or keys give the path, the handler and the index flag, and where the nested routes are. `@suss/recognize` composes the paths, so a child path joins its parent's and an index route takes its parent's. Each route becomes one unit on the function its handler settles to, and with `through: "element"` that is the component the handler's JSX renders. A route whose path cannot be read gets no path, and its unit says why in the sentence `unread` gives for that reason. React Router declares its routes this way, as `REACT_ROUTER_ROUTES`, and every adapter reads the match through the module ops.

The same `RouteTableDeclaration` describes routes that are written across files. The FastAPI and flask-restx packs give one to their decorated route patterns under `routes`, so a router's prefix and every mount above it compose over the whole run. The Rails pack declares its routes grammar as one, `RAILS_ROUTES`, and reads `config/routes.rb` with it through `composeRoutes` from `@suss/recognize`. Each Rails route goes on the controller action it points at, which the pack's own `controllerActions` pattern finds, so that table builds no unit itself.

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

### `testCases`

```typescript
{
  type: "testCases";
  files: { matching: string[]; listed?: string[] };
  functions?: { pattern: string };                         // pytest: "^test"
  classes?: {
    inherits?: { from: string[]; named: string[] }[];
    named?: string;                                        // pytest: "^Test"
    nested?: boolean;
    methods: { pattern: string };
  };
  calls?: {
    from: ReceiverOrigin;                                  // imported from vitest, or the RSpec global
    body: "block" | "function";
    groups: { names: string[]; skipped?: string[] };
    cases: { names: string[]; skipped?: string[] };
    globalsIn?: { matching: string[] };
    topLevelCases?: boolean;
    shared?: { names: string[]; includes: { method: string; nestedTitle?: string }[] };
    modifiers?: { skip: string[]; takingArguments: string[]; perRow: string[] };
  };
  before?: BeforeCase;
  skips?: {
    decorators?: { origins: ReceiverOrigin[]; variable?: string };
    statements?: string[];
    metadata?: string[];
  };
  runner?: { prefixes?: string[]; names?: string[]; chains?: boolean };
  mocks?: MockRule[];
}
```

`testCases` finds test cases the way a runner collects them, and `@suss/recognize` reads it through the module ops, so the same member works in every language. A file is read when its name matches one of `files.matching`, and with `files.listed`, only when it also matches one of the listed paths on whole path segments from the end. `suss extract --intent` fills `listed` in from the tests the PRDs list.

A runner writes its cases in one of three ways, and a pack sets the form or forms its runner uses:

- `functions` takes a function the module declares at its top level whose name matches the pattern, as pytest collects `def test_cancel():`.
- `classes` takes a class that matches `named` or reaches one of the `inherits` bases, and each of its methods whose name matches `methods.pattern`. pytest collects `Test` classes and `unittest.TestCase` subclasses this way, and Minitest collects subclasses of `Minitest::Test` and the Rails test cases. With `nested`, a class written inside a collected class is read too, its name another title.
- `calls` takes cases written as calls inside group calls, the style of vitest, jest, mocha and RSpec. `from` says where the runner's functions come from: an import, as `vitest` exports `describe` and `it`, or a global whose methods they are, as `RSpec.describe`. `body` says whether a case runs the block its call is written with, as in Ruby, or the first function passed after its title. A case is named by the titles of the groups it is written inside and its own, joined with ` > `, and a case written in a callback or a loop inside a group is in that group. `shared` reads RSpec's `shared_examples` and the calls that include them, each includer getting its own cases. `modifiers` covers `it.skip`, `it.skipIf(condition)(...)`, and a per-row modifier such as `it.each`, which declares the case once under the title as written and records that title as unresolved. In a file `globalsIn` matches, a runner function the file neither imports nor declares counts too.

`before` lists what the runner calls before a case, and the case's unit calls each one, so a path through a setup counts as the case reaching what the setup calls. It covers module functions such as pytest's `setup_function`, methods such as `setUp`, and calls written in a class or group body such as Minitest's `setup do` and RSpec's `before`. `skips` says what marks a case as not run: a decorator such as `@pytest.mark.skip`, a `skip` statement in the body, or `skip: true` metadata on an RSpec example. `runner` lists the calls a case makes to the runner itself, such as `assert_equal` or `expect(x).to eq(y)`, which call no project code and are left off the case's effects.

`mocks` says how the runner replaces something. A `replacesModule` rule reads the dotted path or specifier a call passes, as `vi.mock("./orders")` or `patch("orders.service.cancel")` does, and a `replacesMember` rule reads the object and the member's name, as `vi.spyOn(orders, "cancel")` or Minitest's `Order.stub(:cancel, 1)` does. `replacesMessages`, `replacesConstant` and `standsIn` read RSpec's `allow(Order).to receive(:cancel)`, `stub_const` and `instance_double`. A mock applies to every case in the group or case it is written in, and to every case in the file when it is written outside them.

A TypeScript pack lists the match in `discovery`, as the vitest pack does. A Python pack lists it as the `cases` of an entry under `tests`, beside pytest's fixture rules. A Ruby pack lists it under `tests` for a runner written as calls, as RSpec is, with RSpec's `let` and `subject` rules beside it, and under `testClasses` for a runner written as classes, as Minitest is.

### `callbackArgument`

```typescript
{
  type: "callbackArgument";
  importModule: string;      // "bullmq"
  importName: string;        // "Worker"
  callbackPosition: number;  // 1
}
```

`callbackArgument` finds a function handed to a call or construction of a library export, which the library then runs with work of its own:

```ts
import { Worker } from "bullmq";
import { sendEmail } from "./processors";

new Worker("emails", sendEmail);
```

`new Worker(...)` and `worker(...)` both match, and only when the callee comes from `importModule`, so a class of the project's own with the same name is left alone. The function is followed the way any value is, so `sendEmail` above is the function in `./processors`. A function that does not settle to one body, such as a parameter or a file path the library loads itself, gives no unit. Pair it with a declared `binding` whose channel is `callArgument` to read the boundary off the same call. The BullMQ pack uses it.

## `BindingExtraction`

`bindingExtraction` on a discovery pattern says where the HTTP method and path of the route it finds come from. A client declared with `httpRequests` says the same on its methods table, so only ts-rest's `clientCall` uses this on the client side.

### Method

| Variant | What it reads |
|---|---|
| `{ type: "fromRegistration"; position: "methodName" \| number; nameMap? }` | The registration call. `"methodName"` means the method registered on is the HTTP method, so `app.get` gives `GET`. A number reads it out of that argument instead. `nameMap` covers a registration recorded as something other than its own name uppercased, the way `.all` is recorded as `"*"`. |
| `{ type: "fromExportName" }` | The export name is the method, which is the Next.js App Router convention. |
| `{ type: "fromContract" }` | A separate contract definition, as ts-rest has. |
| `{ type: "fromClientMethod" }` | The client call's method name, resolved back through the contract. `client.getUser(...)` finds `GET`. |
| `{ type: "fromArgumentProperty"; position; property; default? }` | A property on an argument, falling back to `default` when the argument does not state it. The Hono pack reads `method` off the route object `createRoute` builds. |
| `{ type: "literal"; value }` | Fixed. A React Router loader is always `GET`. |

### Path

| Variant | What it reads |
|---|---|
| `{ type: "fromArgument"; position }` | The argument at that position. `app.get("/users", h)` gives `/users`. A name bound to a string is followed to what it was written as, so `app.get(USERS, h)` gives `/users`, and a template is read hole by hole, so `` `${BASE}/items/:id` `` with `BASE = "/api"` gives `/api/items/:id`. A hole suss cannot follow becomes `{name}`, which the path normalizer treats the same way as `:name`. |
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
    | { from: "callArgument"; position: number }
    | { from: "literal"; value: string }
    | { from: "unstated" };
}
```

`decoratorArgument` reads the channel from the decorator that selected the handler, so `@EventPattern("order.placed")` gives `order.placed`. NestJS microservices uses it. `callArgument` reads it from the call a `callbackArgument` match found the function in, so `new Worker("emails", processor)` gives `emails`. BullMQ uses it. A constant passed by name is followed to the string it was written as, and a channel that does not settle to one string is left null. `unstated` means suss has the message bus but not the channel, and the binding pairs the way any null channel pairs.

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

A runtime's own way of ending the process is a `functionCall` terminal too, with `kind: "exit"` and `inEveryUnit: true`. The Node pack declares `process.exit` that way:

```ts
{
  kind: "exit",
  inEveryUnit: true,
  match: { type: "functionCall", functionName: "process.exit" },
  extraction: { statusCode: { from: "argument", position: 0 }, defaultStatusCode: 0 },
}
```

`inEveryUnit` has the adapter read the terminal in every unit, whichever pack found it, the way a recognizer fires in every unit. The pack that declares it discovers nothing of its own. An `exit` terminal ends the path it is on, so the statements after `process.exit(1)` are not on that path, and the status it extracts is the exit code. The pack's `exitCodeWrites` says where a program assigns the code instead, `process.exitCode`, and the adapter follows that value back to the functions whose return ends up there.

A command-line parser is declared the same way, under `argumentParsers`, and is read in every unit too:

```ts
{ module: "node:util", name: "parseArgs", argument: 0, argsKey: "args", optionsKey: "options" }
```

At a call to it, the adapter takes the settings object at `argument`, and when the value under `argsKey` is one of the unit's parameters, records an input read of `--<key>` off that parameter for every key of the object under `optionsKey`. An intent document then lists the command's flags under `receives` as `"args.--dir"`.

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

## Declared calls

Most of what a library does inside a unit is a call: a query, a send, a request. A pack declares each kind of call it reads with a builder from `@suss/recognize`, and every adapter runs the declaration through the same ops over its facts:

```ts
import { declaredBy, pack, storageCalls } from "@suss/recognize";

const COMMANDS = storageCalls({ system: "redis", client: declaredBy("ioredis") })
  .methods({
    get: { kind: "read", selector: { at: 0 } },
    set: { kind: "write", selector: { at: 0 } },
  })
  .example('redis.get("user_online:42")');

export function redisFramework() {
  return pack("redis", [COMMANDS], {
    languages: ["typescript", "javascript"],
    recognizedAs: "@suss/framework-redis",
  });
}
```

A declaration is a chain. It starts at the receiver a call is made on, here one whose method `ioredis` declared, and `constructedFrom`, `imported`, `typed`, `returnedBy`, `global` and the others in `@suss/recognize` say other ways a receiver can come from the library. The methods table says which calls count and what each one reads. `.example(...)` gives one call the declaration matches. A pack's test runs it with `runExamples`, and pack health lists a declaration that gives none.

| Builder | What it records | Used by |
|---|---|---|
| `storageCalls` | a read or a write of a store, with its container and fields | Prisma, DynamoDB, Redis, SQLAlchemy |
| `sqlStatements` | the tables a SQL statement reads and writes | pg, pg-ruby, BigQuery |
| `messageSends`, `messageReceives` | a send to a queue or topic, and the fields a consumer reads | SQS, SNS, EventBridge, BullMQ |
| `unitInvokes` | a call that runs a deployed function | AWS Lambda |
| `httpRequests` | the request a client call sends | fetch, axios, requests, httpx, aiohttp, Faraday, Net::HTTP |
| `callbacks`, `renderedProps` | a function the library runs later, scheduled or claimed as a unit of its own | Node's timers, React's effects and handlers, TanStack Query |
| `runtimeReads`, `schemaReads` | a read of the environment, directly or through a schema | Node, Cloudflare Workers |
| `streamWrites` | a write to stdout or stderr | Node |

`pack(name, declarations, spec)` builds the whole `PatternPack` for a pack that only declares calls: the import gate from the modules the chains start at, the protocol from the wire they reach, and the recognizer fields below. A pack that discovers units as well writes its object by hand and fills the fields from the same declarations, with `requestRecognizersOf` for `requestRecognizers`, `subUnitsOf` for `subUnits`, and `declarationsIn` for the pack health report. A `PythonPack` or `RubyPack` takes the same recognizer fields.

### Requests a client sends

A client pack declares the requests a library's calls send with `httpRequests`, and lists the compiled chains under `requestRecognizers`. The adapter makes each function that makes one of those calls a `client` unit of the route in its URL, so a client pack's `discovery` is empty:

```ts
const AXIOS = imported({ from: ["axios"], named: ["default"] });

requestRecognizers: requestRecognizersOf([
  httpRequests({ client: anyOf(AXIOS, returnedBy("create", AXIOS)) })
    .methods({ get: { sends: "GET", url: { at: 0 }, options: { at: 1 } } })
    .calls({ sends: { from: { at: 0, property: ["method"] }, default: "GET" }, url: { at: 0, property: ["url"] } })
    .baseUrl({ at: 0, property: ["baseURL"], joins: "appended" })
    .response({ ...clientResponseOf(RESPONSE), redirectOption: { name: "maxRedirects", handsBack: [0] } }),
]),
```

- `.methods(table)` says what each method sends. `sends` is the verb as written, or where the call states one, with a `default` for a call that states none. `url` says where the URL is, and `options` where the options object is. `verbs({ get: "GET", post: "POST" }, { at: 0, keyword: "url" })` writes the common case of one entry per verb.
- `.calls(meaning)` says what a call of the client itself sends, as `fetch(url)` or `api({ url })` on an instance.
- `.baseUrl(pick)` reads the base URL off the construction the call's receiver was made by, as `axios.create({ baseURL })` or `httpx.Client(base_url=...)` states it. `joins` says how the library puts a path under it: `appended` after the base with one slash, or `resolved` the way a browser resolves a link, so a path that starts with `/` replaces the base's path. A call that passes an empty path goes to the base. `trailingSlash: "required"` is for a library that refuses a base whose path does not end with `/`, as aiohttp does, and `trailingSlash: "added"` for one that ends the base's path with `/` itself, as httpx does.
- `.response(response)` says what the caller reads off the response and how the library hands back a refusal or a redirect, as [`responseSemantics` and `failureDelivery`](#responsesemantics-and-failuredelivery) describe. `redirectOption` says which option makes one call hand a redirect back.

For a library that takes the host apart from the path, as Ruby's `Net::HTTP.get(host, path)` does, the pack writes `hostFirst` on a method's URL, and reads a builder's host and port with `reads: "host"` on `.baseUrl`. A client built from a contract, as ts-rest's `initClient` builds one, is a [`clientCall`](#clientcall) pattern instead.

### A message a handler reads

A pack declares a consumer's receive with `messageReceives`. The receive is read at a call of the language's decoder for the codec, and each envelope is the path from what the platform hands the handler to the encoded payload, outermost first:

```ts
messageReceives({
  wire: "aws_sqs",
  codec: "json",
  envelope: [
    { path: [{ read: "Records" }, { each: true }, { read: "body" }] },
    { from: typed({ from: ["aws-lambda"], named: ["SQSRecord"] }), path: [{ read: "body" }] },
  ],
});
```

It records a `message-receive` interaction with no channel, since the deployment says which queue the handler drains. The body's fields are the keys the handler reads off the decoded value, at the decode or through the one name it keeps it in. A `read` step is a property or an entry with its key written out, an `each` step is the element a loop or a `map` callback is given, and `from` asks whether the value the last step reads off is declared as one of the types. Ruby declares no types, so an envelope with `from` matches nothing there.

## Recognizers

Recognizers fire on nodes inside a unit's body, whichever pack discovered the unit. A declared pack's recognizers come from `@suss/recognize`, and a pack can also write one as a function for a call no builder describes.

```typescript
type InvocationRecognizer<TCtx = unknown> = (
  call: unknown,   // CallExpression handle, opaque at this level
  ctx: TCtx,       // adapter context, TsInvocationRecognizerContext for TypeScript
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
- **A recognizer that throws is caught**, logged to stderr with the file and line, and skipped for that one call. The run continues, and pack health lists the failure under the pack, so its counts are not read as those of a pack that found nothing. TypeScript, Python and Ruby all do this.

Returning `null` means only "not my call". A field the pack could not read is a different thing: record the crossing and write null for the field. The binding builders throw on an empty string, so there is no way to fake one.

```ts
// The queue URL came from a variable. The send still happened.
messageBusBinding({
  recognition: "@suss/framework-aws-sqs",
  messageBus: "aws_sqs",
  channel: null,
});
```

Every adapter puts `ops` on `ctx`, the `CallOps` a declaration asks its questions of, and a declared recognizer reads nothing else. TypeScript's context, `TsInvocationRecognizerContext`, also has the call node, its source file and an `extractArgs()` helper. A recognizer written against those casts both arguments to that context, so it runs only in TypeScript. The Python and Ruby adapters put only `ops` on the context.

## Sub-units

```typescript
subUnits?: (parent: DiscoveredSubUnitParent, ctx: SubUnitOpsCarrier) => DiscoveredSubUnit[];

interface DiscoveredSubUnitParent {
  func: unknown;   // parent's function body handle
  name: string;    // e.g. "Counter"
  kind: string;    // e.g. "component"
}
```

`subUnits` returns extra units built from a parent's body. Use it when one construct the author wrote spawns several units that the runtime schedules, such as class-component lifecycle methods. A callback handed to a call, such as a Node `setTimeout` callback, a `useEffect` body or a TanStack Query function, is declared with `callbacks(...)` in `@suss/recognize` instead, and a function handed to a JSX attribute, such as a React event handler, with `renderedProps(...)`. Both compile to this hook.

`ctx` is a `SubUnitOpsCarrier` from `@suss/extractor`, and every adapter passes one. Its `calls(parent)` lists the calls the parent runs, as the same `CallOps` a recognizer gets, and `elements(parent)` lists the JSX elements it renders with their attributes. `writes(parent, fn)` says whether the parent's body writes a function, and `mentions(parent, word)` says whether the parent's file contains a word. Python and Ruby set only `calls`, and TypeScript sets all four.

Returned units go through the same pipeline top-level units do, and each becomes its own `BehavioralSummary`. Put per-unit `terminals` and `inputMapping` on the `DiscoveredSubUnit` when a sub-unit is written differently from the parent pack's defaults.

The parent's summary stops at every function a pack returned, and so does each sub-unit's. A timer callback written inside a click handler, with one pack returning the handler and another the callback, is read on the callback's summary and not on the handler's as well.

## Gates and per-project reading

### `requiresImport`

```typescript
requiresImport?: string[]
```

`requiresImport` gates the whole pack on its imports. The adapter's pre-filter only considers the pack applicable to files importing at least one of the listed modules, matched by prefix, so `"@aws-sdk/client-sqs"` matches that module and any sub-path of it.

It is for recognizer-only packs that target one library: the SQS pack declares `["@aws-sdk/client-sqs"]` and the Prisma pack `["@prisma/client"]`. Without a gate the pack walks every file, which is correct and wasteful. A discovery pattern has its own `requiresImport` for the same purpose, and an empty array is the deliberate "every file" choice. `pack()` writes the gate from the modules its declarations start at. The fetch pack sets none, because `fetch` is a global.

### `generatedModules`

```typescript
generatedModules?: {
  of: string
  markers?: string[]
  dirs?: (fromDir: string) => readonly string[]
}
```

A library with a code generator can write its module into a directory the project picks, and then the project imports it by relative path or through the tsconfig's `baseUrl` or `paths`, so `requiresImport` matches nothing. This field lets such an import count as an import of `of`, the package the generated module is a copy of. `markers` lists files the generator writes beside the module, and a directory with one of them in it counts when a relative import points there. `dirs` is for a generator that leaves no marker, or has not run yet: given the directory of the importing file, it returns the output directories the project's own configuration gives for that file, so an import into one counts, by a relative or a bare specifier, even before the generator has run. A bare specifier counts only through these directories, since a package such as `prisma/config` can map under `baseUrl` into a folder that contains a marker.

The TypeScript adapter reads the directories past the gate too. An import into one is recorded under `of` in the facts, so a chain's `constructedFrom(of)` matches a client made from the generated module, and a method declared in one counts as declared by `of` for `declaredBy`. The Prisma pack declares `of: "@prisma/client"`, with `schema.prisma` as the marker and the `output` of each `generator` block in the schema as the directories. The Python and Ruby adapters do not read the field yet.

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

A recognizer `declare` returns counts as the pack's own. Pack health counts its effects for the pack, and a throw from it goes on the pack's tally under `projectHelpers.invocationRecognizers`. When `declare` itself throws, the pack contributes nothing from the helpers, and pack health lists the failure under `projectHelpers.declare`.

### `transparentWrappers`

```typescript
transparentWrappers?: Array<{ module: string; name: string; argument: number }>
```

`transparentWrappers` declares a library wrapper that returns the argument passed to it. For a factory inside the project the adapter works this out on its own by reading the body. A library's body is not there to read, so the pack has to declare it. The declaration says which module exports the wrapper and under what name, so a call matches however the project imports it: by name, renamed, or read off a namespace import under any name. AWS Lambda declares `wrapHandler` from `@sentry/aws-serverless`, and Hono declares `createRoute` from `@hono/zod-openapi`. A Python pack takes the same field. A Ruby pack takes it too, but the Ruby adapter does not record which module a callee comes from, so a Ruby declaration matches no call yet.

### `parameterSuppliers`

```typescript
parameterSuppliers?: Array<{ module: string; name: string }>
```

`parameterSuppliers` lists parameter decorators whose call is the value a dependency injection container passes in. A constructor parameter written `@InjectRepository(User) private repo: Repository<User>` then reads as the call `InjectRepository(User)`, so a recognizer can match `this.repo.find()` by the decorator the value came from. The TypeORM pack declares `InjectRepository`, `InjectDataSource` and `InjectEntityManager` from `@nestjs/typeorm`.

### `environmentObjects` and `libraryEnvVars`

`environmentObjects` lists objects whose properties are the process environment, written as the dotted path the code uses (`"process.env"`). The adapter records a fact for each read from one of these objects whose index is not a literal. With that fact, suss can report the reads of a helper that takes a variable's name as a parameter at the calls that supplied the name. The Node pack declares it.

`libraryEnvVars` lists environment variables the library reads from inside `node_modules`, where suss does not look. Declaring them stops the checker from reporting a variable in a template as unused when the library reads it on every invocation. AWS Lambda declares the Powertools prefixes.

### `discoveryInputs`

```typescript
discoveryInputs?: (files: readonly string[]) => string[]
```

Files the pack reads that are not walked source files. Their content feeds the same cache key the pack's configuration does, so a run made after somebody edits one reads the project again. The AWS Lambda pack is the case this exists for: a SAM template declares which handlers exist, and no source file changes when that template does. Rails declares `config/routes.rb` the same way.

Code a library's generator writes belongs here too. The Prisma pack lists the schema and the type files of the client `prisma generate` writes, whether the generator puts it in the project or in `node_modules/.prisma/client`, so a run after `prisma generate` does not hand back summaries read against the old client.

A pack does not need to list a library it reads through `node_modules`. The TypeScript adapter adds the installed `package.json` of every library a pack's `requiresImport` gives, so installing another version of it misses the cache.

When `discoveryInputs` throws, the run goes on and caches without that pack's files in the key, and pack health lists the failure under the pack. Until the hook stops throwing, an edit to one of those files does not make the next run read the project again.

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

`failureDelivery` records how the client hands back a refused request. `fetch` returns a response and the caller reads the status off it, which is the `"response"` default, and requests, httpx, Faraday and Net::HTTP do the same. axios rejects instead, so every non-2xx reaches the caller through a `catch` and there is no status for a guard to read. `redirectDelivery` records the same for a redirect: fetch, axios, requests and aiohttp follow it, and httpx, Faraday and Net::HTTP hand the 3xx back.

A client declared with `httpRequests` states the same things on its chain's `.response(...)`: which members give the status, the success flag, the body and the headers, and the two deliveries. A TypeScript pack builds that from its pack fields with `clientResponseOf`, and a Python or Ruby client pack writes it out, as the requests pack writes `{ statusCode: ["status_code"], success: ["ok"], body: ["json", "text", "content"] }`.

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
