/**
 * The `PatternPack` interface a framework pack hands to a language adapter.
 * The pack describes what to look for (an import, a call, a decorator), and
 * the adapter finds it in its own language's syntax tree.
 *
 * Most of a pack is data, so one pack description works with any adapter
 * that reads these patterns. When a pack needs to compute something, the
 * usual fix is another declarative field here. The function hooks
 * (`subUnits`, `discoverUnits` and the recognizers) cover what data cannot.
 *
 * Sections follow the order an adapter uses them. The pack patterns
 * reference at https://suss.sh/packs/patterns shows each variant with the
 * code it matches.
 */

import type {
  CodeUnitKind,
  DeployableUnit,
  Effect,
  MessageBusSemantics,
  RequestSpellingMetadata,
} from "@suss/behavioral-ir";
import type { ProjectHelpers } from "./projectHelpers.js";

// =============================================================================
// Discovery
// =============================================================================

export type DiscoveryMatch =
  | {
      type: "namedExport";
      names: string[]; // e.g. ["loader", "action"] for React Router
    }
  | {
      type: "registrationCall";
      importModule: string; // e.g. "@ts-rest/express"
      importName: string; // e.g. "initServer"
      registrationChain: string[]; // e.g. [".router"]
    }
  | {
      type: "fileConvention";
      filePattern: string; // glob
      exportNames: string[];
    }
  | {
      type: "clientCall";
      /** Module the client is imported from, or "global" for built-ins like fetch */
      importModule: string;
      /** Named export or identifier, for example "initClient" or "fetch" */
      importName: string;
      /** If set, only match calls to these methods on the client (e.g. ["getUser"]).
       *  Unset means any method call (or bare call for globals). */
      methodFilter?: string[];
      /**
       * Methods on the import that build a client instance. A variable
       * initialized from one of these calls is a client too, so with
       * `factoryMethods: ["create"]`, `api.get(...)` after
       * `api = axios.create(...)` matches the same as `axios.get(...)`.
       */
      factoryMethods?: string[];
      /**
       * The option on the factory call's config that sets a base path for
       * every request through the instance, `baseURL` for axios. The
       * adapter puts it in front of each call's path, so the consumer's
       * route lines up with a spec whose `servers[0].url` adds the same
       * prefix to the provider's paths.
       */
      basePathOption?: string;
      /**
       * The import and every instance built from it can be called as a
       * function, so `axios(config)` and `api(config)` are requests the
       * same as a call through a method in `methodFilter`.
       */
      callable?: boolean;
    }
  | {
      /**
       * A constructor or factory call whose config object contains a
       * two-level resolver map, the usual way to write a code-first GraphQL
       * server. Outer keys are type names and inner keys are field names:
       *
       * ```ts
       * new ApolloServer({ typeDefs, resolvers: { Query: { users: async () => {...} } } });
       * ```
       *
       * Each inner function becomes one unit bound as
       * `graphql-resolver(typeName, fieldName)`. Both `new Ctor(cfg)` and
       * `ctor(cfg)` match, since Apollo's standalone server uses `new` and
       * yoga uses a bare call.
       */
      type: "resolverMap";
      importModule: string;
      importName: string;
      /**
       * The config property that contains the resolver map. The key belongs
       * to the library, so the adapter has no default. Apollo, yoga and
       * graphql-tools all use `"resolvers"`.
       */
      mapProperty: string;
      /**
       * Types whose fields are not discovered as resolvers, such as
       * `Subscription`. Leave it unset to discover every type.
       */
      excludeTypes?: string[];
    }
  | {
      /**
       * A consumer-side GraphQL hook call, the way Apollo Client and urql
       * are normally used. Each call to a listed hook becomes a `client`
       * unit bound as `graphql-operation(operationType, operationName?)`.
       *
       * The document can be an inline `gql` template, a const in this
       * module or an imported one, a `.graphql` or `.gql` file import, or a
       * `TypedDocumentNode` from graphql-codegen. When the body cannot be
       * read, the operation header comes from the `TypedDocumentNode` type
       * arguments. A document that still cannot be resolved is kept on the
       * summary as `metadata.graphql.unresolvedDocument`, so the boundary
       * stays.
       */
      type: "graphqlHookCall";
      importModule: string;
      /**
       * Hooks on that import, each with the operation type it performs
       * (`useQuery` performs a query). The type is used when the document's
       * header cannot be read. A matched call is a `client` unit unless the
       * enclosing `DiscoveryPattern.kind` says otherwise.
       */
      hooks: Array<{
        hookName: string;
        operationType: "query" | "mutation" | "subscription";
      }>;
    }
  | {
      /**
       * An imperative Apollo Client call: `client.query({ query })`,
       * `client.mutate({ mutation })` or `client.subscribe({ query })`. The
       * document is on a config property instead of the first argument,
       * which is why this is separate from `graphqlHookCall`.
       *
       * Discovery fires only when the named constructor (usually
       * `ApolloClient`) is imported, since otherwise any object with a
       * `query` method would match. Each `methods` entry gives the method,
       * the config property with the document on it, and the operation type
       * to use when the document's header is anonymous. A named header takes
       * precedence.
       */
      type: "graphqlImperativeCall";
      importModule: string;
      importName: string;
      methods: Array<{
        methodName: string;
        documentKey: string;
        operationType: "query" | "mutation" | "subscription";
      }>;
    }
  | {
      /**
       * A TypeScript package's public exports, as the provider side of an
       * in-process `function-call` boundary. The adapter reads
       * `package.json`, resolves each entry point (the root `.` and any
       * sub-path in `exports`), follows barrel re-exports, and emits one
       * unit per exported function.
       *
       * Each binding is keyed by package and export path, so
       * `@suss/behavioral-ir/schemas::BehavioralSummarySchema` has
       * `exportPath = ["schemas", "BehavioralSummarySchema"]`. The `types`,
       * `default` and `import` conditions are resolved, with `types`, `main`
       * and `module` as the fallback when there is no `exports` field.
       * Pattern exports (`./utils/*`) and `development` conditions are not.
       */
      type: "packageExports";
      /**
       * Absolute path to the package's `package.json`. Left out when
       * `workspaces` is set, since the workspace manifest lists the packages.
       */
      packageJsonPath?: string;
      /**
       * Apply the pattern to every package the workspace declares. Those
       * packages belong to the project, so the pack cannot list them; the
       * adapter reads the workspace manifest and applies the pattern to each.
       */
      workspaces?: true;
      /**
       * Restrict to these `exports` keys (without the leading `./`). The
       * root export is keyed `"."`. Leave it unset for every sub-path that
       * resolves.
       */
      subPaths?: string[];
      /**
       * Export names to skip, usually `["default"]` when a pack wants to
       * treat default exports separately or ignore them.
       */
      excludeNames?: string[];
    }
  | {
      /**
       * Methods with one of `methodDecorators` on a class with one of
       * `classDecorators`, the way NestJS declares resolvers. At least one
       * method decorator has to be imported from `importModule`, so a
       * project decorator that only shares a name does not match. A NestJS
       * GraphQL pack sets `classDecorators: ["Resolver"]` and
       * `methodDecorators: ["Query", "Mutation", "ResolveField", "Subscription"]`.
       *
       * The binding comes out as `graphql-resolver(typeName, fieldName)`.
       * `typeName` comes from `methodDecoratorTypeMap` when the method
       * decorator is in it, and otherwise from the class decorator's first
       * argument (`@Resolver(() => User)` gives `"User"`). `fieldName` comes
       * from the method decorator's `{ name }` option, or the method name.
       */
      type: "decoratedMethod";
      /**
       * The modules a decorator may be imported from. A project that wraps
       * a framework decorator and re-exports it needs its own module listed
       * too. Any one module in the list matching is enough.
       */
      importModule: string | string[];
      /**
       * Class decorators to match. The first one found on a class supplies
       * `typeName`, and the rest are fallbacks for projects with several
       * wrapper styles. A pack lists only its own framework's decorators and
       * takes a project's wrappers through its options.
       */
      classDecorators: string[];
      methodDecorators: string[];
      /**
       * Maps a method decorator to the type its field belongs to. NestJS
       * puts `@Query` on the root `Query` type whatever the class says, so an
       * entry here takes precedence over the class decorator's argument.
       *
       * When neither the map nor the class decorator gives a type, the
       * binding goes out with no type and pairs with nothing. That is safer
       * than claiming a field the schema does not have.
       */
      methodDecoratorTypeMap: Record<string, string>;
    }
  | {
      /**
       * A NestJS-style REST controller: a class decorated with
       * `@Controller(prefix?)` and methods decorated with `@Get(subpath?)`,
       * `@Post` and so on. The method decorator's name gives the HTTP method
       * through `methodDecoratorRouteMap`. The path is the class decorator's
       * first argument joined to the method decorator's, and both are
       * optional. The binding comes out as `rest(method, path)`.
       *
       * At least one route decorator on a method has to be imported from
       * `importModule`. Class decorators match by name alone, so a project's
       * own wrapper matches once the project lists it in the pack's options.
       */
      type: "decoratedRoute";
      importModule: string | string[];
      classDecorators: string[];
      /**
       * Decorator name to HTTP method, one entry per verb decorator. The
       * value becomes the REST binding's `method`; use `"*"` for a
       * catch-all decorator such as NestJS's `@All`.
       */
      methodDecoratorRouteMap: Record<string, string>;
    }
  | {
      /**
       * A `for-of` loop over a literal array of route specs, read as one
       * inline registration per element:
       *
       * ```ts
       * const routes = [{ method: "get", path: "/users", handler: getUsers }];
       * for (const r of routes) app[r.method](r.path, r.handler);
       * ```
       *
       * `elementShape` says which keys give the method, path and handler.
       * The loop body has to contain a call that uses the loop variable,
       * which filters out unrelated loops. The array can be inline or a
       * `const` one hop away. An array from another file is not expanded.
       */
      type: "registrationLoop";
      elementShape: {
        methodKey: string;
        pathKey: string;
        handlerKey: string;
      };
      /**
       * The routable the loop registers on. When set, the loop's body
       * must call a method on a variable constructed from one of these
       * imports, the same resolution a registration call's subject
       * gets. Without it, any loop over objects with the three keys
       * above matches, and a file that imports the library can contain
       * an unrelated one.
       */
      receiver?: {
        importModule: string;
        importNames: string[];
      };
    }
  | {
      /**
       * A helper call read as several inline registrations, with the call's
       * arguments substituted into a template for each. It covers helpers
       * like `registerCrud(app, "users", userHandlers)`, which
       * `registrationCall` cannot see.
       *
       * Each `registrations` entry is one route the helper produces.
       * `pathTemplate` and `handlerArg` use `{N}` for the call's Nth
       * argument: its value when it is a string literal, and otherwise its
       * source text with the slot marked opaque. `{N}.prop` reads `prop` from
       * the argument's resolved object. `importModule` narrows matches to a
       * helper imported from that module, for when two packages export the
       * same name.
       */
      type: "registrationTemplate";
      helperName: string;
      importModule?: string;
      /**
       * Which argument is the routable. A route the helper registers then
       * belongs to the same app as a route written beside the call, and the
       * middleware registered on that app applies to it too.
       */
      subject?: {
        argument: number;
        importModule: string;
        importNames: string[];
      };
      registrations: Array<{
        method: string;
        pathTemplate: string;
        handlerArg: string;
      }>;
    }
  | {
      /**
       * Routes declared as JSX elements, the way client-side routers write
       * them. It reads the tree form, where a child path joins its parent's
       * and an index route takes its parent's path, and the object form,
       * where a factory call takes an array of route objects with the same
       * property names. The pack supplies every name, and the adapter only
       * walks JSX and arrays.
       *
       * Each route with a readable path becomes one unit whose target is the
       * component its element attribute references, when that reference is
       * a single identifier. A route whose component cannot be read is still
       * reported, as a boundary with nothing behind it. A route whose path
       * cannot be read gets no path and a gap saying why.
       */
      type: "jsxElementRoute";
      /**
       * Modules the route element and factories must be imported from,
       * matched exactly. An aliased import still matches.
       */
      importModule: string | string[];
      /** The route element's exported name. */
      routeElement: string;
      /** The attribute with the route's path pattern on it. */
      pathAttribute: string;
      /** The attribute with the JSX the route renders on it. */
      elementAttribute: string;
      /**
       * The attribute that marks an index route, which renders at its
       * parent's path. Leave it unset if the library has no index routes.
       */
      indexAttribute?: string;
      /**
       * The property with the routes nested under a route object on it,
       * which is how the object form expresses what the JSX form expresses
       * by nesting. Paths compose the same way in both. Leave it unset if
       * the library's route objects do not nest.
       */
      childrenAttribute?: string;
      /**
       * Factory functions whose first argument is an array of route
       * objects keyed by the same three attribute names. The array is read
       * where it is written, or through the same value resolution the rest
       * of discovery uses, so a `const` binding one hop away works the
       * same as an inline literal.
       */
      routeObjectFactories?: string[];
      /**
       * Factory functions that turn JSX route elements into route objects.
       * The JSX walk already reads those elements wherever they appear.
       * Listing the factory keeps a route-object factory that is handed one
       * of these calls from being reported as an unreadable route array.
       */
      elementsFactories?: string[];
      /**
       * The HTTP method recorded on each route binding this produces. A page
       * route serves navigations, and the pack has to say which method those
       * use rather than the adapter assuming one.
       */
      method: string;
    }
  | {
      /**
       * The consumer side of the package-export boundary. The adapter finds
       * imports of the listed packages, records every call site, and emits
       * one `caller` unit per enclosing function, bound as
       * `function-call { package, exportPath }` to pair with the providers
       * `packageExports` finds.
       *
       * `packages` takes exact package names, with a sub-path where needed,
       * such as `"@suss/behavioral-ir/schemas"`. Named and default imports
       * are tracked. Namespace imports (`import * as X`) are not yet. When a
       * file in the consumer's repo re-exports the package and another file
       * imports it from there, the unit binds to that intermediate file.
       */
      type: "packageImport";
      /** Left out when `workspaces` is set. */
      packages?: string[];
      /**
       * Track imports of every package the workspace declares. A file
       * inside one workspace package importing another is the consumer
       * side of the package-export boundary, whichever two they are.
       */
      workspaces?: true;
    };

export type BindingExtraction = {
  method:
    | {
        type: "fromRegistration";
        position: "methodName" | number;
        /**
         * Registrations whose recorded method is something other than their
         * own name uppercased, the way `.all` registers every method and is
         * recorded as `"*"`. Anything missing from the map is recorded as
         * its own name uppercased.
         */
        nameMap?: Record<string, string>;
      }
    | { type: "fromExportName" }
    | { type: "fromContract" }
    | { type: "fromClientMethod" }
    | {
        type: "fromArgumentProperty";
        position: number;
        property: string;
        default?: string;
      }
    | { type: "literal"; value: string };
  path: /**
   * The path is the argument at this position. A name bound to a
   * string is followed one hop to what it was written as, and a
   * template's substitutions are read the same way, so
   * `app.get(USERS, h)` and `` fetch(`${BASE}/items/${id}`) `` both
   * come out with a path on them.
   */
    | { type: "fromArgument"; position: number }
    | {
        // The path is on a property of the argument at `position`, the way a
        // route object built by createRoute stores its path.
        type: "fromArgumentProperty";
        position: number;
        property: string;
      }
    | {
        /**
         * The route path comes from where the file is on disk, the way
         * Next.js and React Router describe routes. The pack gives the
         * framework's filename convention, and the adapter applies it.
         *
         * `app/api/orders/[id]/route.ts` under `{ root: "app",
         * dropBasenames: ["route"], dynamic: "brackets" }` comes out as
         * `/api/orders/{id}`, which pairs with an Express provider
         * writing `/api/orders/:id`.
         */
        type: "fromFilename";
        /**
         * Where a route path starts. The directories below it become the
         * path, and everything above it belongs to the project's own layout
         * and gets dropped.
         */
        root: string;
        /**
         * Filenames that say what kind of file it is rather than adding a
         * path segment: `route`, `page`, `index`, `_index`.
         */
        dropBasenames?: string[];
        /**
         * How the framework writes a parameter in a filename. Next.js
         * uses `[id]`, React Router uses `$id`.
         */
        dynamic?: "brackets" | "dollarPrefix";
        /**
         * Whether a directory in parentheses organises files without
         * appearing in the URL, as `app/(marketing)/about` does.
         */
        dropParenthesized?: boolean;
        /**
         * Whether one filename contains the whole path with dots between the
         * segments, the way `routes/orders.$id.tsx` does.
         */
        flat?: boolean;
      }
    | { type: "fromContract" }
    | { type: "fromClientMethod" };
};

/**
 * Where a declared channel's spelling comes from.
 *
 * `decoratorArgument` reads the argument off the same decorator the
 * match selected the handler by, so `@EventPattern("order.placed")`
 * gives "order.placed". `literal` is for a wire whose channel the
 * library fixes. `unstated` means the wire is known and the channel is
 * not, and it pairs the same as a null channel.
 */
export type ChannelSource =
  | { from: "decoratorArgument"; position: number }
  | { from: "literal"; value: string }
  | { from: "unstated" };

/**
 * A binding the pattern states outright, for a boundary the match
 * cannot read from the source. `bindingExtraction` only covers REST, so
 * a declarative pack for a queue or a topic states its binding here
 * instead of writing a callback. The fields are the ones a
 * `DiscoveredCustomUnit` returns. Only the message bus is supported.
 */
export type DeclaredBinding = {
  semantics: "message-bus";
  messageBus: MessageBusSemantics["messageBus"];
  channel: ChannelSource;
};

/**
 * How a framework takes a function that runs around a handler rather
 * than as one. Middleware and an error handler are registered through
 * a method on the routable, `app.use(fn)` or `app.onError(fn)`. A
 * validation hook is handed to the routable's constructor instead,
 * `new OpenAPIHono({ defaultHook })`, and runs for every route on it.
 */
export type WrapperRegistration =
  | WrapperMethodRegistration
  | WrapperOptionRegistration;

/** What every wrapper registration says about the function it registers. */
export interface WrapperFunctionShape {
  /**
   * Parameter position of the continuation inside the wrapper, the one
   * it calls to hand control on. Absent when the wrapper never
   * continues, which is how an error handler that always responds is
   * written.
   */
  continuationParam?: number;
  /**
   * Parameter position that receives what the wrapped unit threw. A
   * wrapper that declares one runs only when the wrapped unit's path
   * ended by throwing, which is a fact about how the framework invokes
   * it rather than anything its body says. Absent means the wrapper
   * runs on the ordinary path.
   */
  throwParam?: number;
  /**
   * Parameter position that receives a value the framework worked out
   * before calling the wrapper, the outcome of validating the request
   * for a hook. The pack's terminals read one parameter further along
   * from there, as they do past `throwParam`, and nothing else changes:
   * the wrapper still runs on the ordinary path.
   */
  resultParam?: number;
}

/** A wrapper registered through a method on the routable. */
export interface WrapperMethodRegistration extends WrapperFunctionShape {
  /** Method name that registers a wrapper, e.g. "use" or "onError". */
  method: string;
  /** Argument position of the wrapper function. */
  targetPosition: number;
  /**
   * Argument position of a path pattern narrowing which routes the
   * wrapper runs for, when the method takes one. Absent means the
   * wrapper runs for every route on the subject.
   */
  scopePosition?: number;
  /**
   * Only match a registered function declared with exactly this many
   * parameters. Express tells its error handlers apart from its
   * middleware by arity alone, both being `app.use(fn)`.
   */
  arity?: number;
}

/** A wrapper handed to the routable's constructor as an option. */
export interface WrapperOptionRegistration extends WrapperFunctionShape {
  /** The option the wrapper is under, e.g. "defaultHook". */
  constructorOption: string;
  /** Argument position of the options object in the constructor call. */
  targetPosition: number;
}

export interface DiscoveryPattern {
  /** The kind of code unit this discovers: "handler", "loader", "action", "component", etc. */
  kind: string;
  match: DiscoveryMatch;
  bindingExtraction?: BindingExtraction;
  /** A binding the pattern states outright. See `DeclaredBinding`. */
  binding?: DeclaredBinding;
  /**
   * How the routable this pattern discovers (Express's `Router()`, Hono's
   * `new Hono()`) is mounted on another under a path prefix, as in
   * `app.use(prefix, router)` or `app.route(prefix, sub)`. It only applies
   * when `match.type` is `"registrationCall"`, since mount discovery uses
   * that match's `importModule` and `importName` to find the routables.
   *
   * The adapter adds the prefix to every route on the mounted value, in
   * the mounting file or in the file an import leads to. A mount whose
   * prefix is not a string literal, or whose target the resolution store
   * cannot follow, adds nothing, and its routes keep the path they were
   * written with.
   */
  mount?: {
    /** Method name that registers a sub-router at a prefix, e.g. "use" or "route". */
    method: string;
    /** Argument position of the prefix string. */
    prefixPosition: number;
    /** Argument position of the mounted router/sub-app value. */
    targetPosition: number;
  };
  /**
   * How this framework registers a function that runs around a
   * handler rather than as one: middleware, an error handler, a
   * validation hook. Like `mount`, this only means anything when
   * `match.type` is `"registrationCall"`, because wrapper discovery
   * reuses that match's `importModule` and `importName` to work out
   * which variables in a file are the routable being registered on.
   *
   * When set, the registered function becomes a unit of its own and is
   * summarized like any other, and every unit registered on the same
   * routable records a reference to it. A registration whose function
   * the resolution store cannot follow contributes nothing.
   */
  wraps?: WrapperRegistration;
  /**
   * Run this pattern only on files that import one of these module
   * specifiers or a sub-path of one, so `"@nestjs/graphql"` also matches
   * `"@nestjs/graphql/dist/foo"`. An empty array runs it on every file, the
   * same as leaving it unset. Write `[]` out when that is deliberate, as
   * the fetch runtime does for global `fetch(...)` calls.
   *
   * The gate only saves time. The closure walk and the passes after
   * discovery can still reach every loaded file through symbol resolution.
   */
  requiresImport?: string[];
}

// =============================================================================
// Terminals
// =============================================================================

export type TerminalMatch =
  | {
      type: "returnShape";
      requiredProperties?: string[]; // e.g. ["status", "body"] for ts-rest
    }
  | {
      type: "returnStatement";
      /**
       * Skip a return whose value is a call or `new` expression. Set it when
       * a `parameterMethodCall` terminal already matches the inner call, so
       * `return reply.send(...)` produces one terminal instead of two.
       * Returns like `return user` and `return await fn()` still match.
       */
      excludeCallReturns?: boolean;
    }
  | {
      type: "parameterMethodCall";
      parameterPosition: number; // which param is the response object (1 for Express res)
      methodChain: string[]; // e.g. ["status", "json"]
      /**
       * Methods that return the response itself and change nothing the
       * terminal reads, so they may appear anywhere in the chain.
       * `res.set(h).status(201).json(b)` matches `["status", "json"]`
       * when `set` is listed here.
       */
      passThroughMethods?: string[];
    }
  | {
      type: "throwExpression";
      constructorPattern?: string; // e.g. "HttpError"
    }
  | {
      type: "functionCall";
      functionName: string; // e.g. "json", "redirect". Matches calls to a function with this name
      /**
       * Only match when the name was imported from one of these modules,
       * by prefix, the same as `DiscoveryPattern.requiresImport`.
       *
       * Set it whenever the function belongs to a library. A bare name also
       * matches the project's own functions, and `json` is a common name
       * for a project's response helper. Reading a library's argument order
       * into one of those gives a confident wrong answer. To cover a project
       * helper, declare the envelope with a `returnShape` terminal instead:
       * the adapter follows a returned call into the project and reads the
       * helper's parameters, whatever the helper is called.
       */
      requiresImport?: string[];
    }
  | {
      /**
       * A return statement whose value is a JSX element or fragment. The
       * root element or component name is recorded in
       * `RawTerminal.component`. React, and any other JSX-based framework
       * pack, uses this to classify component output as a `render` terminal.
       */
      type: "jsxReturn";
    }
  | {
      /**
       * The implicit fall-through at the end of a function body. It fires
       * when the last statement is neither a return nor a throw, which is
       * how most event handlers and effect bodies end. Without it, such a
       * summary comes out with no transitions. Packs for callback bodies
       * (React handlers, `useEffect`, Node `.on(...)`) include it, and HTTP
       * handler packs that expect explicit returns leave it out.
       */
      type: "functionFallthrough";
    }
  | {
      /**
       * A call to the parameter at this position, `next()` inside a
       * middleware. Packs do not declare it; the adapter builds it from
       * `DiscoveryPattern.wraps.continuationParam`. A wrapper path that
       * hands control on then ends in a `delegate` output, and composition
       * uses that to tell it from a path that responds first.
       */
      type: "parameterCall";
      parameterPosition: number;
    };

export interface TerminalExtraction {
  statusCode?:
    | { from: "property"; name: string } // { status: 200 } → name: "status"
    | { from: "argument"; position: number; minArgs?: number } // res.status(200) → position: 0
    | { from: "constructor"; codes: Record<string, number> } // throw new NotFound() → 404 via { NotFound: 404 }
    | {
        // NextResponse.json(body, { status: 404 }): the status is on a
        // property of the argument at `position`, rather than being the
        // argument itself.
        from: "argumentProperty";
        position: number;
        name: string;
      }
    | {
        // throw wrap(new NotFound(...)): a project helper wraps the error, so
        // the status comes from the class of the argument at `position`,
        // matched against `codes`, instead of from what is thrown.
        from: "argumentConstructor";
        position: number;
        codes: Record<string, number>;
      };
  body?: // { body: data } gives name: "body". `unwrapJsonStringify` reads
  // `JSON.stringify(x)` as the type of `x`, for Lambda proxy handlers whose
  // body is the serialized payload. Off by default.
    | { from: "property"; name: string; unwrapJsonStringify?: boolean }
    | { from: "argument"; position: number; minArgs?: number }; // res.json(data) → position: 0
  /** Fallback status code when none is extracted. e.g. Express res.json() defaults to 200. */
  defaultStatusCode?: number;
}

export interface TerminalPattern {
  /** What kind of output this terminal produces: "response", "throw", "return", "render", "delegate" */
  kind: "response" | "throw" | "return" | "render" | "delegate";
  match: TerminalMatch;
  extraction: TerminalExtraction;
  /**
   * On a throw terminal: the framework turns the thrown status into
   * the wire response, so a resolved status makes the output a
   * response. HTTP packs state this; a pack reading a non-HTTP code
   * space off throws leaves it off and the throw stays a throw (#149).
   */
  producesResponse?: boolean;
}

// =============================================================================
// Contract reading
// =============================================================================

export interface ContractPattern {
  /** How to find the contract object. A contract is a data structure rather
   *  than a code unit, so this needs less than a DiscoveryPattern does. */
  discovery: {
    importModule: string; // e.g. "@ts-rest/core"
    importName: string; // e.g. "initContract"
    registrationChain: string[]; // e.g. [".router"]
  };
  responseExtraction: {
    /** The property on the contract object with the responses map on it */
    property: string;
  };
  /**
   * The properties an endpoint states its HTTP method and path under.
   * The names belong to the library, so the pack supplies them. ts-rest
   * and zod-openapi both use `method` and `path`.
   */
  methodProperty: string;
  pathProperty: string;
  paramsExtraction?: {
    property: string;
  };
  /**
   * Where the reader finds one endpoint's contract object. Left out,
   * the ts-rest shape applies: one contract object contains every
   * endpoint keyed by handler name, and the reader walks up from the
   * handler to the enclosing router call. With `registrationArgument`,
   * the zod-openapi shape applies instead: `app.openapi(route, handler)`
   * passes the endpoint's own contract as the handler's sibling
   * argument.
   */
  endpoint?: { from: "registrationArgument"; position: number };
}

// =============================================================================
// Input mapping
// =============================================================================

export type InputMappingPattern =
  | {
      /** Positional parameters, e.g. Express (req, res, next) */
      type: "positionalParams";
      params: Array<{ position: number; role: string }>;
    }
  | {
      /**
       * One object parameter whose properties are the inputs, the way
       * ts-rest passes `{ params, body, query }` and React Router passes
       * `{ params, request }`. A handler that destructures it gets one
       * input per name it binds; a handler that takes it whole gets a
       * single input, since the source does not say which properties it
       * reads.
       */
      type: "objectParam";
      /** Defaults to the first parameter. */
      paramPosition?: number;
      /** Property name mapped to the role it takes, e.g. `{ params: "pathParams" }`. A name not here keeps the name it was bound under. */
      knownProperties: Record<string, string>;
      /** The role for a parameter taken whole. Defaults to "request". */
      wholeParamRole?: string;
    }
  | {
      /**
       * Component props, React / Vue / Svelte-style: one parameter that
       * the caller destructures at will, with prop names only visible at
       * the call site. When the parameter is destructured, each bound
       * name becomes its own Input with the name as its role. When it is
       * not destructured (`function X(props) {...}`), a single Input comes
       * out with `wholeParamRole`, which defaults to `"props"`.
       *
       * This differs from `objectParam` in two ways. The pack declares no
       * prop names up front, since they are whatever the component author
       * wrote, and each input records the type text of the prop, which a
       * component's shape comparison reads.
       */
      type: "componentProps";
      paramPosition: number;
      /** Role for the single Input when the param is not destructured. Defaults to "props". */
      wholeParamRole?: string;
    }
  | {
      /**
       * One input per declared parameter, in source order, with the
       * parameter's name as its role unless `defaultRole` is set. The
       * reachable-closure pass uses it for internal library functions,
       * where no framework assigns roles. Destructured parameters work as
       * in `objectParam`, so `(ctx, { userId })` gives `ctx` and `userId`.
       */
      type: "allPositional";
      defaultRole?: string;
    }
  | {
      /**
       * NestJS-style parameter decorators. The adapter looks up each
       * parameter's first decorator in `decoratorRoleMap`. A match gives the
       * role, and a parameter that matches nothing gets `defaultRole` or is
       * skipped. For `@nestjs/graphql` resolvers the map is
       * `{ Args: "args", Parent: "parent", Context: "context", Info: "info" }`.
       * Decorators match by name alone, so every framework's `@Args` maps
       * the same way.
       */
      type: "decoratedParams";
      decoratorRoleMap: Record<string, string>;
      defaultRole?: string;
    };

// =============================================================================
// Response property semantics
// =============================================================================

/**
 * What a property on the API response object means. The pack declares this so
 * the adapter can work out a derived property at extraction time, the way
 * `.ok` means a status somewhere in 200 to 299.
 */
export type ResponsePropertyMeaning =
  | { type: "statusCode" }
  | { type: "statusRange"; min: number; max: number }
  | { type: "body" }
  | { type: "headers" };

/** Whether a refused request comes back as a response or as an exception. */
export type FailureDelivery = "response" | "exception";

export interface ResponsePropertyMapping {
  /** Property or method name on the response (e.g. "ok", "status", "json") */
  name: string;
  /** How this member is accessed: property read or method call */
  access: "property" | "method";
  /** What the value means */
  semantics: ResponsePropertyMeaning;
}

// =============================================================================
// PatternPack
// =============================================================================

/**
 * A library wrapper that returns the function it was handed. For a factory
 * declared inside the project, the adapter works this out on its own by
 * reading the body. A library's body is not there to read, so the pack has to
 * say so.
 */
export interface TransparentWrapper {
  /**
   * The module that exports the wrapper, e.g. "@sentry/aws-serverless".
   * A call matches whatever the project calls the import, and a local
   * function spelled the same way does not match.
   */
  module: string;
  /** The name the module exports the wrapper under, e.g. "wrapHandler". */
  name: string;
  /** Which argument the wrapped function is passed as. */
  argument: number;
}

export interface PatternPack {
  name: string;
  /**
   * The pack's version, part of the cache key. Change it whenever a change
   * affects discovered units or summaries; any string works.
   *
   * It is optional because the CLI hashes the pack file it loaded and the
   * config it passed into the key, so an edit invalidates the cache
   * whether or not the version moved. A host that loads packs another way
   * has to do that itself. A pack with nothing to stamp is keyed as
   * `"unset"`, and a warm cache then serves stale results after an edit.
   */
  version?: string;
  /**
   * Files under the project this pack reads that are not source files,
   * given the files the run is about to walk. Their content feeds the
   * same cache key the pack's own config does, so a run made after
   * somebody edits one reads the project again instead of handing back
   * the previous answer.
   *
   * The aws-lambda pack is the case this exists for: a SAM template
   * decides which handlers there are and what invokes them, and no
   * source file changes when that template does. A pack that reads only
   * the code it is handed leaves this out.
   */
  discoveryInputs?: (files: readonly string[]) => string[];
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
  /**
   * For a REST pack, where in the handler each part of the request is
   * read, in the same words `inputMapping` gives the parameters: an
   * Express handler reads a header at `request.headers`, a Lambda
   * handler at `event.headers`. The adapter stamps this on every route
   * the pack recognizes, and the intent pass rewrites the route's reads
   * from it into the sections an author writes under `receives`.
   *
   * Leave it out on a pack whose handlers do not take a request, and
   * leave a section out when the framework has no path for it.
   */
  requestSpelling?: RequestSpellingMetadata;
  /**
   * The transport written into `BoundaryBinding.transport` on discovered
   * units, such as `"http"` or `"in-process"`. It is required so a pack
   * for React, queues or Lambda invocation never inherits an HTTP default
   * that does not fit it. The pack's `name` fills in
   * `BoundaryBinding.recognition`, and the adapter derives `semantics`
   * from the discovery pattern's binding extraction.
   */
  protocol: string;
  /**
   * What the properties on the API response object mean, consumer side.
   * This tells the adapter how to turn a derived property like `.ok` or
   * `.json()` into a structured IR construct instead of leaving it opaque.
   */
  responseSemantics?: ResponsePropertyMapping[];
  /**
   * How this client hands back a response the server refused. `fetch`
   * returns one and the caller reads the status off it. axios and ky
   * reject instead, so every non-2xx reaches the caller through a
   * `catch` and there is no status for a guard to read. Defaults to
   * `"response"`.
   */
  failureDelivery?: FailureDelivery;
  /**
   * Build extra code units from a parent unit's body, for callbacks the
   * runtime schedules that are not top-level declarations: React event
   * handlers on JSX elements, `useEffect` bodies, Node `emitter.on(...)`
   * handlers. Each returned unit goes through the same extraction as a
   * discovered one and gets its own summary. Set `terminals` or
   * `inputMapping` on a sub-unit when it differs from the pack's defaults.
   *
   * `ctx` is `unknown` because each adapter defines its own context type
   * (`TsSubUnitContext` in `@suss/adapter-typescript`) with the primitives
   * for walking the parent's syntax tree. A pack casts to the context it
   * was written against, which ties the pack to that adapter.
   */
  subUnits?: (
    parent: DiscoveredSubUnitParent,
    ctx: unknown,
  ) => DiscoveredSubUnit[];
  /**
   * The pack's own top-level discovery, for a convention none of the
   * `DiscoveryMatch` variants fits, such as React's component-export
   * heuristic or Storybook's `.stories.tsx` files. Keeping those in the
   * pack leaves the `DiscoveryMatch` union to patterns any pack can share.
   * The adapter calls it once per source file beside the data-driven
   * discovery, and the units it returns go through the normal pipeline
   * with the same per-unit overrides.
   *
   * `ctx` is `unknown` for the same reason as in `subUnits`
   * (`TsDiscoveryContext` in `@suss/adapter-typescript`). When this finds
   * a unit at the same function and kind as another pack's discovery, the
   * pack that comes first in the framework list claims it.
   */
  discoverUnits?: (sourceFile: unknown, ctx: unknown) => DiscoveredCustomUnit[];
  /**
   * Per-call recognizers that emit typed `Effect`s beside the generic
   * `invocation` effect. The adapter calls each one on every call in the
   * function body, whichever pack discovered the function, and skips
   * nested functions, which are units of their own. Calls the invocation
   * walk skips, such as `const x = await fn(...)` initializers, are included.
   *
   * Returned effects are added to the enclosing default transition, and
   * the `invocation` effect stays. Return `null` or `[]` for no match.
   * Nothing dedupes across calls, so a recognizer that should fire once
   * per identifier tracks that itself. One that throws is logged with its
   * file and line and skipped for that call. `call` and `ctx` are the
   * adapter's own types, which a recognizer casts to as `subUnits` does.
   */
  invocationRecognizers?: InvocationRecognizer[];
  /**
   * A pack-level import gate: the pack applies only to files that import
   * one of these modules, matched by prefix. A pack with only recognizers
   * uses it the way a discovery pattern uses its own `requiresImport`;
   * `@suss/framework-prisma` declares `["@prisma/client"]`. Without a gate
   * the pack walks every file, which gives the same result and is slow in
   * a large monorepo. Leave it empty for recognizers that apply
   * everywhere, such as `process.env` reads, which need no import.
   */
  requiresImport?: string[];
  /**
   * Files this library's code generator writes beside the module it
   * generates, e.g. `["schema.prisma"]`. A project can point the
   * generator at a directory of its own, and then every consumer
   * imports the module by relative path and `requiresImport` matches
   * nothing. A directory containing one of these files counts as the
   * gated package, so those consumers reach the pack the way an
   * ordinary import would.
   */
  generatedModuleMarkers?: string[];
  /**
   * Functions the project itself wrote in front of this library, read
   * once across the whole project before any file is walked. What the
   * pack makes of them joins its own patterns and recognizers for the
   * rest of the run.
   */
  projectHelpers?: ProjectHelpers;
  /**
   * Environment variables the library reads from inside node_modules,
   * where no walk looks. Without them the checker would report a variable
   * in a template as unused when the library reads it on every invocation.
   * The adapter emits one marker summary per entry whose `module` some
   * project file imports, and runtime-config pairing checks the markers
   * before reporting. `module` matches as a prefix, so one entry covers a
   * family like `@aws-lambda-powertools/`.
   */
  libraryEnvVars?: Array<{
    /** Module-specifier prefix the library's imports start with. */
    module: string;
    /** Env-var name prefixes the library reads, e.g. "POWERTOOLS_". */
    prefixes?: string[];
    /** Exact env-var names the library reads. */
    names?: string[];
  }>;
  /**
   * Library wrappers that return the function they were handed. A call to
   * the `name` that `module` exports resolves to its `argument`-th
   * argument. See `TransparentWrapper`.
   */
  transparentWrappers?: TransparentWrapper[];
  /**
   * Objects whose properties are the process environment, written as
   * the dotted path the code spells, e.g. `"process.env"`. The adapter
   * states a fact for a read off one of these whose index is not a
   * literal, which is how a helper that takes the variable's name as a
   * parameter gets its reads reported at the calls that named them.
   */
  environmentObjects?: string[];
  /**
   * How this library's client object is constructed, so an operation
   * summary can say which endpoint its calls go to. Each entry is a
   * constructor or factory imported from `importModule`, with
   * `uriProperty` the option key whose value is the endpoint. The
   * adapter reads every construction in the project and stamps the
   * client on each operation summary when exactly one distinct client
   * exists; two or more distinct clients abstain, since a hook call
   * does not say which one it goes through.
   */
  graphqlClients?: Array<{
    importModule: string;
    importName: string;
    uriProperty: string;
    /**
     * How this constructor's cache option installs a fragment
     * registry, for the library whose client can supply fragment
     * definitions at run time. `cacheProperty` is the construction
     * option the cache is passed in, `cacheConstructor` the cache
     * class, and `registryProperty` the cache option that installs
     * the registry. The adapter reads every construction and records
     * whether a registry is configured, absent, or unreadable; a
     * construction it cannot read counts as unreadable, never as
     * absent.
     */
    fragmentRegistry?: {
      cacheProperty: string;
      cacheConstructor: { importModule: string; importName: string };
      registryProperty: string;
    };
  }>;
  /**
   * Which service a client talks to, keyed by the endpoint the
   * construction was read with: the uri literal, or the written
   * expression when the value is computed. The value is the provider
   * workspace name. This is deployment knowledge, so it comes from the
   * pack's own per-project config rather than from the library.
   */
  graphqlClientBindings?: Record<string, string>;
  /**
   * Which service the operations in a set of files talk to, for a
   * project whose one frontend uses two clients. A hook call does not
   * say which client it goes through, so when the sole-client rule
   * cannot decide, these globs do: an operation whose file matches
   * gets the entry's workspace. First matching entry wins.
   */
  graphqlOperationScopes?: Array<{ files: string[]; workspace: string }>;
  /**
   * Per-access recognizers, the counterpart to `invocationRecognizers` for
   * values read without a call, such as `process.env.X`. A recognizer is
   * handed a property access, a call or a tagged template, and checks the
   * node itself. The tagged template covers libraries that take a whole
   * template as one argument, like `prisma.$queryRaw` and `gql`. Scope,
   * emission and argument types follow the `invocationRecognizers` rules.
   */
  accessRecognizers?: AccessRecognizer[];
  /**
   * What the pack wrote as data, for the pack health report. A pack
   * written as a hand-rolled walk leaves it out, and the report says so.
   */
  declarations?: PackDeclarations;
}

/**
 * How much of what a pack matches is declared as data and how much is
 * code, counted for the pack health report. A link given as data can be
 * inspected, serialized and run by any adapter. A link given as a
 * function only runs in its own language. Both are allowed, and the
 * report counts each kind.
 */
export interface PackDeclarations {
  declarations: DeclaredMatch[];
}

/** One thing a pack declared it matches. */
export interface DeclaredMatch {
  /** What it matches, in the pack's own words. */
  name: string;
  /** Links whose answer is data. */
  dataLinks: number;
  /** Links answered with a function, by the question each one asks. */
  functionLinks: string[];
  /**
   * Links whose function reaches the adapter's own syntax tree, by the
   * question each one asks. Reaching the tree needs a separate import,
   * so a pack cannot arrive here without saying so.
   */
  astLinks: string[];
  /** A line of code the pack says this matches, or null when it says none. */
  example: string | null;
}

/**
 * Per-call recognizer hook. `PatternPack.invocationRecognizers` says when
 * it is called and what it returns.
 */
export type InvocationRecognizer<TCtx = unknown> = (
  call: unknown,
  ctx: TCtx,
) => Effect[] | null;

/**
 * Per-access recognizer hook. `PatternPack.accessRecognizers` says when
 * it is called and what it returns.
 */
export type AccessRecognizer<TCtx = unknown> = (
  access: unknown,
  ctx: TCtx,
) => Effect[] | null;

/**
 * The parent unit a `subUnits` hook works inside. `func` is opaque because
 * each adapter has its own function-root type; adapter context types such
 * as `TsSubUnitContext` narrow it.
 */
export interface DiscoveredSubUnitParent {
  /** Handle to the parent's function body. Opaque at extractor level. */
  func: unknown;
  /** Discovered name of the parent (e.g. "Counter"). */
  name: string;
  /** Kind of the parent (usually "component", "handler", etc.). */
  kind: string;
}

/**
 * One top-level unit a pack's `discoverUnits` hook found. The adapter
 * widens it into its own internal unit type and runs it through the
 * normal extraction pipeline. `func` is whatever the adapter's primitive
 * returned, and the adapter narrows it to its function-root type
 * (`FunctionRoot` in `@suss/adapter-typescript`).
 */
export interface DiscoveredCustomUnit {
  /** Function body handle, opaque here. */
  func: unknown;
  /** IR code-unit kind (e.g. "component", "handler"). */
  kind: string;
  /** Discovered name (e.g. "UserCard"). */
  name: string;
  /**
   * The module the unit is exported from and its export name, when the
   * pack states them. Server actions use this so intent and keyed pairing
   * can refer to them. The adapter puts both on the function-call binding.
   */
  functionCallInfo?: { module: string; exportName: string };
  /**
   * Terminal patterns to extract from this unit's body. Defaults to
   * the pack-level `terminals` when unset.
   */
  terminals?: TerminalPattern[];
  /**
   * Input mapping for this unit. Defaults to the pack-level
   * `inputMapping` when unset.
   */
  inputMapping?: InputMappingPattern;
  /**
   * The REST route for a unit found through an external manifest, such as
   * a SAM template's `Events` block, instead of an in-code registration.
   * The adapter builds a `rest` binding from it, the same one a NestJS
   * controller gets. Leave either half null when the source does not
   * state it; a binding missing one pairs with nothing.
   *
   * A function bound to several routes returns one unit per route. The
   * per-file claim dedup keys on function, kind, method and path, so all
   * of them are kept.
   */
  routeInfo?: { method: string | null; path: string | null };
  /**
   * GraphQL field identity for units a callback discovers against an
   * external manifest rather than an in-code resolver map. AppSync
   * routes a field to a Lambda in the deploy template, so the field is
   * the boundary that code serves. When set, the adapter builds a
   * `graphql-resolver` binding from `(typeName, fieldName)`, which
   * pairs with the operations a client sends.
   */
  resolverInfo?: { typeName: string; fieldName: string };
  /**
   * Message-bus channel identity for consumer units a callback discovers
   * against a subject the code itself gives (a handler factory whose
   * config states the subject it expects). When set, the
   * adapter builds a `message-bus` binding from `(messageBus, channel)`,
   * which pairs with producers sending on the same channel.
   */
  channelInfo?: {
    messageBus: MessageBusSemantics["messageBus"];
    /** Null when the pack knows the wire but not the channel on it. */
    channel: string | null;
  };
  /**
   * The deployed unit this one is, for a unit nothing else routes to.
   * A Lambda with no event source in its template is reached by being
   * invoked by name, so its own platform and name are the boundary, and
   * the adapter builds a `unit-invocation` binding from them. Set it
   * where a unit would otherwise fall back to a keyless function-call.
   */
  invocationInfo?: DeployableUnit;
  /** The thing that gets deployed and runs this unit, when known. */
  deployableUnit?: DeployableUnit;
  /**
   * Metadata merged onto the resulting summary's `metadata` field.
   */
  metadata?: Record<string, unknown>;
}

/**
 * One child unit a pack's `subUnits` hook built. The adapter extracts and
 * assembles it the same way as a top-level unit.
 */
export interface DiscoveredSubUnit {
  /** Function body handle, opaque here. */
  func: unknown;
  /** IR code-unit kind (e.g. "handler"). */
  kind: CodeUnitKind;
  /** Qualified name (e.g. "Counter.button.onClick"). */
  name: string;
  /**
   * Terminal patterns to extract from this sub-unit's body. When unset it
   * defaults to `return` and `throw`, which suits handlers and effects.
   */
  terminals?: TerminalPattern[];
  /**
   * Input mapping for this sub-unit. When unset it defaults to an empty
   * positional mapping, so an event handler with one argument should pass
   * `{ type: "positionalParams", params: [{ position: 0, role: "event" }] }`.
   */
  inputMapping?: InputMappingPattern;
  /**
   * Metadata merged onto the resulting summary's `metadata` field.
   * Packs use this to stamp provenance (`metadata.react = { kind: "handler", ... }`).
   */
  metadata?: Record<string, unknown>;
}
