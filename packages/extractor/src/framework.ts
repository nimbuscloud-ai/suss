// @suss/extractor — PatternPack interface
//
// Pattern packs are declarative data that tell the language adapter WHAT to look for.
// The adapter knows HOW to look for it in the language's AST.

import type { Effect } from "@suss/behavioral-ir";

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
      type: "decorator";
      decoratorModule: string;
      decoratorName: string;
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
      /** Named export or identifier — e.g. "initClient", "fetch" */
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
       * containing a resolver map — the idiomatic GraphQL code-first
       * shape. The map is two levels deep: outer keys are GraphQL type
       * names (`Query`, `Mutation`, `Subscription`, or object-type
       * names like `User`); inner keys are field names whose values
       * are resolver functions.
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
       * semantics is `graphql-resolver(typeName, fieldName)`. Matches
       * both `new Ctor(cfg)` and `ctor(cfg)` — Apollo's standalone
       * server uses `new`, yoga uses a bare call.
       */
      type: "resolverMap";
      importModule: string;
      importName: string;
      /**
       * Name of the property on the config object that holds the
       * resolver map. Defaults to `"resolvers"` when unset, matching
       * Apollo / yoga / graphql-tools convention.
       */
      mapProperty?: string;
      /**
       * GraphQL type names whose fields we DON'T treat as resolvers —
       * opt-out for meta-types like `Subscription` that we may want
       * to handle differently later. Unset means discover every type.
       */
      excludeTypes?: string[];
    }
  | {
      /**
       * Consumer-side GraphQL hook call — the canonical Apollo Client
       * and urql shape. Each call to one of the listed hooks becomes
       * a `client`-kind code unit whose binding semantics is
       * `graphql-operation(operationType, operationName?)`. The
       * operation identity comes from parsing the first argument's
       * gql-tagged template literal — either inline or resolved
       * through one const-binding of an identifier.
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
       * The adapter records the operation name / type on the
       * DiscoveredUnit's `operationInfo`; binding construction uses
       * that to emit `graphql-operation(...)`. Inline `gql`-less
       * string arguments and cross-module gql documents are left
       * for a follow-up — v0 covers the dominant shape.
       */
      type: "graphqlHookCall";
      importModule: string;
      /**
       * Hook names to match on that import (e.g. `["useQuery",
       * "useMutation", "useSubscription"]`). Each hook is reported
       * as `kind = "client"` by default; packs can override via the
       * enclosing `DiscoveryPattern.kind`.
       */
      hookNames: string[];
    }
  | {
      /**
       * Imperative Apollo-Client-style call — `client.query({ query })`,
       * `client.mutate({ mutation })`, `client.subscribe({ query })`.
       * Distinct from hook calls because the document lives on a
       * config-object property rather than the first positional arg.
       * Discovery is gated on an import of the named constructor
       * (typically `ApolloClient`) to reduce false positives — any
       * method-named "query" on a random object could look like this
       * shape.
       *
       * Each entry in `methods` specifies the method name that gets
       * called on the client (`"query"` / `"mutate"` / `"subscribe"`)
       * and the config-object property that holds the gql document
       * (`"query"` / `"mutation"` / `"query"` respectively). The
       * method name drives the operation type (query / mutation /
       * subscription) when the gql document's header is anonymous;
       * a named document's header wins otherwise.
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
       * boundary. The adapter reads `package.json` at
       * `packageJsonPath`, resolves each reachable entry point
       * (root `.` and any sub-path `exports`), follows barrel
       * re-exports, and emits one discovered unit per exported
       * function — provider side of an in-process `function-call`
       * boundary.
       *
       * Produced bindings carry identity
       * `{ transport: "in-process",
       *    semantics: { name: "function-call",
       *                 package: <pkg.name>,
       *                 exportPath: [...] },
       *    recognition: <pack.name> }`.
       *
       * Sub-path exports identify as e.g.
       * `@suss/behavioral-ir/schemas::BehavioralSummarySchema` —
       * `exportPath = ["schemas", "BehavioralSummarySchema"]`.
       * Root exports omit the sub-path segment.
       *
       * v0 scope: resolves `types` / `default` / `import` conditions
       * on `exports`, falls back to `types` + `main` + `module`
       * when no `exports` field is set. Pattern exports (`./utils/*`)
       * and `development`-conditional resolution are deferred.
       */
      type: "packageExports";
      /** Absolute path to the package's `package.json`. */
      packageJsonPath: string;
      /**
       * Restrict to these `exports` keys (without leading `./`).
       * The root export is keyed `"."`. Unset means all resolvable
       * sub-paths.
       */
      subPaths?: string[];
      /**
       * Export names to skip — typically `["default"]` when a pack
       * wants to treat default exports separately or not at all.
       */
      excludeNames?: string[];
    }
  | {
      /**
       * Class methods that carry a specific decorator, on classes that
       * carry a specific class-level decorator. Used by NestJS-style
       * frameworks where resolvers / handlers / controllers are
       * declared by decorator, not by registering a function in an
       * object literal.
       *
       * Discovery gates on an `importModule` of `classDecorator` and
       * each `methodDecorators` entry — random user-defined decorators
       * with the same names won't trip the matcher.
       *
       * For a NestJS GraphQL pack:
       * `{ importModule: "@nestjs/graphql",
       *    classDecorator: "Resolver",
       *    methodDecorators: ["Query", "Mutation", "ResolveField",
       *                       "Subscription"] }`
       *
       * The adapter populates `DiscoveredUnit.resolverInfo` so the
       * produced binding carries `graphql-resolver(typeName, fieldName)`.
       * `typeName` resolves from the class decorator's first argument
       * (`@Resolver(() => User)` → `"User"`); when the class decorator
       * has no argument it defaults to the operation kind (`"Query"`,
       * `"Mutation"`, `"Subscription"`). `fieldName` reads the method
       * decorator's `{ name }` option override when present, otherwise
       * the method name.
       */
      type: "decoratedMethod";
      /**
       * The module a pack-recognised decorator must be imported from
       * for discovery to fire. Codebases sometimes wrap framework
       * decorators in their own re-exports (NestJS apps frequently
       * declare `MetadataResolver` / `CoreResolver` factories that
       * compose `@Resolver()` with extra metadata). When that happens,
       * the import-module gate would miss them; pass an array of
       * accepted modules and any one match suffices.
       */
      importModule: string | string[];
      /**
       * Class decorator names to recognise. The first entry that
       * appears on a class wins for typeName extraction (the rest are
       * fallbacks for codebases with multiple wrapper styles).
       */
      classDecorators: string[];
      methodDecorators: string[];
    }
  | {
      /**
       * NestJS-style REST controller discovery. Class decorated with
       * `@Controller(pathPrefix?)`; methods decorated with
       * `@Get(subpath?)` / `@Post` / `@Put` / `@Delete` / etc. The
       * decorator NAME determines the HTTP method via
       * `methodDecoratorRouteMap`; the route path is the class
       * decorator's first arg + the method decorator's first arg
       * (slash-joined, both optional).
       *
       * Same wrapper-decorator tolerance as `decoratedMethod`: the
       * import-module gate fires on at least one method-route
       * decorator from the framework module, but class decorators
       * match by name only so project-internal wrappers
       * (`@PublicController` / `@AuthedController` factories
       * composing `@Controller()`) work without per-project pack
       * config.
       *
       * The adapter populates `DiscoveredUnit.routeInfo` so the
       * produced binding carries `rest(method, path)`.
       */
      type: "decoratedRoute";
      importModule: string | string[];
      classDecorators: string[];
      /**
       * Decorator name → HTTP method. NestJS uses one decorator per
       * verb (`@Get` / `@Post` / `@Put` / `@Delete` / `@Patch` /
       * `@Options` / `@Head` / `@All`); other frameworks may follow
       * the same convention. The values become the `method` field on
       * the produced REST binding; `"*"` is acceptable for catch-all
       * decorators.
       */
      methodDecoratorRouteMap: Record<string, string>;
    }
  | {
      /**
       * Consumer side of the package-export boundary. Scans source
       * files for imports of the named packages and records every
       * call site, emitting one `caller`-kind unit per enclosing
       * function. Produced bindings carry
       * `function-call { package, exportPath }` matching the
       * provider summaries from `packageExports`.
       *
       * `packages` is a list of exact package names (possibly with a
       * sub-path, e.g. `"@suss/behavioral-ir/schemas"`) whose imports
       * to track. Pass multiple package names to track a family at
       * once. Imports of any other package are ignored.
       *
       * v0 scope: named imports + default imports. Namespace imports
       * (`import * as X from`) are not yet tracked. Re-imports within
       * the consumer repo (consumer A imports from consumer B which
       * re-exports from pkg) produce units against the intermediate,
       * not the original — full symbol resolution is deferred.
       */
      type: "packageImport";
      packages: string[];
    };

export type BindingExtraction = {
  method:
    | { type: "fromRegistration"; position: "methodName" | number }
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
  path:
    | { type: "fromRegistration"; position: number }
    | { type: "fromFilename" }
    | { type: "fromContract" }
    | { type: "fromClientMethod" }
    | { type: "fromArgumentLiteral"; position: number };
};

export interface DiscoveryPattern {
  /** The kind of code unit this discovers: "handler", "loader", "action", "component", etc. */
  kind: string;
  match: DiscoveryMatch;
  bindingExtraction?: BindingExtraction;
  /**
   * Files whose import declarations include any of these module
   * specifiers (or sub-paths of them) get this pattern's discovery
   * dispatch. Empty array = no gate (pattern is dispatched against
   * every file). Undefined = treated as no gate, but pack authors
   * SHOULD declare it explicitly — the `[]` form is the deliberate
   * "match every file" choice (typically because the pattern keys on
   * something other than imports — e.g. the fetch runtime matching
   * global `fetch(...)` calls).
   *
   * Match semantics: prefix on the import module specifier. An entry
   * `"@nestjs/graphql"` matches `from "@nestjs/graphql"` AND
   * `from "@nestjs/graphql/dist/foo"` AND any other sub-path.
   *
   * Pre-filter is purely a perf optimisation: the closure walk and
   * other post-passes still have access to every loaded file via
   * symbol resolution.
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
       * this prevents the same `return reply.send(...)` from producing
       * two terminals — one from the wrapping returnStatement, one from
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
      constructorPattern?: string; // e.g. "httpErrorJson", "HttpError"
    }
  | {
      type: "functionCall";
      functionName: string; // e.g. "json", "redirect" — matches calls to a named function
    }
  | {
      /**
       * Return statement whose value is a JSX element or fragment. The
       * root element/component name is recorded in RawTerminal.component.
       * Used by React (and any other JSX-based framework pack) to
       * classify component outputs as `render` terminals.
       */
      type: "jsxReturn";
    }
  | {
      /**
       * Synthetic terminal for the implicit fall-through at the end of a
       * function body. Fires when the function has no explicit
       * `ReturnStatement` / `ThrowStatement` as its last statement —
       * covers the common case of handler / effect bodies that execute
       * side-effects and return `undefined` implicitly. Without this,
       * handler summaries come out with `transitions: []` because
       * `findTerminals` has nothing to match. Packs that always expect
       * explicit returns (HTTP handlers) shouldn't include this in
       * their terminals; packs for callback bodies (React handlers,
       * `useEffect` bodies, Node `.on(...)` callbacks) should.
       */
      type: "functionFallthrough";
    };

export interface TerminalExtraction {
  statusCode?:
    | { from: "property"; name: string } // { status: 200 } → name: "status"
    | { from: "argument"; position: number; minArgs?: number } // res.status(200) → position: 0
    | { from: "constructor"; codes: Record<string, number> } // throw new NotFound() → 404 via { NotFound: 404 }
    | {
        // throw wrap(new NotFound(...)) → peek into the arg at `position` and
        // match its constructor name against `codes`. Covers wrapper patterns
        // like React Router's `httpErrorJson(new HttpError.NotFound("…"))`,
        // where the class of the arg — not the top-level thrown expression —
        // carries the status.
        from: "argumentConstructor";
        position: number;
        codes: Record<string, number>;
      };
  body?:
    | { from: "property"; name: string } // { body: data } → name: "body"
    | { from: "argument"; position: number; minArgs?: number }; // res.json(data) → position: 0
  /** Fallback status code when none is extracted. e.g. Express res.json() defaults to 200. */
  defaultStatusCode?: number;
}

export interface TerminalPattern {
  /** What kind of output this terminal produces: "response", "throw", "return", "render" */
  kind: "response" | "throw" | "return" | "render";
  match: TerminalMatch;
  extraction: TerminalExtraction;
}

// =============================================================================
// Contract reading
// =============================================================================

export interface ContractPattern {
  /** How to find the contract object. Contracts are data structures, not code units,
   *  so this is a simpler shape than DiscoveryPattern. */
  discovery: {
    importModule: string; // e.g. "@ts-rest/core"
    importName: string; // e.g. "initContract"
    registrationChain: string[]; // e.g. [".router"]
  };
  responseExtraction: {
    /** Property on the contract object that holds the responses map */
    property: string;
  };
  paramsExtraction?: {
    property: string;
  };
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
       * name becomes its own Input with role equal to the name. When
       * it's not destructured (e.g. `function X(props) {...}`), one
       * Input is emitted with `wholeParamRole` (default `"props"`).
       *
       * Differs from `destructuredObject` in that prop names are not
       * declared by the pack up-front — they are whatever the component
       * author wrote. Differs from `singleObjectParam` in that the
       * destructuring pattern is honored when present.
       */
      type: "componentProps";
      paramPosition: number;
      /** Role for the single Input when the param is not destructured. Defaults to "props". */
      wholeParamRole?: string;
    }
  | {
      /**
       * Emit one `Input` per declared parameter, in source order, with
       * `role = param name` (or `defaultRole` when set). Used by the
       * reachable-closure pass for internal library functions — there
       * is no framework-declared role space, so the caller-visible
       * name IS the role. Captures destructured-parameter bindings the
       * same way `destructuredObject` does, so `(ctx, { userId })`
       * reads as two inputs: `ctx` and `userId`.
       */
      type: "allPositional";
      defaultRole?: string;
    }
  | {
      /**
       * Decorator-driven parameter mapping (NestJS-style). For each
       * declared parameter, the adapter reads the parameter's first
       * decorator and looks up its name in `decoratorRoleMap` —
       * matched decorators map the parameter to that role; unmatched
       * parameters fall back to `defaultRole` (or skip when unset).
       *
       * For `@nestjs/graphql` resolvers:
       * `{ "Args": "args", "Parent": "parent",
       *    "Context": "context", "Info": "info" }`.
       *
       * Decorator gating is by name only — multiple frameworks
       * defining `@Args` would all map. Packs that need to
       * disambiguate by import module add it later when the use case
       * justifies the cost.
       */
      type: "decoratedParams";
      decoratorRoleMap: Record<string, string>;
      defaultRole?: string;
    };

// =============================================================================
// Response property semantics
// =============================================================================

/**
 * What a property on the API response object semantically represents.
 * Declared in the pack so the adapter can resolve derived properties
 * (e.g. `.ok` → status range 200–299) at extraction time.
 */
export type ResponsePropertyMeaning =
  | { type: "statusCode" }
  | { type: "statusRange"; min: number; max: number }
  | { type: "body" }
  | { type: "headers" };

export interface ResponsePropertyMapping {
  /** Property or method name on the response (e.g. "ok", "status", "json") */
  name: string;
  /** How this member is accessed: property read or method call */
  access: "property" | "method";
  /** What the value semantically represents */
  semantics: ResponsePropertyMeaning;
}

// =============================================================================
// PatternPack
// =============================================================================

export interface PatternPack {
  name: string;
  /**
   * Pack version stamp — feeds the cache invalidation key. Bump on
   * any change that affects discovered units / extracted summaries.
   * Format is opaque to the adapter; semver is the obvious choice
   * but a content hash, build SHA, or monotonic integer works too.
   * Optional — packs that omit it use the literal string `"unset"`,
   * which means cache entries from one process to the next aren't
   * meaningfully versioned (suitable for development; production
   * packs should declare a version).
   */
  version?: string;
  languages: string[];
  discovery: DiscoveryPattern[];
  terminals: TerminalPattern[];
  contractReading?: ContractPattern;
  inputMapping: InputMappingPattern;
  /**
   * Transport (wire protocol) used in the `BoundaryBinding.transport`
   * of discovered units. Every pack states its transport explicitly
   * rather than leaning on a hardcoded HTTP default — "what transport
   * does this pack cover?" is a question every pack should have to
   * answer, and making the field required keeps future packs (React,
   * GraphQL, Lambda-invoke, queues) from silently inheriting an
   * HTTP-shaped default that doesn't fit.
   *
   * The pack's `name` separately populates `BoundaryBinding.recognition`
   * on produced summaries — so `{ transport, recognition }` come from
   * the pack directly, and `semantics` is derived by the adapter from
   * the discovery pattern's binding-extraction rules.
   */
  protocol: string;
  /**
   * Semantics of properties on the API response object (consumer side).
   * Tells the adapter how to resolve derived properties like `.ok` or
   * `.json()` to structured IR constructs instead of leaving them opaque.
   */
  responseSemantics?: ResponsePropertyMapping[];
  /**
   * Synthesize additional code units from a parent unit's body —
   * "one user-authored construct implicitly spawns multiple
   * runtime-scheduled units." Used when a framework's runtime
   * schedules callbacks that aren't visible as top-level declarations:
   * React event handlers on JSX elements, React `useEffect` bodies,
   * Node `emitter.on("event", handler)`, class-component lifecycle
   * methods, and similar.
   *
   * `ctx` is typed `unknown` here because the extractor has no
   * knowledge of which adapter is driving it; each language adapter
   * defines its own context shape (e.g. `TsSubUnitContext` in
   * `@suss/adapter-typescript`) with the primitives packs need to
   * walk the parent's AST. Packs import and cast to the adapter
   * context they're written against — the cast is the explicit
   * "this pack requires the TypeScript adapter" contract.
   *
   * Returned units are fed through the adapter's extraction pipeline
   * the same way top-level discovered units are, so each becomes its
   * own `BehavioralSummary`. Carry per-unit `terminals` and
   * `inputMapping` on the `DiscoveredUnit` if the sub-unit's shape
   * differs from the parent pack's defaults.
   */
  subUnits?: (
    parent: DiscoveredSubUnitParent,
    ctx: unknown,
  ) => DiscoveredSubUnit[];
  /**
   * Per-call-site recognizers that emit typed `Effect`s alongside the
   * generic `invocation` effect the adapter already captures. Each
   * recognizer fires once per call expression visited by the adapter's
   * invocation walker, regardless of which pack discovered the
   * enclosing function — so `@suss/framework-prisma`'s recognizer can
   * fire on Prisma calls inside an `@suss/framework-express` handler.
   *
   * Returning effects ADDS them to the same enclosing transition; the
   * generic `invocation` effect is preserved either way (typed effects
   * don't suppress raw call capture — they coexist so inspect rendering
   * keeps the callee text and args, while the checker pairs on the
   * typed shape). Returning null / [] is the no-match path.
   *
   * `call` is the language adapter's call-expression handle (opaque
   * here; ts-morph `CallExpression` in `@suss/adapter-typescript`).
   * `ctx` is the adapter's recognizer context (TypeChecker, source
   * file imports, an `extractArgs()` helper that reuses the adapter's
   * own EffectArg builder). Recognizers cast both to the adapter
   * context they're written against — same "this pack requires the
   * TypeScript adapter" contract `subUnits` uses.
   */
  invocationRecognizers?: InvocationRecognizer[];
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
 * Minimal handle-shaped description of the parent code unit that
 * `subUnits` operates within. `func` is left opaque here — the
 * language adapter brands its own FunctionRoot type. This interface
 * lives in the extractor only so `PatternPack` can name it;
 * adapter-level context types (`TsSubUnitContext`) narrow `func` to
 * a concrete AST handle.
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
   * Terminal patterns to extract from this sub-unit's body. Defaults
   * to `return` + `throw` when unset — fits handlers / effects cleanly.
   */
  terminals?: TerminalPattern[];
  /**
   * Input mapping for this sub-unit. Defaults to an empty positional
   * mapping when unset — event handlers with one arg should pass
   * `{ type: "positionalParams", params: [{ position: 0, role: "event" }] }`.
   */
  inputMapping?: InputMappingPattern;
  /**
   * Metadata merged onto the resulting summary's `metadata` field.
   * Packs use this to stamp provenance (`metadata.react = { kind: "handler", ... }`).
   */
  metadata?: Record<string, unknown>;
}
