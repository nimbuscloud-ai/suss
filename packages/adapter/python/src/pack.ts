// pack.ts: the Python adapter's own pattern-pack contract.
//
// Not the TypeScript adapter's `PatternPack` (packages/extractor's
// `framework.ts`): that type's discovery variants are dispatched by
// ts-morph-specific handlers, and Python's two route shapes (a class
// decorator plus method-name dispatch, and a function decorator whose
// own attribute name carries the verb) have no exact match in that
// union anyway. Per the language-adapters proposal's invariant, match
// shapes stay per-language until a second implementation shows what's
// actually shared; this is that per-language shape for Python. A pack
// is still plain data, the same discipline the TypeScript packs
// follow: naming what a library defines, nothing a project chose.

export interface PythonPack {
  name: string;
  /** Wire protocol for the produced boundary bindings, e.g. "http". */
  protocol: string;
  discovery: PythonDiscoveryPattern[];
}

export type PythonDiscoveryPattern =
  | DecoratedClassRoute
  | DecoratedFunctionRoute;

/**
 * Conventions both route shapes share, each naming behavior the
 * library defines, never a project's choice.
 */
export interface RouteConventions {
  /**
   * How the library spells a parameter inside a route path template,
   * as a named syntax the adapter has a reader for: "braces" for
   * `{name}` and `{name:converter}` (FastAPI's, via Starlette),
   * "flaskConverters" for `<name>` / `<converter:name>` /
   * `<converter(arguments):name>` (flask-restx's, via Werkzeug). The
   * adapter canonicalizes a read template to the IR's bare-brace
   * spelling and classifies parameters named in it as path parameters.
   * Unset means the library declares no template syntax: paths stand
   * as written and no parameter reads as a path parameter. Note for
   * pack authors upgrading from 0.3: the adapter used to apply the
   * brace reading unconditionally, so a pack that relied on that
   * without declaring anything now has to state "braces" here. A named
   * syntax the adapter has no reader for keeps the route discovered
   * with no path and a stated gap, never a guessed reading.
   */
  pathParamSyntax?: string;
  /**
   * Whether a parameter annotated with a locally-defined class is the
   * declared request body (FastAPI's Pydantic-model-parameter
   * behavior). Library-defined: set it only when the library itself
   * binds such a parameter to the body. Unset means no such
   * convention, and the parameter reads as a query parameter, the
   * weakest claim.
   */
  annotatedClassIsRequestBody?: boolean;
  /**
   * The status the library answers a declared response with when the
   * route states none (FastAPI's 200). Library-defined, so it is
   * declared here as data rather than baked into the adapter: without
   * it, a route that declares a response shape and no status claims no
   * status at all, which is what a reader should see when nobody can
   * say what the status is.
   */
  defaultStatusCode?: number;
  /**
   * How a route declared on a sub-router composes its full path. Unset
   * means the library has no router mounting, and a route's decorator
   * path stands as written. Both route shapes can carry one: a library
   * may hang its routes off a mounted object with a function decorator
   * or with a class decorator, and where the mount prefix comes from is
   * the same question either way.
   */
  routerComposition?: RouterComposition;
}

/**
 * A class carries a decorator resolving to a configured module, whose
 * call's first string-literal argument is the route path. Each
 * HTTP-verb-named method declared directly in the class body becomes
 * its own discovered unit, verb read from the method's own name
 * rather than from a decorator on it (flask-restx's `Resource`
 * dispatch convention).
 *
 * Closest TypeScript analogue: `decoratedRoute` in
 * `@suss/extractor`'s `framework.ts`, which also tolerates a
 * project-wrapped `importModule`. It differs in where the verb comes
 * from (a per-method decorator there, the method's own name here), so
 * it isn't reused as-is.
 */
export interface DecoratedClassRoute extends RouteConventions {
  type: "decoratedClassRoute";
  /**
   * Modules a project may have imported the decorator from, directly
   * or through a project-local wrapper re-exporting it. Mirrors
   * `DiscoveryMatch["decoratedRoute"].importModule` on the TypeScript
   * side: the library names its own module here; a project's wrapper
   * module is supplied through pack options by whoever configures the
   * pack, not hardcoded into it.
   */
  importModule: string[];
  /** The decorator's name as the library exports it (e.g. "route" for flask-restx's `Namespace.route`). */
  decoratorName: string;
  /** Method name written in the class body, mapped to the HTTP verb it dispatches. */
  verbMethodNames: Record<string, string>;
}

/**
 * A function carries a decorator resolving to a configured module,
 * where the decorator's own attribute name is the HTTP verb and its
 * call's first string-literal argument is the route path (FastAPI's
 * `@app.get(path)` convention, whether `app` is itself imported or
 * built one hop away by a call to something imported, e.g. `app =
 * FastAPI()`).
 *
 * No TypeScript analogue: TS route registration is call-based
 * (`app.get(path, handler)`), never decorator-based with the verb
 * carried in the decorator's own name.
 */
export interface DecoratedFunctionRoute extends RouteConventions {
  type: "decoratedFunctionRoute";
  importModule: string[];
  /** Decorator attribute name, mapped to the HTTP verb it names (e.g. { get: "GET", post: "POST" }). */
  verbAttributeNames: Record<string, string>;
  /**
   * Keyword argument on the decorator call naming a locally-defined
   * class as the declared response body shape (FastAPI's
   * `response_model`). Unset means the pack doesn't declare one, and
   * the return annotation is the only source for the response shape.
   */
  responseModelKeyword?: string;
  /** Keyword argument on the decorator call naming a literal response status code (FastAPI's `status_code`). */
  statusCodeKeyword?: string;
}

/**
 * The names a library gives router mounting, so the route path a
 * reader would see at the wire composes from up to two literal
 * prefixes: the router constructor's own, and the one at the single
 * call that mounts the router (FastAPI's `APIRouter(prefix=...)` plus
 * `app.include_router(router, prefix=...)`). Anything the composition
 * cannot read as one construction, one mount, and literal prefixes
 * abstains: the route is still discovered by name, with no path (see
 * routers.ts).
 */
export interface RouterComposition {
  /** Constructor whose call builds a mountable router, as the library exports it (FastAPI's `APIRouter`). */
  routerConstructorName: string;
  /** Method that mounts a router onto the app, as the library defines it (FastAPI's `include_router`). */
  includeMethodName: string;
  /**
   * Keyword naming the literal path prefix, on the constructor and on
   * the mount call alike (FastAPI's `prefix`). One name serving both
   * sites is an assumption FastAPI happens to satisfy; a library that
   * spells the constructor's prefix differently from the mount's
   * needs this split into two fields.
   */
  prefixKeyword: string;
  /**
   * What that keyword at the mount call does to the prefix the
   * constructor stated. "prefixes" (the default) puts it in front, the
   * way FastAPI's `include_router(router, prefix=...)` does. "replaces"
   * swaps the constructor's prefix out, and a mount that states one
   * abstains rather than composing: the reading would otherwise report
   * a path the mount overrode. Composing a replacement is readable and
   * a later change can do it; abstaining is what keeps the wrong path
   * out in the meantime.
   */
  mountPrefixEffect?: MountPrefixEffect;
  /**
   * Whether the constructor has to state the prefix for the mounted
   * path to be readable. Set it when the library serves a router that
   * states no prefix under a path it derives from something else (a
   * name, say), which this reading does not derive: such a router
   * abstains instead of composing an empty prefix and reporting a path
   * that is short by a segment. Unset means a router with no prefix
   * really does add nothing to the path, which is FastAPI's behavior.
   */
  constructorPrefixRequired?: boolean;
  /**
   * What the library makes of a prefix keyword written with a value
   * it takes as no value at all: Python's `None` or `False`, zero, or
   * the empty string. "unstated" reads all four the way it reads a
   * keyword nobody wrote, which is flask-restx's behavior at the
   * constructor and at the mount alike, since it asks whether the
   * path is truthy. "unreadable" is the default and abstains, which
   * is what FastAPI needs: an empty string there is an ordinary
   * prefix that adds nothing, and the other three stop the app from
   * starting, so nothing about a served path can be read off them.
   *
   * One answer covers both sites on purpose. Reading the same
   * spelling one way at the constructor and another at the mount is
   * how this went wrong twice.
   */
  noValuePrefix?: NoValuePrefix;
  /**
   * What the library does with a trailing slash on the constructor's
   * prefix before the route's own path is joined to it. "kept" (the
   * default) joins the two as written, which is what FastAPI needs:
   * it refuses a prefix ending in a slash at construction, so a kept
   * one never reaches a served path. "trimmed" drops trailing slashes
   * first, which is what flask-restx does, so a prefix written
   * `"/orders/"` serves the same paths as `"/orders"` and a prefix
   * written `"/"` adds nothing. Composing without this reports a
   * doubled slash that the app never serves.
   */
  constructorPrefixTrailingSlash?: PrefixTrailingSlash;
}

/** What a literal prefix at the mount call does to the one the constructor stated. */
export type MountPrefixEffect = "prefixes" | "replaces";

/** What a library does with a trailing slash on a prefix before joining a path to it. */
export type PrefixTrailingSlash = "kept" | "trimmed";

/** What a library makes of a prefix written as a value it takes as no value at all. */
export type NoValuePrefix = "unstated" | "unreadable";
