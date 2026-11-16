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

import type {
  MessageBusTechnology,
  RequestSpellingMetadata,
} from "@suss/behavioral-ir";
import type {
  ClassBodyDeclaration,
  DeclaredDiscoveryPattern,
  InvocationRecognizer,
  LibraryEnvVars,
  PackWords,
  PatternPack,
  RedirectOption,
  RequestRecognizer,
  RouteTableDeclaration,
} from "@suss/extractor";
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
  /** Patterns every adapter reads the same way, through the module ops over this adapter's facts. */
  declaredDiscovery?: DeclaredDiscoveryPattern[];
  /** Environment variables the library reads from its own installed code, where no walk over the project goes. */
  libraryEnvVars?: LibraryEnvVars[];
  /**
   * Wrapper modules around the library that a person lists when
   * configuring the pack. The library's own module does not go here. The adapter
   * reports each of these that no file in the run imports, since
   * otherwise it would match no decorator and nothing would say why (#188).
   */
  projectModules?: string[];
  /**
   * The callables the library gives a project for making a request, as
   * a pack wrote them before `requestRecognizers`. Each pattern is read
   * as the request chain that says the same thing.
   */
  clients?: PyClientCall[];
  /** The requests the library sends, as a pack declared with `@suss/recognize` compiles them. */
  requestRecognizers?: readonly RequestRecognizer[];
  /**
   * What the library reads out of a model's class body: a field assigned
   * from the library's own relationship callable reaches another model.
   */
  classBodies?: ClassBodyDeclaration[];
  /** What the library's own calls give back, `session.get(User, id)` one `User`, as a `pack()` pack states it. */
  words?: PackWords;
  /** Which of the library's classes return themselves from `__enter__`, so a `with` block gets the object itself. */
  contextManagers?: PyContextManager[];
  /**
   * The hooks a pack declared with `@suss/recognize` compiles to. Each one
   * is run over every call in a body, with the ops over the facts on its
   * context, as the TypeScript adapter runs them.
   */
  invocationRecognizers?: readonly InvocationRecognizer[];
  /**
   * The same pack's hooks for a statement written as SQL, which TypeScript
   * also runs over a tagged template. Python has none, so these run over
   * every call too.
   */
  accessRecognizers?: readonly InvocationRecognizer[];
  /**
   * The hook a pack declared with `@suss/recognize` has for a callback a
   * call writes in place. It is run over each function whose body the
   * run reads, and each lambda it claims gets a summary of its own.
   */
  subUnits?: PatternPack["subUnits"];
  /** Functions the library exports that hand back the argument at `argument`, such as a decorator that returns the function it was given. */
  transparentWrappers?: UnwrapsByName[];
  /**
   * The objects the library puts the request on for a route to read,
   * such as Flask's module-level `request`. A route is handed no
   * parameter for them, so without this a value read off one is not
   * known to come from the request.
   */
  requestObjects?: RequestObject[];
  /** Where a route reads each part of the request, recorded on every route the pack finds. */
  requestSpelling?: RequestSpellingMetadata;
  /** How the library's test runner collects tests, so a PRD scenario can say which test covers it. */
  tests?: PyTestCases[];
  /** How the library runs a project function as a background job, and the calls that enqueue one. DESIGN.md says how each is read. */
  jobQueues?: PyJobQueue[];
}

/**
 * A library that runs a project's functions off a queue, such as Celery.
 * A function under one of `taskDecorators` becomes a consumer unit, and a
 * call that enqueues it becomes a `message-send` on the same channel.
 * Every name here is one the library defines.
 */
export interface PyJobQueue {
  /** The bus the bindings say, `celery`. */
  messageBus: MessageBusTechnology;
  /** The module the library's decorators and app class come from, `celery`. */
  module: string;
  /** Decorators that make a function a task: `shared_task`, and `task` on the app. */
  taskDecorators: string[];
  /** The keyword a task decorator takes the task's name under: `name`. */
  nameKeyword: string;
  /** The keyword a task decorator takes its queue under: `queue`. */
  queueKeyword: string;
  /** What the library calls a task whose decorator gives no name. */
  defaultName: PyDefaultTaskName;
  /** Methods on a task that enqueue it, and where each takes the task's arguments. */
  enqueueMethods: PyEnqueueMethod[];
  /** Methods on the app that enqueue a task by its name, `send_task`. */
  sendByName?: PySendByName[];
  /** The app's class, and the objects the module exports that stand for the app: `Celery`, `current_app`. */
  apps: string[];
}

/**
 * `modulePath` is Celery's: the dotted path of the module the function
 * is written in, a dot, and the function's name.
 */
export type PyDefaultTaskName = "modulePath";

/** Where a method takes one of its inputs: a position, a keyword, or both. */
export interface PyCallArgument {
  argument?: number;
  keyword?: string;
}

/**
 * How an enqueue call passes the task's arguments. `spread` passes them
 * as the call's own, `delay(a, b, c=1)`. `packed` passes the positional
 * ones as one sequence and the keyword ones as one mapping,
 * `apply_async((a, b), {"c": 1})`.
 */
export type PyTaskArguments =
  | { type: "spread" }
  | { type: "packed"; args: PyCallArgument; kwargs: PyCallArgument };

export interface PyEnqueueMethod {
  /** The method's name, `delay`. */
  method: string;
  arguments: PyTaskArguments;
}

export interface PySendByName {
  /** The method's name, `send_task`. */
  method: string;
  /** Where it takes the task's name. */
  name: PyCallArgument;
  /** Where it takes the task's arguments. */
  arguments: PyTaskArguments;
}

/**
 * How a test runner finds tests and what it runs around each one. Every
 * name here is one the runner itself defines or documents; a project's
 * own conventions come through `files`, which lists the files to read.
 * DESIGN.md says how the adapter reads each field.
 */
export interface PyTestCases {
  /** Base-name patterns of the files the runner collects, `*` matching any run of characters: `test_*.py`. */
  filePatterns: string[];
  /** What a test function or method name starts with: `test`. */
  functionPrefix: string;
  /** What a class of tests is named starting with: `Test`. */
  classPrefix: string;
  /** Base classes whose subclasses contain tests whatever the class is called, as dotted names: `unittest.TestCase`. */
  caseBaseClasses: string[];
  /** The functions and methods the runner calls before a test, by where they are written. */
  setUp: PyTestSetUp;
  /** Markers whose string arguments are the fixtures every test under them runs through, as dotted names: `pytest.mark.usefixtures`. */
  usesFixtureMarkers: string[];
  /** Decorators that declare a fixture, as dotted names: `pytest.fixture`. */
  fixtureDecorators: string[];
  /** The keyword on a fixture decorator that renames the fixture: `name`. */
  fixtureNameKeyword: string;
  /** The keyword on a fixture decorator that runs it before every test in its scope: `autouse`. */
  autouseKeyword: string;
  /** Files whose fixtures apply to every test under their directory: `conftest.py`. */
  sharedFixtureFiles: string[];
  /** Decorators that mark a test so it does not run, or runs expecting to fail, as dotted names: `pytest.mark.skip`. */
  skipDecorators: string[];
  /** The module or class variable the runner reads markers from for every test under it: `pytestmark`. */
  markerVariable?: string;
  /** Parameters the runner fills with something other than a fixture, which are never looked up: `self`, `request`. */
  reservedParameters: string[];
  /** How a test replaces something before it runs. */
  mocks: PyTestMocks;
  /** Read only these files, matched on whole path segments from the end. Left out, every collected file is read. */
  files?: string[];
}

/**
 * The setup a runner calls before a test, listed in the order it calls
 * them. A method is looked for on the class and then on the project
 * classes it extends, since the setup is often written on a base class.
 */
export interface PyTestSetUp {
  /** Functions in the test's module that run before any test in it: `setup_module`. */
  module: string[];
  /** Functions in the test's module that run before each test written as a function: `setup_function`. */
  function: string[];
  /** Methods of a class of tests that run before each test in it: `setup_class`, `setup_method`. */
  testClass: string[];
  /** Methods of a `caseBaseClasses` subclass that run before each test in it: `setUpClass`, `setUp`. */
  caseClass: string[];
}

/**
 * The calls that replace a module or a member for the length of a test.
 * A patcher called with a dotted string replaces the object at that path,
 * `patch("orders.service.cancel")`. Called with an object and a member
 * name, it replaces that member, `patch.object(OrderService, "cancel")`.
 */
export interface PyTestMocks {
  /** Patchers imported from a library, as dotted names: `unittest.mock.patch`, `unittest.mock.patch.object`. */
  patchers: string[];
  /** Patchers a fixture hands the test, by the fixture's parameter name and the methods called on it. */
  fixturePatchers: { fixture: string; methods: string[] }[];
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
  /** Whether the client follows a redirect itself or hands the 3xx back. */
  redirectDelivery?: "followed" | "response";
  /**
   * The keyword argument one call passes to change `redirectDelivery`
   * for itself: `allow_redirects` for requests, `follow_redirects` for
   * httpx.
   */
  redirectOption?: RedirectOption;
}

/** An object a module exports that a route reads the request off. */
export interface RequestObject {
  module: string;
  name: string;
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
   * Classes the library supplies a parameter for when the parameter is
   * annotated with one, by dotted path, such as FastAPI's
   * `fastapi.Request` and `fastapi.BackgroundTasks`. The client sends
   * nothing for such a parameter either.
   */
  injectedParameterTypes?: string[];
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
  /**
   * The callables that say which part of the request a parameter is read
   * from, by the callee's name, written as the default or inside
   * `Annotated[...]`: FastAPI's `x_tenant_id: str = Header()` is a header.
   */
  parameterSources?: Record<string, ParameterSource>;
  /** The keyword those callables take a field's name under when it differs from the parameter's, FastAPI's `alias`. */
  parameterAliasKeyword?: string;
  /** The ways the library runs a project's own function around a route. DESIGN.md lists what each one covers. */
  wrappers?: PyWrapperForm[];
  /**
   * The status the library itself responds with, before the handler runs,
   * when a request input the route declares does not validate. FastAPI
   * sends 422. Unset means the library checks nothing on its own.
   */
  validationFailureStatus?: number;
  /**
   * The number each of the library's status constants is, keyed by the
   * module and name it is imported as (`fastapi.status.HTTP_404_NOT_FOUND`),
   * for a project read without the library installed.
   */
  statusCodeConstants?: Record<string, number>;
}

/** The part of the request a parameter declared with one callable is read from. */
export interface ParameterSource {
  /** The role the parameter gets, `headers` for FastAPI's `Header`. */
  role: string;
  /** What the library writes in place of `_` in the field's name, `-` for a FastAPI header. */
  underscoresAs?: string;
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
 * A route written as a class decorated with `@ns.route(path)` on a
 * namespace or an API, which the route table in `routes` finds. Each
 * method of the class the table serves becomes its own unit, under the
 * prefixes of what the namespace is mounted on. The decorator's first
 * argument is the route's own path.
 */
export interface DecoratedClassRoute extends RouteConventions {
  type: "decoratedClassRoute";
  /** The library's own module, plus any wrapper module the person configuring the pack lists alongside it. */
  importModule: string[];
  routes: DeclaredRoutes;
}

/**
 * A route written as a function decorated with `@app.get(path)` on an app
 * or a router, which the route table in `routes` finds and serves under
 * the prefixes of the routers it is mounted through. The decorator's
 * first argument is the route's own path.
 */
export interface DecoratedFunctionRoute extends RouteConventions {
  type: "decoratedFunctionRoute";
  /** The library's own module, plus any wrapper module the pack lists alongside it, for the wrappers registered around a route. */
  importModule: string[];
  routes: DeclaredRoutes;
  /** Unset leaves the return annotation as the only source for the response shape. */
  responseModelKeyword?: string;
  statusCodeKeyword?: string;
  /**
   * The keyword whose dictionary lists statuses a route may respond
   * with, FastAPI's `responses`, on the route decorator, its router, a
   * mount call above it or the app. Its keys become the route's declared
   * statuses.
   */
  responsesKeyword?: string;
}

/**
 * A library's routes as a route table, composed over every file of the
 * run: the decorators called on an app or a router, and the calls that
 * mount one router onto another, wherever each is written.
 */
export interface DeclaredRoutes {
  table: RouteTableDeclaration;
  unread: RouterUnreadWords;
}

/**
 * Why a route the table found has no path, said of the router it is
 * declared on, each worded to follow "The router this route is declared
 * on". A reason about a router higher up than the one it is mounted onto
 * is said with `chain`. `{loops}` is where the loops that may mount the
 * router go, as "a loop at main.py:4 mounts" or "loops at a.py:2, b.py:9
 * mount".
 */
export interface RouterUnreadWords {
  /** Nothing mounts the router. */
  unreached: string;
  /** The name the route is declared on is assigned more than one router, so it is on none of them in particular. */
  shared: string;
  /** Nothing mounts it by name, and loops the table cannot list may. */
  unlistedLoop: string;
  /** Its mount is in a function, and loops the table cannot list may mount it in that mount's place. */
  rivalledMount: string;
  /** The prefix its mount states does not read. */
  mountUnread: string;
  /** Its own prefix does not read. */
  prefixUnread: string;
  /** The prefix of the router it is mounted onto does not read. */
  ontoPrefixUnread: string;
  /** The router it is mounted onto, or one above that, gives it no path. */
  chain: string;
  /** It states no prefix, where its library makes one up. Unset says it with `chain`, for a library whose routers never lack one. */
  prefixUnstated?: string;
  /** Its mount states a prefix that replaces its own. Unset says it with `chain`. */
  prefixReplaced?: string;
  /** Why the root the route is served from gives it no path. Unset says it with `chain`, for a library whose roots state no path. */
  root?: RootUnreadWords;
}

/**
 * Why the root a route is served from gives it no path, from its own
 * prefix or from the value it is built within, each worded to follow
 * "The router this route is declared on" for a route declared on the
 * root. For a route on a router mounted onto the root, each is said
 * through `mountedOn`, with the reason in place of `{reason}`.
 */
export interface RootUnreadWords {
  mountedOn: string;
  /** The root's own prefix does not read. */
  rootPrefixUnread: string;
  /** The root is built within one value and handed another, or handed two. */
  carrierSeveral: string;
  /** The value it is built within comes to no construction the table reads. */
  carrierUnfollowed: string;
  /** That value is written as a name assigned more than one construction. */
  carrierShared: string;
  /** That value's prefix does not read. */
  carrierPrefixUnread: string;
  /** That value is registered with a prefix of the registration's own. */
  carrierRepathed: string;
  /** That value is registered on another of its kind. */
  carrierNested: string;
  /** That value is registered more than once. */
  carrierRegisteredTwice: string;
}
