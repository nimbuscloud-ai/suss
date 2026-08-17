/**
 * The Python adapter's own pattern-pack contract.
 *
 * This is deliberately not the TypeScript adapter's `PatternPack`. That type
 * dispatches its discovery variants through ts-morph-specific handlers, and
 * Python's two route shapes have no exact match in its union anyway. Match
 * shapes stay per-language until a second implementation shows what is actually
 * shared, and this is the per-language one for Python.
 *
 * A pack is still plain data, following the same rule the TypeScript packs
 * follow: it describes what a library defines, never anything a project chose.
 */

export interface PythonPack {
  name: string;
  /** Wire protocol for the produced boundary bindings, e.g. "http". */
  protocol: string;
  discovery: PythonDiscoveryPattern[];
  /**
   * Modules the project itself supplies, the wrappers a person names
   * when configuring the pack. The library's own module is not one of
   * these: it lives outside the project and would never resolve. The
   * adapter checks each of these against the project's roots, because
   * a wrapper that resolves to nothing does not match any decorator
   * and never says why (#188).
   */
  projectModules?: string[];
  /** What the library's own database queries look like. The README says how one is matched. */
  storage?: StoragePattern[];
  /** How the library lets a project hand the database SQL it wrote itself. */
  rawSql?: RawSqlPattern[];
}

/**
 * A call talks to the database when the method behind it says it returns one
 * of the library's query types. Matching on the return rather than on the
 * import is what reads a project base class that wraps the library, which is
 * how the measured corpus writes every one of its queries.
 */
export interface StoragePattern {
  /** The module a query type is imported from, `sqlalchemy.orm` for a Session. */
  module: string;
  /** Type names that mean the value is a query against the database. */
  queryTypes: string[];
  /** Chain-ending methods that change what is stored. Anything else reads. */
  writes: string[];
  /**
   * Functions the library exports that start a query on their own, for the
   * case where a call site imports one rather than reaching it through a
   * project class. `select(...)` in SQLAlchemy 2.0 is one.
   */
  queryFunctions?: string[];
  /** Which database the library is talking to, for the boundary binding. */
  storageSystem: "postgres" | "mysql" | "sqlite";
}

/**
 * The function a library gives a project for handing the database a
 * statement written as SQL, and where it comes from. SQLAlchemy exports
 * `text` from `sqlalchemy`. A local function of the same name is
 * somebody else's, so the import is what settles a match.
 */
export interface RawSqlPattern {
  /** The module the function is imported from. */
  module: string;
  /** The functions that take a statement written as SQL. */
  functions: string[];
  /** Which database the library is talking to, for the boundary binding. */
  storageSystem: "postgres" | "mysql" | "sqlite";
}

export type PythonDiscoveryPattern =
  | DecoratedClassRoute
  | DecoratedFunctionRoute;

/** Conventions both kinds of route share. Each one describes what the library does, never a project's choice. */
export interface RouteConventions {
  /** How the library spells a path parameter. The README lists the syntaxes we know how to read. */
  pathParamSyntax?: string;
  /** Set it only when the library itself binds an annotated local class to the request body. */
  annotatedClassIsRequestBody?: boolean;
  /**
   * Callables the library uses to inject a parameter rather than read it
   * off the request. FastAPI's `Depends` and `Security` are these: the
   * server supplies the value and the client sends nothing, so a
   * parameter defaulted to one of them is no part of the request however
   * its annotation reads.
   */
  injectedParameterCallees?: string[];
  /**
   * What the library serves when a composed path ends up with repeated
   * slashes in it. Werkzeug serves the merged path and redirects
   * the written one, so "merged" is what Flask needs; "kept" is the
   * default and is what Starlette does.
   */
  pathRepeatedSlashes?: PathRepeatedSlashes;
  /** The status the library returns for a declared response when the route does not give one. Library-defined. */
  defaultStatusCode?: number;
  /**
   * Set it only when the library reads a status out of the tuple a handler
   * returns, which is what Flask does with `return body, 201`. Without it
   * the library default applies whatever the body returns, and a route
   * that sets its own status would be reported at the default.
   */
  statusFromReturnedTuple?: boolean;
  /** Unset means the library has no router mounting, and a route's decorator path stands as written. */
  routerComposition?: RouterComposition;
}

/**
 * A class has a decorator whose first string-literal argument is the route path,
 * and each method in its body named after an HTTP verb becomes its own unit,
 * with the verb taken from the method name.
 */
export interface DecoratedClassRoute extends RouteConventions {
  type: "decoratedClassRoute";
  /** The library's own module, plus any wrapper module the person configuring the pack lists alongside it. */
  importModule: string[];
  /** The decorator's name as the library exports it, "route" for flask-restx's `Namespace.route`. */
  decoratorName: string;
  /** Method name written in the class body, mapped to the HTTP verb it dispatches. */
  verbMethodNames: Record<string, string>;
}

/**
 * A function has a decorator whose attribute name is the HTTP verb and whose
 * first string-literal argument is the route path, the `@app.get(path)`
 * convention. The object it hangs on may be imported, or built one hop away by
 * a call to something imported.
 */
export interface DecoratedFunctionRoute extends RouteConventions {
  type: "decoratedFunctionRoute";
  importModule: string[];
  /** Decorator attribute name, mapped to the HTTP verb it means. */
  verbAttributeNames: Record<string, string>;
  /** Unset leaves the return annotation as the only source for the response shape. */
  responseModelKeyword?: string;
  statusCodeKeyword?: string;
}

/**
 * What a library calls the pieces of router mounting, so a route's served path
 * can be built from the literal prefixes written along the way: the router
 * constructor's own, the one at the call that mounts it, and, where the pack
 * says so, the prefix on the object the mount is called on. What each spelling
 * of a prefix means, and what makes a composition abstain, is the grid in the
 * adapter's README.
 */
export interface RouterComposition {
  /** Constructor whose call builds a mountable router, FastAPI's `APIRouter`. */
  routerConstructorName: string;
  /** Method that mounts a router onto the app, FastAPI's `include_router`. */
  includeMethodName: string;
  /** One keyword serves the constructor and the mount alike. A library that spells them apart needs two fields here. */
  prefixKeyword: string;
  /** Default "prefixes". */
  mountPrefixEffect?: MountPrefixEffect;
  /** Set it when the library works out a path for a router that gives no prefix. We cannot work that path out, so such routes abstain. */
  constructorPrefixRequired?: boolean;
  /** Default "unreadable". The same setting covers the constructor and the mount. */
  noValuePrefix?: NoValuePrefix;
  /** Default "kept". */
  constructorPrefixTrailingSlash?: PrefixTrailingSlash;
  /**
   * Where the object the mount is called on states a prefix of its
   * own, in front of everything the constructor and the mount state.
   * Unset means it states none, which is FastAPI's behavior: an app
   * serves a mounted router exactly where the two prefixes put it.
   */
  mountObjectPrefix?: MountObjectPrefix;
}

/**
 * The prefix the object a mount is called on states, and where it is
 * written. flask-restx needs both halves: `Api(prefix=...)` states one
 * on the object itself, and the Flask blueprint the `Api` was built
 * from states another with `Blueprint(name, __name__,
 * url_prefix=...)`. The library serves a route under the blueprint's
 * prefix, then the `Api`'s, then whatever the namespace and the route
 * say.
 */
export interface MountObjectPrefix {
  /** Keyword stating a prefix on the mount object's own construction (flask-restx's `Api(prefix=...)`). */
  prefixKeyword?: string;
  /** The object handed to that construction which states a prefix of its own. */
  carrier?: MountObjectCarrier;
}

/**
 * An object handed to the mount object's constructor, one hop further
 * out, with a prefix of its own (the Flask blueprint behind an
 * `Api`). Naming it here is what lets the adapter tell that object
 * apart from the plain app that appears in the same argument position and
 * has no prefix at all.
 */
export interface MountObjectCarrier {
  /** Modules the carrier's constructor is imported from (Flask's `flask`). */
  importModule: string[];
  /** Constructor building the carrier, as its library exports it (Flask's `Blueprint`). */
  constructorName: string;
  /** Position of the carrier among the mount object's constructor arguments. */
  argumentIndex: number;
  /** Keyword stating the carrier's prefix, at its construction and at its registration alike (Flask's `url_prefix`). */
  prefixKeyword: string;
  /**
   * Method handing the carrier to an already-built mount object
   * (flask-restx's `init_app`, the application-factory spelling of
   * `Api(blueprint)`). Unset means the constructor argument is the
   * only way in.
   */
  handoffMethodName?: string;
  /**
   * Method registering the carrier somewhere else (Flask's
   * `register_blueprint`). The adapter reads it only to abstain: a
   * registration restating the prefix, putting the carrier inside
   * another carrier, or happening twice moves the served path
   * somewhere the carrier's own construction no longer says.
   */
  registerMethodName: string;
}

export type MountPrefixEffect = "prefixes" | "replaces";

export type PrefixTrailingSlash = "kept" | "trimmed";

export type NoValuePrefix = "unstated" | "unreadable";

/**
 * Werkzeug serves the merged path and redirects the written one, so Flask
 * needs "merged". Starlette leaves the path as composed, so FastAPI keeps
 * the default.
 */
export type PathRepeatedSlashes = "kept" | "merged";
