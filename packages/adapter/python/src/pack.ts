/**
 * The contract a Python pack is written against.
 *
 * It is separate from the TypeScript adapter's `PatternPack` on purpose. That
 * type dispatches its discovery variants through handlers built on ts-morph,
 * and Python's two kinds of route have no exact match in its union. Each
 * language keeps its own match patterns until a second implementation shows
 * which parts the two have in common.
 *
 * A pack is plain data under the same rule the TypeScript packs follow: it
 * describes what a library defines, and nothing a project chose.
 */

import type { UnwrapsByName } from "@suss/resolution";

export interface PythonPack {
  name: string;
  /**
   * Part of the cache key. Bump it on any change that affects the units a
   * pack discovers or the summaries it produces. The CLI also adds a hash
   * of the loaded pack file and its config to the key, so a pack run
   * through the CLI invalidates the cache on an edit whether or not it
   * declares a version.
   */
  version?: string;
  /**
   * Given the `.py` files a run is about to walk, returns the other files
   * in the project this pack reads. Their content goes into the cache key
   * along with the pack's config, so editing one of them re-extracts
   * instead of returning the cached summaries.
   */
  discoveryInputs?: (files: readonly string[]) => string[];
  /** Wire protocol for the produced boundary bindings, e.g. "http". */
  protocol: string;
  discovery: PythonDiscoveryPattern[];
  /**
   * Wrapper modules around the library that a person lists when
   * configuring the pack. The library's own module does not go here. The adapter
   * reports each of these that no file in the run imports, since
   * otherwise it would match no decorator and nothing would say why (#188).
   */
  projectModules?: string[];
  /** The callables the library gives a project for making a request. */
  clients?: PyClientCall[];
  /** What the library's own database queries look like. DESIGN.md says how one is matched. */
  storage?: StoragePattern[];
  /** Which of the library's calls give back one of a model class. DESIGN.md says what a chain of them composes into. */
  models?: PyModelQueries[];
  /** Which of the library's classes return themselves from `__enter__`, so a `with` block gets the object itself. */
  contextManagers?: PyContextManager[];
  /** How the library lets a project hand the database SQL it wrote itself. */
  rawSql?: RawSqlPattern[];
  /** The client objects the library hands a project, and the calls on one that reach the database. */
  sqlClients?: SqlClientPattern[];
  /** Functions the library exports that hand back the argument at `argument`, such as a decorator that returns the function it was given. */
  transparentWrappers?: UnwrapsByName[];
}

/**
 * A call talks to the database when the method behind it declares that it
 * returns one of the library's query types. Matching on the return type finds
 * queries made through a project base class that wraps the library, where a
 * match on the import would find none.
 */
export interface StoragePattern {
  /** The module a query type is imported from, `sqlalchemy.orm` for a Session. */
  module: string;
  /** Type names that mean the value is a query against the database. */
  queryTypes: string[];
  /** Chain-ending methods that change what is stored. Anything else reads. */
  writes: string[];
  /**
   * Methods on a query type that touch no rows of their own, and a call to
   * one records nothing. `session.execute(stmt)` runs a statement whose own
   * chain already records the work, and `close` manages the session.
   */
  recordsNothing?: string[];
  /**
   * Methods whose keywords supply column values instead of picking rows,
   * `values` in `update(User).where(id=1).values(name="x")`. Their keywords
   * are reported as fields, and every other call's keywords as the selector.
   */
  valueMethods?: string[];
  /**
   * Functions the library exports that start a query on their own, such as
   * SQLAlchemy 2.0's `select(...)`. A call site imports one directly instead
   * of reaching it through a project class.
   */
  queryFunctions?: string[];
  /** Which database the library is talking to, for the boundary binding. */
  storageSystem: "postgresql" | "mysql" | "sqlite";
}

/**
 * Which of a library's calls give back an instance of the project model
 * class they were passed, so a method called on the result resolves to the
 * one that class declares. SQLAlchemy and SQLModel take the class as an
 * argument, as in `session.get(User, id)` and `select(User)`, where a Rails
 * finder is called on the class itself.
 */
export interface PyModelQueries {
  /**
   * The names a model's base classes lead back to: a base class the
   * library exports, `DeclarativeBase`, or the function that builds one,
   * `declarative_base`.
   */
  baseNames: string[];
  /** Methods whose result is the model again: one row, or a query a later read narrows to one. */
  givesBack: string[];
  /** Methods that take the model class and give back one of it, with the position it is written at. */
  entryMethods: PyModelEntryMethod[];
  /** Functions the library exports that do the same, called on their own instead of on a session. */
  entryFunctions: PyModelEntryFunction[];
  /** The library's own constructors for a field that reaches another model. */
  relationships?: PyRelationshipConstructor[];
}

/**
 * The callable a model field is assigned from to say it points at another
 * model, as in `items: list[Item] = Relationship(...)`, and where it is
 * imported from. A match needs the import, so a project function with the
 * same name does not count.
 */
export interface PyRelationshipConstructor {
  /** The module it is imported from, `sqlmodel` or `sqlalchemy.orm`. */
  module: string;
  /** Its name, `Relationship` or `relationship`. */
  name: string;
}

/** `session.get(User, id)`: the method, and where the class is written. */
export interface PyModelEntryMethod {
  method: string;
  argument: number;
}

/** `select(User)`: the function, the module it comes from, and where the class is written. */
export interface PyModelEntryFunction {
  module: string;
  name: string;
  argument: number;
}

/**
 * The function a library gives a project for handing the database a
 * statement written as SQL, and where it is imported from. SQLAlchemy
 * exports `text` from `sqlalchemy`. A match needs the import, so a local
 * function with the same name does not count.
 */
export interface RawSqlPattern {
  /** The module the function is imported from. */
  module: string;
  /** The functions that take a statement written as SQL. */
  functions: string[];
  /** Which database the library is talking to, for the boundary binding. */
  storageSystem: "postgresql" | "mysql" | "sqlite";
}

/**
 * A client object a library hands a project, and the calls on one that
 * reach the database. `RawSqlPattern` matches a function the file imported.
 * This matches a method called on a value whose class comes from the
 * library, so a client built in one module and called in another still
 * matches.
 *
 * Every field describes the library: the module, the class and method
 * names, and where each method takes its input.
 */
export interface SqlClientPattern {
  /** The module the client class comes from, `google.cloud.bigquery`. */
  module: string;
  /** The class names whose instances take these calls, `Client`. */
  clientTypes: string[];
  /** The methods that hand the database a statement, and where each takes it. */
  statements?: SqlStatementCall[];
  /** The methods that take a table name instead of SQL, and what each does to the table. */
  tables?: SqlTableCall[];
  /** The methods that return an instance of another of the library's classes, so a chain can continue through it. */
  handsBack?: SqlClientHandoff[];
  /** Which database the client is talking to, for the boundary binding. */
  storageSystem: string;
  /** Which SQL dialect the statements are written in, when that is not the storage system's own name. */
  dialect?: string;
}

/** Where one method takes what it is given: a position, a keyword, or both. */
export interface SqlCallArgument {
  /** The position it is written at. */
  argument?: number;
  /** The keyword it may be written under instead. */
  keyword?: string;
}

/** One method that takes a statement written as SQL. */
export interface SqlStatementCall extends SqlCallArgument {
  /** The method name, `query`. */
  method: string;
  /**
   * The keys to follow when the statement is passed inside a dictionary
   * instead of as the argument itself: `["query", "query"]` for
   * `insert_job(configuration={"query": {"query": sql}})`.
   */
  path?: string[];
}

/** One method that takes the name of the table it works on, and what it does to that table. */
export interface SqlTableCall extends SqlCallArgument {
  /** The method name, `get_table`. */
  method: string;
  /** Whether the call changes what is stored. */
  kind: "read" | "write";
}

/** One method that returns an instance of another of the library's classes. */
export interface SqlClientHandoff {
  /** The method name, Airflow's `get_client`. */
  method: string;
  /** The module the class it hands back comes from. */
  module: string;
  /** That class's name. */
  name: string;
}

export type PythonDiscoveryPattern =
  | DecoratedClassRoute
  | DecoratedFunctionRoute;

/**
 * Classes whose `__enter__` returns the object it was called on, so
 * `with X() as y` binds `y` to the `X()` the block opened. Python lets
 * `__enter__` return anything, so only the library that wrote the class
 * knows this, and a pack declares it only for its own library's classes.
 */
export interface PyContextManager {
  /** The module the classes come from, `httpx`. */
  module: string;
  /** The class names the library documents as returning self. */
  returnsSelf: string[];
}

/**
 * The callables a library gives a project for making a request. A
 * function that calls one of them becomes a client unit, bound to the
 * method and path that call is made with.
 */
export interface PyClientCall {
  type: "clientCall";
  /** The module the callables come from, `requests`. */
  importModule: string[];
  /** Attribute names that state the method themselves: `get` means GET. */
  verbAttributeNames: Record<string, string>;
  /** Where a call whose name states the method states its URL. */
  url: { position: number; keyword: string };
  /** A call that takes the method as an argument instead, `request("GET", url)`. */
  methodCall?: {
    attribute: string;
    methodPosition: number;
    methodKeyword?: string;
    urlPosition: number;
  };
  /** Constructors whose instances take the same calls, `Session`. */
  receiverConstructors?: string[];
  /** What the response object gives a caller, so a guard on one of its members counts as a guard on a status. */
  response?: PyClientResponse;
}

/**
 * The members a library's response object gives a caller. A test on one of
 * them shows which statuses the caller handles, and the checker compares
 * that against what the other side sends.
 */
export interface PyClientResponse {
  /** Members whose value is the status code: `status_code`. */
  statusCode?: string[];
  /** Members that say the request succeeded, meaning a status in 200 to 299: `ok`. */
  success?: string[];
  /** Members that give the body: `json`, `text`, `content`. */
  body?: string[];
  /** Whether a refused request comes back as a response or raises where it was made. */
  failureDelivery?: "response" | "exception";
}

/** Conventions both kinds of route share. Each one describes what the library does, never a project's choice. */
export interface RouteConventions {
  /** How the library writes a path parameter. DESIGN.md lists the syntaxes the adapter reads. */
  pathParamSyntax?: string;
  /** Set it only when the library itself binds an annotated local class to the request body. */
  annotatedClassIsRequestBody?: boolean;
  /**
   * Callables the library uses to inject a parameter instead of reading it
   * off the request, such as FastAPI's `Depends` and `Security`. The server
   * supplies the value and the client sends nothing, so a parameter
   * defaulted to one of them is not part of the request, whatever its
   * annotation says.
   */
  injectedParameterCallees?: string[];
  /**
   * What the library serves when a composed path has repeated slashes.
   * Werkzeug serves the merged path and redirects the written one, so Flask
   * needs "merged". The default, "kept", matches Starlette.
   */
  pathRepeatedSlashes?: PathRepeatedSlashes;
  /** The status the library returns for a declared response when the route does not set one. */
  defaultStatusCode?: number;
  /**
   * Set it only when the library reads a status out of the tuple a handler
   * returns, as Flask does with `return body, 201`. Without it, every return
   * is reported at the library's default status, including a route that
   * sets its own.
   */
  statusFromReturnedTuple?: boolean;
  /**
   * The library's own callables that end the request with a status, such
   * as FastAPI's `HTTPException` and Flask's `abort`. A `raise` of one in a
   * route body becomes the response the library sends. A raise of anything
   * the list does not cover becomes a throw with no status.
   */
  responseStatusCalls?: PyStatusCall[];
  /**
   * The library's own classes that are sent as the response when a body
   * returns an instance, and where each takes the status, as in Starlette's
   * `JSONResponse(status_code=...)`. Returning one gives that status, and
   * returning anything else keeps the declared one.
   */
  responseConstructors?: PyStatusCall[];
  /** Unset means the library has no router mounting, and a route's decorator path is used as written. */
  routerComposition?: RouterComposition;
  /** The ways the library runs a project's own function around a route. DESIGN.md lists what each one covers. */
  wrappers?: PyWrapperForm[];
}

export type PyWrapperForm = PyDependencyForm | PyDecoratedWrapperForm;

/** Where a wrapper is registered, and which routes the registration reaches. */
export interface PyWrapperRegistrar {
  /** The constructor of the object the registration is written on, as the library exports it: `FastAPI`, `APIRouter`. */
  constructorName: string;
  /** Where the constructor is imported from, when that differs from the pattern's own `importModule`: `flask` for the app that serves a flask-restx API. */
  importModule?: string[];
  /**
   * `everyRoute` for the app, whose registration reaches every route of
   * the pack in the run. `ownRoutes` for a router or a blueprint, whose
   * registration reaches the routes decorated on that same object.
   */
  covers: "everyRoute" | "ownRoutes";
}

/**
 * A project function the library calls before the handler, passed to one
 * of the library's callables, as in FastAPI's `Depends(get_user)`. It can
 * be written as a parameter default, inside `Annotated[...]` on the route,
 * or in a list under `keyword` on the route decorator or a registrar. It
 * ends a request only by raising, so every return passes control on to
 * the route.
 */
export interface PyDependencyForm {
  type: "dependency";
  /** The callables that take the function: `Depends`, `Security`. */
  callees: string[];
  /** The keyword a list of them is written under: `dependencies`. */
  keyword: string;
  registrars: PyWrapperRegistrar[];
}

/**
 * A project function decorated with a method on the app or a router, such
 * as `@app.middleware("http")` or `@app.before_request`. Which of the three
 * optional fields below is set decides what the function's returns mean.
 * With none set, every return passes the request on.
 */
export interface PyDecoratedWrapperForm {
  type: "decoratedWrapper";
  /** The decorator's attribute name on the registrar: `middleware`. */
  attribute: string;
  registrars: PyWrapperRegistrar[];
  /**
   * The position of the parameter the wrapper calls to run what it
   * wraps, `call_next` at 1 for Starlette middleware. A return before
   * that call ends the request with what is returned.
   */
  continuationParam?: number;
  /**
   * Set when returning a value ends the request and only a bare return
   * passes it on. Flask's `before_request` works this way.
   */
  returnedValueResponds?: boolean;
  /** The parameter position the raised exception is passed at. Set on an exception handler, which runs only when the route raised. */
  throwParam?: number;
}

/**
 * One callable that ends the request, and where it takes the status. A
 * call can pass the status by keyword or by position, so a pattern can
 * declare both. When a call writes both, the keyword is used.
 */
export interface PyStatusCall {
  /** The callee as the file imports it, module and name together, `fastapi.HTTPException`. */
  callee: string;
  /** The keyword whose value gives the status, FastAPI's `status_code`. */
  statusKeyword?: string;
  /** The index of the positional argument giving the status, 0 for `abort(404)`. */
  statusArgument?: number;
  /** What the library sends when the call states no status of its own. */
  defaultStatusCode?: number;
}

/**
 * A route written as a class whose decorator takes the route path as its
 * first argument. Each method in the class named after an HTTP verb becomes
 * its own unit, with the verb taken from the method name.
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
 * A route written as a function decorated with `@app.get(path)`: the
 * decorator's attribute name is the HTTP verb and its first argument is the
 * route path. The object the decorator is called on can be imported, or
 * built by a call to something imported.
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
 * The names a library gives the parts of router mounting, so a route's
 * served path can be built from the prefixes written along the way: the
 * router constructor's, the one on the call that mounts it, and, where the
 * pack declares it, the one on the object the mount is called on. DESIGN.md
 * has the tables for what each way of writing a prefix means and when a
 * route abstains.
 */
export interface RouterComposition {
  /** Constructor whose call builds a mountable router, FastAPI's `APIRouter`. */
  routerConstructorName: string;
  /** Method that mounts a router onto the app, FastAPI's `include_router`. */
  includeMethodName: string;
  /**
   * The mount method's name for its router parameter, FastAPI's `router`,
   * used to read a call that passes the router by keyword. Unset reads the
   * first positional argument only.
   */
  routerKeyword?: string;
  /** The prefix keyword, the same at the constructor and the mount. A library that uses two different keywords would need two fields here. */
  prefixKeyword: string;
  /** Whether a prefix written at the mount goes in front of the constructor's ("prefixes") or replaces it ("replaces"). Default "prefixes". */
  mountPrefixEffect?: MountPrefixEffect;
  /** Set it when the library makes up a path of its own for a router constructed with no prefix. The adapter cannot work that path out, so such routes abstain. */
  constructorPrefixRequired?: boolean;
  /** What a prefix written as `""`, `None`, `False` or `0` means: no prefix ("unstated"), or one the route has to abstain on ("unreadable"). Default "unreadable", at the constructor and the mount alike. */
  noValuePrefix?: NoValuePrefix;
  /** Whether the library trims trailing slashes off a constructor's prefix. Default "kept". */
  constructorPrefixTrailingSlash?: PrefixTrailingSlash;
  /**
   * Where the object the mount is called on states a prefix of its own,
   * in front of everything the constructor and the mount state. Unset
   * means it states none. That matches FastAPI, where an app serves a
   * mounted router exactly where the two prefixes put it.
   */
  mountObjectPrefix?: MountObjectPrefix;
}

/**
 * Where the object a mount is called on states its prefix. flask-restx
 * needs both fields: `Api(prefix=...)` states one on the object itself,
 * and the Flask blueprint the `Api` was built from states another with
 * `Blueprint(name, __name__, url_prefix=...)`. A route is served under
 * the blueprint's prefix, then the `Api`'s, then the namespace's path and
 * the route's own.
 */
export interface MountObjectPrefix {
  /** Keyword stating a prefix on the mount object's own construction (flask-restx's `Api(prefix=...)`). */
  prefixKeyword?: string;
  /** The object handed to that construction which states a prefix of its own. */
  carrier?: MountObjectCarrier;
}

/**
 * An object passed to the mount object's constructor that has a prefix of
 * its own, such as the Flask blueprint an `Api` is built from. Declaring
 * its constructor lets the adapter tell it apart from the plain app, which
 * is passed in the same argument position and has no prefix.
 */
export interface MountObjectCarrier {
  /** Modules the carrier's constructor is imported from (Flask's `flask`). */
  importModule: string[];
  /** Constructor building the carrier, as its library exports it (Flask's `Blueprint`). */
  constructorName: string;
  /** Position of the carrier among the mount object's constructor arguments. */
  argumentIndex: number;
  /** The keyword for the carrier's prefix, at its construction and its registration alike (Flask's `url_prefix`). */
  prefixKeyword: string;
  /**
   * Method that passes the carrier to a mount object already built, as
   * flask-restx's `init_app` does in an application factory in place of
   * `Api(blueprint)`. Unset means the constructor argument is the only
   * way to pass one.
   */
  handoffMethodName?: string;
  /**
   * Method that registers the carrier somewhere else (Flask's
   * `register_blueprint`). The adapter reads it only to decide when to
   * abstain. A registration that restates the prefix, registers the
   * carrier inside another carrier, or registers it twice serves the
   * routes somewhere other than where the carrier's construction says.
   */
  registerMethodName: string;
}

export type MountPrefixEffect = "prefixes" | "replaces";

export type PrefixTrailingSlash = "kept" | "trimmed";

export type NoValuePrefix = "unstated" | "unreadable";

/** Werkzeug merges repeated slashes, so Flask needs "merged". Starlette does not, so FastAPI keeps "kept". */
export type PathRepeatedSlashes = "kept" | "merged";
