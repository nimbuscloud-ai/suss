/**
 * The `PatternPack` interface, which is what a framework pack gives a language
 * adapter. The pack says WHAT to look for (which import, which call, which
 * decorator); the adapter knows HOW to find that in its language's AST.
 *
 * Everything here is data, never code. A pack describes a library once and any
 * adapter that understands these patterns can apply it. If you want a pack to
 * compute something, the answer is usually another declarative field here.
 *
 * The sections run in the order an adapter uses them: discovery finds candidate
 * code units, terminals describe how a unit finishes, contract reading and
 * input mapping describe what it declares and takes in, and response property
 * semantics say which property is the body and which is the status.
 */

import type {
  DeployableUnit,
  Effect,
  MessageBusSemantics,
} from "@suss/behavioral-ir";

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
       * Method names on the import that produce a client-equivalent instance,
       * so variables initialized from those calls also act as discovery
       * subjects. axios uses `axios.create({...})` to build a baseURL-bound
       * instance; declaring `factoryMethods: ["create"]` lets the adapter
       * treat `api.get(...)` (where `api = axios.create(...)`) the same as
       * `axios.get(...)`.
       */
      factoryMethods?: string[];
    }
  | {
      /**
       * A constructor or factory call that takes a configuration object
       * containing a resolver map, which is how code-first GraphQL servers
       * are usually written. The map is two levels deep: outer keys are
       * GraphQL type names (`Query`, `Mutation`, `Subscription`, or
       * object-type names like `User`), and inner keys are field names
       * whose values are resolver functions.
       *
       * Example (Apollo Server v4):
       * ```ts
       * new ApolloServer({
       *   typeDefs,
       *   resolvers: {
       *     Query:    { users: async () => {...} },
       *     Mutation: { createUser: async (_, {input}) => {...} },
       *     User:     { fullName: (parent) => `${parent.first} ${parent.last}` },
       *   },
       * });
       * ```
       *
       * Each inner function becomes one discovered unit whose binding
       * semantics is `graphql-resolver(typeName, fieldName)`. Both
       * `new Ctor(cfg)` and `ctor(cfg)` match, because Apollo's standalone
       * server uses `new` and yoga uses a bare call.
       */
      type: "resolverMap";
      importModule: string;
      importName: string;
      /**
       * The property on the config object that contains the resolver map.
       * This is the library's own config key, so the pack has to give it and
       * the adapter ships no default. Apollo, yoga, and graphql-tools all
       * spell it `"resolvers"`.
       */
      mapProperty: string;
      /**
       * GraphQL types whose fields we DON'T treat as resolvers. This is the
       * opt-out for meta-types like `Subscription` that we may want to handle
       * differently later. Leave it unset to discover every type.
       */
      excludeTypes?: string[];
    }
  | {
      /**
       * A consumer-side GraphQL hook call, the way Apollo Client and urql
       * are normally used. Each call to one of the listed hooks becomes
       * a `client`-kind code unit whose binding semantics is
       * `graphql-operation(operationType, operationName?)`.
       *
       * The document argument can be written several ways: an inline
       * `gql`-tagged template, a const binding (in this module or imported
       * from another one), a `.graphql` or `.gql` file import, or a
       * generated `TypedDocumentNode` object literal from graphql-codegen
       * client-preset. When the document body cannot be read statically,
       * the operation header falls back to the `TypedDocumentNode` type
       * arguments. A document that still cannot be resolved shows up on the
       * summary as `metadata.graphql.unresolvedDocument`, so the boundary is
       * kept rather than dropped.
       *
       * Example:
       * ```ts
       * import { gql, useQuery } from "@apollo/client";
       * const GET_USER = gql`query GetUser($id: ID!) { user(id: $id) { id } }`;
       * function UserPage({ id }) {
       *   const { data } = useQuery(GET_USER, { variables: { id } });
       *   ...
       * }
       * ```
       *
       * The adapter records the operation name and type on the
       * DiscoveredUnit's `operationInfo`, and binding construction uses that
       * to emit `graphql-operation(...)`. The per-hook `operationType`
       * wins when the document header cannot be read, the same way
       * `graphqlImperativeCall.methods` does.
       */
      type: "graphqlHookCall";
      importModule: string;
      /**
       * Hooks to match on that import, each mapped to the operation type it
       * performs (`useQuery` to query, `useMutation` to mutation,
       * `useSubscription` to subscription). That mapping supplies the
       * operation type when the document body cannot be read statically.
       * Each hook is reported as `kind = "client"` unless a pack overrides
       * that through the enclosing `DiscoveryPattern.kind`.
       */
      hooks: Array<{
        hookName: string;
        operationType: "query" | "mutation" | "subscription";
      }>;
    }
  | {
      /**
       * An imperative Apollo-Client-style call: `client.query({ query })`,
       * `client.mutate({ mutation })`, `client.subscribe({ query })`. This is
       * separate from hook calls because the document is on a config-object
       * property rather than the first positional argument.
       *
       * Discovery only fires when the named constructor (usually
       * `ApolloClient`) is imported, because otherwise any object at all
       * with a `query` method would look like a match.
       *
       * Each entry in `methods` specifies the method called on the client
       * (`"query"`, `"mutate"`, or `"subscribe"`) and the config-object
       * property that contains the gql document
       * (`"query"`, `"mutation"`, and `"query"` respectively). The method
       * name decides the operation type when the gql document's header is
       * anonymous. When the document has a name, its header wins.
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
       * Treats a TypeScript package's public export surface as a
       * boundary. The adapter reads `package.json` at `packageJsonPath`,
       * resolves each reachable entry point (root `.` and any sub-path
       * `exports`), follows barrel re-exports, and emits one discovered
       * unit per exported function. Those units are the provider side of
       * an in-process `function-call` boundary.
       *
       * The bindings this produces have the identity
       * `{ transport: "in-process",
       *    semantics: { name: "function-call",
       *                 package: <pkg.name>,
       *                 exportPath: [...] },
       *    recognition: <pack.name> }`.
       *
       * A sub-path export is identified as, for example,
       * `@suss/behavioral-ir/schemas::BehavioralSummarySchema`, giving
       * `exportPath = ["schemas", "BehavioralSummarySchema"]`. A root export
       * leaves the sub-path segment out.
       *
       * As of v0 this resolves the `types`, `default`, and `import`
       * conditions on `exports`, and falls back to `types`, `main`, `module`
       * when there is no `exports` field. Pattern exports (`./utils/*`) and
       * `development` conditions are not handled yet.
       */
      type: "packageExports";
      /** Absolute path to the package's `package.json`. */
      packageJsonPath: string;
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
       * Class methods with a particular decorator, on classes with a
       * particular class-level decorator. NestJS-style frameworks work this
       * way: resolvers, handlers, and controllers are declared by decorator
       * rather than by registering a function in an object literal.
       *
       * Discovery only fires when `classDecorator` and each
       * `methodDecorators` entry come from `importModule`, so a user-defined
       * decorator that happens to share a name will not match.
       *
       * For a NestJS GraphQL pack:
       * `{ importModule: "@nestjs/graphql",
       *    classDecorator: "Resolver",
       *    methodDecorators: ["Query", "Mutation", "ResolveField",
       *                       "Subscription"] }`
       *
       * The adapter fills in `DiscoveredUnit.resolverInfo` so the binding
       * comes out as `graphql-resolver(typeName, fieldName)`.
       * `typeName` resolves from `methodDecoratorTypeMap` when the
       * method decorator is in it, and otherwise from the class
       * decorator's first argument (`@Resolver(() => User)` gives
       * `"User"`). `fieldName` comes from the method decorator's `{ name }`
       * option when that is set, and otherwise from the method name.
       */
      type: "decoratedMethod";
      /**
       * The module a decorator has to be imported from before discovery will
       * fire. Codebases sometimes re-export a framework decorator wrapped
       * with extra metadata of their own, and checking one module would miss
       * those. Pass an array of acceptable modules and any one of them
       * matching is enough.
       */
      importModule: string | string[];
      /**
       * Class decorators to recognise. The first one that appears on a class
       * is the one typeName is read from; the rest are fallbacks for
       * codebases with several wrapper styles. A pack ships only what its own
       * framework declares here, and takes a project's own wrappers through
       * its options instead.
       */
      classDecorators: string[];
      methodDecorators: string[];
      /**
       * Maps a method decorator to the type its field belongs to, for the
       * decorators that settle it. NestJS puts `@Query` on the root
       * `Query` type and `@Mutation` on `Mutation` no matter what the class
       * says, so an entry here wins over the class decorator's argument.
       *
       * When the map leaves a decorator out and the class decorator gives no
       * type either, nothing here works out which type owns the field. The
       * binding then goes out with no type and pairs with nothing, instead
       * of claiming a field the schema does not have.
       */
      methodDecoratorTypeMap: Record<string, string>;
    }
  | {
      /**
       * NestJS-style REST controller discovery: a class decorated with
       * `@Controller(pathPrefix?)`, and methods decorated with
       * `@Get(subpath?)`, `@Post`, `@Put`, `@Delete`, and so on. The
       * decorator's NAME is what determines the HTTP method, through
       * `methodDecoratorRouteMap`. The route path is the class decorator's
       * first argument joined with a slash to the method decorator's first
       * argument, and both of those are optional.
       *
       * Wrapper decorators are tolerated the same way as in
       * `decoratedMethod`: at least one method-route decorator has to come
       * from the framework module, but class decorators
       * are matched by name alone, so a project's own wrapper around the
       * framework's decorator matches once the project lists it in the
       * pack's options.
       *
       * The adapter fills in `DiscoveredUnit.routeInfo` so the binding comes
       * out as `rest(method, path)`.
       */
      type: "decoratedRoute";
      importModule: string | string[];
      classDecorators: string[];
      /**
       * Maps a decorator to an HTTP method. NestJS uses one decorator per
       * verb (`@Get`, `@Post`, `@Put`, `@Delete`, `@Patch`, `@Options`,
       * `@Head`, `@All`), and other frameworks may do the same. The values
       * become the `method` field on the REST binding, and `"*"` is fine for
       * a catch-all decorator.
       */
      methodDecoratorRouteMap: Record<string, string>;
    }
  | {
      /**
       * Loop expansion: a `for-of` loop over a literal array of
       * route specs is treated as if each element were an inline
       * registration. Used for patterns like:
       *
       *   const routes = [
       *     { method: "get", path: "/users", handler: getUsers },
       *     ...
       *   ];
       *   for (const r of routes) app[r.method](r.path, r.handler);
       *
       * `elementShape` declares which keys on each element give the method,
       * the path, and the handler. The loop body has to contain at least
       * one call expression that references the
       * loop variable, which filters out unrelated loops. Nothing else
       * about that call is checked.
       *
       * An iterable that resolves to an `ArrayLiteralExpression`, inline or
       * bound to a `const` one hop away, gets expanded. Cross-file and
       * computed iterables are outside v0.
       *
       * Pack-author docs: `design/proposals/dynamic-registration.md`.
       */
      type: "registrationLoop";
      elementShape: {
        methodKey: string;
        pathKey: string;
        handlerKey: string;
      };
    }
  | {
      /**
       * Helper-call expansion: one function call at the user's site is
       * treated as if it were N inline registrations, with the call's
       * arguments substituted into a template per registration. Used
       * for calls like `registerCrud(app, 'users', userHandlers)` that
       * `registrationCall` discovery cannot see today.
       *
       * Each entry in `registrations` describes one virtual route
       * the helper produces. `pathTemplate` and `handlerArg` use
       * `{N}` placeholders that resolve to the call's positional
       * arguments. `{N}` substitutes the argument's literal value
       * (for string-literal args) or its source text (for
       * non-literal args, with the slot marked opaque). `{N}.prop`
       * reads `prop` from the argument's resolved object.
       *
       * `importModule` optionally narrows matches to helpers imported from
       * one specific module, which helps when two packages happen to export
       * a function with the same name.
       *
       * Pack-author docs: `design/proposals/dynamic-registration.md`.
       */
      type: "registrationTemplate";
      helperName: string;
      importModule?: string;
      registrations: Array<{
        method: string;
        pathTemplate: string;
        handlerArg: string;
      }>;
    }
  | {
      /**
       * Routes declared as JSX elements, the way client-side routers
       * write them: an element imported from the router library whose
       * attributes give a URL path pattern and the element it
       * renders. Covers the tree form (route elements nested inside
       * one another, child paths joining the parent's, index routes
       * taking the parent's path) and the object-array form (a
       * factory call whose first argument is an array of route
       * objects using the same property names).
       *
       * The pack says what its library exports: the route element, the
       * path, element, and index attributes, and any factories that
       * take an array of route objects. The adapter walks JSX and arrays,
       * and knows none of those names itself.
       *
       * Each route with a readable path becomes one unit whose target
       * is the component the element attribute references, resolved
       * only when the reference is a single identifier. A route whose
       * component cannot be read is still reported, as a boundary with
       * nothing behind it. A route whose path cannot be read gets no path
       * and reports that in a gap instead of guessing at one.
       */
      type: "jsxElementRoute";
      /**
       * Module(s) the route element and factories must be imported
       * from. Exact module specifiers, matched against the file's
       * import declarations; aliased imports are followed.
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
       * Factory functions that turn JSX route elements into the route
       * objects the library consumes. The elements themselves are read
       * by the JSX walk wherever they appear, so a route-object factory
       * handed one of these calls has nothing more to add. Listing them
       * here is what stops that case from being reported as an
       * unreadable route array.
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
       * Consumer side of the package-export boundary. Scans source files for
       * imports of the listed packages and records every call site,
       * emitting one `caller`-kind unit per enclosing
       * function. The bindings this produces are
       * `function-call { package, exportPath }`, which match the provider
       * summaries `packageExports` produces.
       *
       * `packages` lists exact package names to track imports of, possibly
       * with a sub-path such as `"@suss/behavioral-ir/schemas"`. Pass
       * several package names to track a family at
       * once. Imports of any other package are ignored.
       *
       * As of v0 this covers named and default imports. Namespace imports
       * (`import * as X from`) are not tracked yet. Re-imports within
       * the consumer repo (consumer A imports from consumer B which
       * re-exports from pkg) produce units against the intermediate rather
       * than the original, because full symbol resolution is not built yet.
       */
      type: "packageImport";
      packages: string[];
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
         * The route path comes from where the file is on disk, which is how
         * Next.js and React Router describe their routes. The pack spells
         * out its own convention here, because the adapter knows
         * about files and the pack knows what the framework does with their
         * names.
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

export interface DiscoveryPattern {
  /** The kind of code unit this discovers: "handler", "loader", "action", "component", etc. */
  kind: string;
  match: DiscoveryMatch;
  bindingExtraction?: BindingExtraction;
  /**
   * How the routable this pattern discovers (Express's `Router()`,
   * Hono's `new Hono()`, and similar) can itself be mounted onto
   * another one under a path prefix, as in Express's
   * `app.use(prefix, router)` or Hono's `app.route(prefix, sub)`.
   * This only means anything when `match.type` is `"registrationCall"`,
   * because mount discovery reuses that match's `importModule` and
   * `importName` to work out which variables in a file are the routable
   * that a mount call is being made on.
   *
   * When set, the adapter composes the mount's prefix into the path
   * of every route discovered on the mounted value, whether it is
   * declared in the mounting file or, by following the mounted value
   * through an import, in whichever file declares it. A mount whose
   * prefix is not a string literal, or whose target the resolution store
   * cannot follow to a concrete value, contributes nothing, and the routes
   * under it keep the path they were written with.
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
   * This pattern only runs against files that import one of these module
   * specifiers, or a sub-path of one. An empty array means no gate at all
   * (the pattern is dispatched against
   * every file). Leaving it undefined does the same, but pack authors
   * SHOULD write it out, because `[]` is the deliberate
   * "match every file" choice, usually because the pattern keys on
   * something other than imports. The fetch runtime does that, since it
   * matches global `fetch(...)` calls.
   *
   * Matching is by prefix on the import module specifier. An entry of
   * `"@nestjs/graphql"` matches `from "@nestjs/graphql"` and
   * `from "@nestjs/graphql/dist/foo"` and any other sub-path.
   *
   * This pre-filter is only there for speed. The closure walk and the other
   * post-passes can still reach every loaded file through symbol
   * resolution.
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
       * Skip ReturnStatements whose returned expression is a CallExpression
       * (or NewExpression). For frameworks where `return reply.send(...)`
       * also lands as a `parameterMethodCall` match on the inner call,
       * this stops the same `return reply.send(...)` producing two
       * terminals, one from the wrapping returnStatement and one from
       * the inner method-call chain. Bare returns (`return user`,
       * `return { id }`, `return await fn()`) still match.
       */
      excludeCallReturns?: boolean;
    }
  | {
      type: "parameterMethodCall";
      parameterPosition: number; // which param is the response object (1 for Express res)
      methodChain: string[]; // e.g. ["status", "json"]
    }
  | {
      type: "throwExpression";
      constructorPattern?: string; // e.g. "HttpError"
    }
  | {
      type: "functionCall";
      functionName: string; // e.g. "json", "redirect". Matches calls to a function with this name
      /**
       * Only match when the name was imported from one of these modules.
       * The field works exactly like a DiscoveryPattern's gate, matching by
       * prefix: "react-router" also matches "react-router/server".
       *
       * Set it whenever the function belongs to a library, because matching
       * on a bare name picks up every function with that name in the
       * user's project too. `json` is a common name for a project's own
       * response helper, and reading a library's argument order into one
       * of those gives you a confident wrong answer.
       *
       * Leave it unset only when the function belongs to no library at all.
       * A pack should generally not target a project's own helper. Declare
       * the envelope structure instead, with a `returnShape` terminal, and
       * the adapter follows a returned call into the project and reads
       * the helper's parameters. That covers a helper whatever it is called
       * and whatever order its arguments come in.
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
       * A synthetic terminal for the implicit fall-through at the end of a
       * function body. It fires when the function's last statement is
       * neither a `ReturnStatement` nor a `ThrowStatement`, which
       * covers the common case of handler and effect bodies that run
       * side effects and return `undefined` implicitly. Without this,
       * handler summaries come out with `transitions: []` because
       * `findTerminals` has nothing to match. A pack that always expects
       * explicit returns (HTTP handlers) should leave this out of
       * its terminals. A pack for callback bodies (React handlers,
       * `useEffect` bodies, Node `.on(...)` callbacks) should include it.
       */
      type: "functionFallthrough";
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
        // throw wrap(new NotFound(...)): look inside the argument at
        // `position` and match its constructor name against `codes`. This
        // covers a project helper wrapping `new HttpError.NotFound("...")`,
        // where the status comes from that argument's class rather than
        // from the expression actually thrown.
        from: "argumentConstructor";
        position: number;
        codes: Record<string, number>;
      };
  body?: // { body: data } gives name: "body". `unwrapJsonStringify` peels a
  // `JSON.stringify(x)` initializer back to the type of `x`, which is the
  // Lambda-proxy convention where `body` is the serialized
  // payload string rather than the payload. It is off by default, so a
  // pack that wants the literal property value keeps it.
    | { from: "property"; name: string; unwrapJsonStringify?: boolean }
    | { from: "argument"; position: number; minArgs?: number }; // res.json(data) → position: 0
  /** Fallback status code when none is extracted. e.g. Express res.json() defaults to 200. */
  defaultStatusCode?: number;
}

export interface TerminalPattern {
  /** What kind of output this terminal produces: "response", "throw", "return", "render" */
  kind: "response" | "throw" | "return" | "render";
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
   * Both ts-rest and zod-openapi happen to spell them `method` and
   * `path`, but they are the library's words, so the pack says them
   * and the adapter reads whatever it is told.
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
      /** Single object parameter, e.g. React Router LoaderFunctionArgs */
      type: "singleObjectParam";
      paramPosition: number;
      /** Property name → role, e.g. { params: "pathParams", request: "request" } */
      knownProperties: Record<string, string>;
    }
  | {
      /** Positional parameters, e.g. Express (req, res, next) */
      type: "positionalParams";
      params: Array<{ position: number; role: string }>;
    }
  | {
      /** Destructured from framework call, e.g. ts-rest { params, body, query } */
      type: "destructuredObject";
      /** Property name → role, e.g. { params: "pathParams", body: "requestBody" } */
      knownProperties: Record<string, string>;
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
       * This differs from `destructuredObject` because the pack does not
       * declare the prop names up front; they are whatever the component
       * author wrote. It differs from `singleObjectParam` because the
       * destructuring pattern is respected when there is one.
       */
      type: "componentProps";
      paramPosition: number;
      /** Role for the single Input when the param is not destructured. Defaults to "props". */
      wholeParamRole?: string;
    }
  | {
      /**
       * Emit one `Input` per declared parameter, in source order, using the
       * parameter's name as its role, or `defaultRole` when set. Used by the
       * reachable-closure pass for internal library functions, where no
       * framework declares a set of roles, so the name a caller sees IS
       * the role. Destructured parameters are captured the
       * same way `destructuredObject` captures them, so `(ctx, { userId })`
       * gives two inputs, `ctx` and `userId`.
       */
      type: "allPositional";
      defaultRole?: string;
    }
  | {
      /**
       * Decorator-driven parameter mapping, NestJS-style. For each declared
       * parameter, the adapter reads the parameter's first decorator and
       * looks its name up in `decoratorRoleMap`.
       * A decorator that matches gives the parameter that role. One that
       * matches nothing falls back to `defaultRole`, or is skipped when
       * `defaultRole` is unset.
       *
       * For `@nestjs/graphql` resolvers:
       * `{ "Args": "args", "Parent": "parent",
       *    "Context": "context", "Info": "info" }`.
       *
       * Decorators are matched by name alone, so if several frameworks
       * define `@Args`, all of them map. Packs that need to
       * tell them apart by import module can add that later, once there
       * is a use case worth the cost.
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
  /** Callee text as written, e.g. "Sentry.wrapHandler". */
  callee: string;
  /** Which argument the wrapped function is passed as. */
  argument: number;
  /**
   * The module the callee has to have been imported from. Without it a
   * local object spelled the same way would be taken for the library.
   */
  module: string;
}

export interface PatternPack {
  name: string;
  /**
   * Pack version stamp, which feeds the cache invalidation key. Bump on
   * any change that affects discovered units / extracted summaries.
   * Format is opaque to the adapter, so semver or a content hash both
   * work.
   *
   * Optional, because whoever loads the pack knows more about it than
   * the pack does. The CLI folds a hash of the file it loaded and of
   * the config it passed into this stamp, so a pack run through the CLI
   * invalidates on an edit whether or not it declares a version. A host
   * that builds packs some other way takes on that responsibility itself.
   * A pack with nothing to stamp comes out as `"unset"`, and a warm cache
   * will then serve results for code that has since changed.
   */
  version?: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
  /**
   * Transport (wire protocol) used in the `BoundaryBinding.transport`
   * of discovered units. Every pack has to say what its transport is
   * rather than falling back on a hardcoded HTTP default. "What transport
   * does this pack cover?" is a question every pack should have to
   * answer, and requiring the field stops a later pack (React, GraphQL,
   * Lambda-invoke, queues) from quietly inheriting an HTTP-shaped default
   * that does not fit it.
   *
   * The pack's `name` separately fills in `BoundaryBinding.recognition`
   * on the summaries, so `{ transport, recognition }` come from
   * the pack directly and the adapter derives `semantics` from the
   * discovery pattern's binding-extraction rules.
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
   * Synthesize extra code units out of a parent unit's body, for when one
   * construct the user wrote implicitly spawns several units the runtime
   * schedules. Used when a framework's runtime
   * schedules callbacks that aren't visible as top-level declarations:
   * React event handlers on JSX elements, React `useEffect` bodies,
   * Node `emitter.on("event", handler)`, class-component lifecycle
   * methods, and similar.
   *
   * `ctx` is typed `unknown` here because the extractor has no
   * knowledge of which adapter is driving it; each language adapter
   * defines its own context type (`TsSubUnitContext` in
   * `@suss/adapter-typescript`, say) with the primitives a pack needs to
   * walk the parent's AST. Packs import and cast to the adapter
   * context they were written against, and that cast is how a pack says
   * out loud that it requires the TypeScript adapter.
   *
   * Returned units are fed through the adapter's extraction pipeline
   * the same way top-level discovered units are, so each becomes its
   * own `BehavioralSummary`. Put per-unit `terminals` and `inputMapping`
   * on the `DiscoveredUnit` when a sub-unit is written differently from
   * the parent pack's defaults.
   */
  subUnits?: (
    parent: DiscoveredSubUnitParent,
    ctx: unknown,
  ) => DiscoveredSubUnit[];
  /**
   * A top-level discovery callback the pack supplies. It is to discovery
   * what `subUnits` is to sub-units: when a framework's convention does
   * not fit one of the data-driven `DiscoveryMatch` variants (REST
   * registration, decorator-based controllers, named-export shapes,
   * etc.), the pack ships its own walker here. The adapter calls it
   * once per source file alongside the data-driven dispatch.
   *
   * Use this for framework-specific patterns that do not generalize:
   * React's component-export heuristic (PascalCase plus a JSX return),
   * Vue's `.vue` SFC slots, Solid's component conventions, Storybook's
   * `.stories.tsx` file convention. Those are all legitimate conventions,
   * but baking each one into the central `DiscoveryMatch` union forces
   * every unrelated pack to know about them. Callbacks leave the central
   * union for the generic primitives and let each pack own its own
   * conventions.
   *
   * `ctx` is typed `unknown` for the same reason as in `subUnits`: each
   * adapter ships its own context primitive (`TsDiscoveryContext` in
   * `@suss/adapter-typescript`) and a pack casts to whichever one it was
   * written against. That cast is how the pack says it requires the TS
   * adapter.
   *
   * The units you return go through the adapter's normal pipeline. They
   * get their terminals and effects extracted, sub-units synthesized, and
   * summaries assembled exactly as units from data-driven discovery
   * do. Per-unit `terminals` and `inputMapping` overrides on
   * `DiscoveredUnit` work the same way too.
   *
   * **Cross-pack dedup.** When this callback discovers a unit at the
   * same `(func, kind)` as a unit from another pack's data-driven
   * discovery, the adapter's cross-pack claim dedup keeps whichever
   * claimed it first. The order packs appear in the framework list is
   * what decides precedence.
   */
  discoverUnits?: (sourceFile: unknown, ctx: unknown) => DiscoveredCustomUnit[];
  /**
   * Per-call-site recognizers that emit typed `Effect`s alongside the
   * generic `invocation` effect the adapter already captures.
   *
   * **Scope contract.** The adapter walks every CallExpression in
   * the function body and dispatches to every registered recognizer
   * for each call. Walking skips nested function bodies (those are
   * their own units with their own recognizer dispatch). The walk is
   * INDEPENDENT of the existing invocation-effect walker, which is
   * deliberately narrow (it only captures
   * `invocation` effects from bare expression statements and container
   * composition, to avoid double-counting calls that already become
   * terminals). Recognizers do not have that problem, so they fire on
   * every call regardless of position, including
   * `const x = await fn(...)` initializers and nested call args
   * (which the invocation walker skips). This independence means
   * recognizer authors can rely on seeing every call in scope.
   *
   * **Cross-pack visibility.** Recognizers fire regardless of which pack
   * discovered the enclosing function, so
   * `@suss/framework-prisma`'s recognizer can fire on Prisma calls
   * inside an `@suss/framework-express` handler. Pack authors don't
   * need to coordinate.
   *
   * **Emission contract.** Returning effects ADDS them to the enclosing
   * default-branch transition, and the generic `invocation` effect is
   * kept either way (typed effects live alongside the raw
   * call capture, so inspect can still render the callee text and
   * arguments while the checker pairs on the typed form). Return `null`
   * or `[]` for no match.
   *
   * **Dedup is the recognizer's responsibility.** The dispatcher does
   * not dedupe across calls. A recognizer that wants to fire
   * once per identifier, to collapse reads bound to a const used N
   * times, has to track that state itself across invocations.
   *
   * **Exceptions are caught and logged.** A recognizer that throws gets
   * logged to stderr with the file path and line number, and is skipped
   * for that one call while the extraction carries on. A buggy
   * recognizer will not crash the run.
   *
   * `call` is the language adapter's call-expression handle (opaque
   * here; ts-morph `CallExpression` in `@suss/adapter-typescript`).
   * `ctx` is the adapter's recognizer context (source file, an
   * `extractArgs()` helper that reuses the adapter's own EffectArg
   * builder). A recognizer casts both to the adapter context it was
   * written against, which is the same way `subUnits` says a pack
   * requires the TypeScript adapter.
   */
  invocationRecognizers?: InvocationRecognizer[];
  /**
   * Optional pack-level import gate. When set, the adapter's
   * pre-filter only considers this pack applicable to source files
   * whose imports include at least one of the listed modules
   * (matched by prefix, so `"@aws-sdk/client-sqs"` matches that module
   * and any `"@aws-sdk/client-sqs/sub-path"`).
   *
   * Useful for recognizer-only packs that target a specific library:
   * `@suss/framework-aws-sqs` declares `["@aws-sdk/client-sqs"]`,
   * `@suss/framework-prisma` declares `["@prisma/client"]`. Without
   * a gate, a recognizer-only pack walks every file in the project. That
   * is correct but wasteful in a large monorepo where most files never
   * import the library.
   *
   * A discovery-pattern pack already has a per-pattern `requiresImport`
   * on `DiscoveryPattern`. This is the pack-level version of that, for a
   * pack whose ONLY mechanism is recognizers and which has no discovery.
   *
   * Empty or undefined means no gate, so the pack walks every file (the
   * default for universal recognizers like `@suss/runtime-node`'s
   * process-surface and env-var recognizers, since `process.*` is
   * available without importing anything).
   */
  requiresImport?: string[];
  /**
   * Environment variables the pack's library reads from inside
   * node_modules, where no walk ever looks. Declaring them keeps the
   * checker from telling a template that a variable is unused when the
   * library reads it on every invocation. The adapter emits one marker
   * summary per entry whose `module` some project file imports, and
   * the runtime-config pairing consults the markers before it accuses.
   * The module match is a specifier prefix, so one entry covers a
   * scoped family like `@aws-lambda-powertools/`.
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
   * Library wrappers that return the function they wrapped. The adapter
   * works this out on its own for a factory inside the project by reading
   * its body. A library wrapper's body is not there to read, so the
   * pack has to say it: a call to `callee` resolves to its
   * `argument`-th argument.
   *
   * `callee` matches the call expression text as written, e.g.
   * `"Sentry.wrapHandler"`.
   */
  transparentWrappers?: TransparentWrapper[];
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
   * Per-property-access recognizers, the counterpart to
   * `invocationRecognizers`. Use these for patterns that read a value
   * through property access without invoking it: `process.env.X`
   * env-var reads, `Date.now()`-style time reads (which is actually a
   * call, see invocationRecognizers), bare `module.constant` reads.
   *
   * A recognizer here is handed a property access, a call, or a tagged
   * template, and guards its own shapes. The tagged template is there
   * for a library that takes its whole argument as one, the way
   * `prisma.$queryRaw` and `gql` do.
   *
   * The scope rules are the same as for invocationRecognizers: it fires
   * on every such node in the function body and skips nested function
   * bodies. The emission contract is the same, so effects land on the
   * enclosing default-branch transition.
   *
   * The arguments are opaque here and narrowed by the adapter, for the
   * same reason as in invocationRecognizers.
   */
  accessRecognizers?: AccessRecognizer[];
  /**
   * What the pack wrote as data rather than as code, for the health
   * report. Absent for a pack written as a hand-rolled walk, which is
   * itself the thing the report says.
   */
  declarations?: PackDeclarations;
}

/**
 * The price a pack paid for what it matches, so the migration onto the
 * declared surface can be measured rather than asserted.
 *
 * Expressiveness is bought link by link: a link answered with data is
 * inspectable, serializable and runs on any adapter, while a link
 * answered with a function is code that only its own language runs.
 * Both are allowed, and the report says which is which.
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
 * Per-call-site recognizer hook. See `PatternPack.invocationRecognizers`
 * for the contract and threading model.
 */
export type InvocationRecognizer<TCtx = unknown> = (
  call: unknown,
  ctx: TCtx,
) => Effect[] | null;

/**
 * Per-property-access recognizer hook. See
 * `PatternPack.accessRecognizers` for the contract and threading model.
 */
export type AccessRecognizer<TCtx = unknown> = (
  access: unknown,
  ctx: TCtx,
) => Effect[] | null;

/**
 * The bare minimum a `subUnits` hook needs to know about the parent code
 * unit it is working inside. `func` is left opaque here because each
 * language adapter brands its own FunctionRoot type. This interface lives in
 * the extractor only so `PatternPack` can refer to it, and the adapter-level
 * context types like `TsSubUnitContext` narrow `func` to a concrete AST
 * handle.
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
 * What a pack's `discoverUnits` hook returns for each top-level unit it
 * finds. It is to discovery what `DiscoveredSubUnit` is to sub-units. The
 * adapter widens these into its own internal `DiscoveredUnit` type, which has
 * adapter-specific fields like `routeInfo` and `packageExportInfo` on it, and
 * then runs them through the normal extraction pipeline.
 *
 * Pack authors only ever see opaque handles: `func` is whatever the adapter's
 * primitive returned, and the adapter narrows it to its concrete
 * function-root type (`FunctionRoot` in `@suss/adapter-typescript`).
 */
export interface DiscoveredCustomUnit {
  /** Function body handle, opaque here. */
  func: unknown;
  /** IR code-unit kind (e.g. "component", "handler"). */
  kind: string;
  /** Discovered name (e.g. "UserCard"). */
  name: string;
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
   * REST route identity for units a callback discovers against an
   * external manifest (a SAM/CFN template's `Events` block, an infra
   * routing declaration, and so on) rather than an in-code registration.
   * When set, the adapter builds a `rest` binding from `(method, path)`,
   * the same binding a NestJS controller gets from decorator-derived
   * `routeInfo`, and the discoverUnits callback never has to reach into
   * the adapter's binding machinery. Either half is null when the
   * source does not state it, and a binding missing one pairs with
   * nothing.
   *
   * One function bound to several routes emits one DiscoveredCustomUnit
   * per route. The adapter's per-file claim dedup keys on
   * `(func, kind, method, path)`, so all of those variants survive.
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
  /** The thing that gets deployed and runs this unit, when known. */
  deployableUnit?: DeployableUnit;
  /**
   * Metadata merged onto the resulting summary's `metadata` field.
   */
  metadata?: Record<string, unknown>;
}

/**
 * What a pack's `subUnits` hook returns per synthesized child. The
 * adapter pipes each of these through the same extraction + assembly
 * pipeline used for top-level-discovered units.
 */
export interface DiscoveredSubUnit {
  /** Function body handle, opaque here. */
  func: unknown;
  /** IR code-unit kind (e.g. "handler"). */
  kind: string;
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
