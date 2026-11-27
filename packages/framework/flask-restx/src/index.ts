/**
 * flask-restx `Resource` routes for the Python adapter. A route is a
 * class decorated with `Namespace.route(path)` or `Api.route(path)`, and
 * each of its methods named after a verb (`get`, `post`, ...) serves
 * that verb.
 *
 * The route table puts the blueprint's prefix, the `Api`'s and the
 * namespace's path in front of a route's own. The README lists the
 * cases where a route keeps its name and gets no path. The pack does not
 * read response marshaling (`@ns.marshal_with`, `@ns.expect`).
 */

import { z } from "zod";

import { constructedFrom, returnedBy } from "@suss/recognize";

import type {
  PyNotFound,
  PyServedBeside,
  PyServingCall,
  PythonPack,
  PyWrapperForm,
  RouterUnreadWords,
} from "@suss/adapter-python";
import type { RouteTableDeclaration } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "4";

/**
 * The CLI checks a `-f flask-restx=config.json` file against this schema.
 * A config file may not set a key that only a dependency stub fills.
 */
export const optionsSchema = z
  .object({
    /**
     * Modules that re-export flask-restx's route decorator, on top of
     * `flask_restx` itself. A dependency stub fills this in; a project's
     * config file may not set it.
     */
    wrapperModules: z.array(z.string()).optional(),
  })
  .strict();

export type FlaskRestxPackOptions = z.infer<typeof optionsSchema>;

/** The methods of a resource class that serve a request, and the verb each serves, which is its name upper-cased. */
const VERB_METHOD_NAMES: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  delete: "DELETE",
  patch: "PATCH",
  head: "HEAD",
  options: "OPTIONS",
};

/**
 * flask-restx's API and namespaces as a route table. A route is a class
 * decorated with `route` on either, and `add_namespace` mounts a
 * namespace onto the API. Werkzeug serves a route at the blueprint's
 * prefix, then the API's, then the namespace's path, then the route's,
 * joined as written with repeated slashes merged. The Python adapter's
 * DESIGN.md has a table of what each way of writing a prefix means.
 */
export function flaskRestxRoutes(
  modules: readonly string[],
): RouteTableDeclaration {
  return {
    roots: {
      kinds: { Api: 0 },
      children: { in: "receiver" },
      in: "file",
      path: [{ keyword: "prefix" }],
      noValue: "unstated",
      carrier: {
        at: { at: 0 },
        handedBy: "init_app",
        from: ["flask"],
        paths: { Blueprint: [{ keyword: "url_prefix" }] },
        noValue: "unstated",
        registeredBy: {
          method: "register_blueprint",
          at: { at: 0 },
          path: [{ keyword: "url_prefix" }],
        },
      },
    },
    from: modules,
    joins: "merged",
    loops: ["for"],
    throughWrappers: true,
    roles: {
      route: {
        role: "serves",
        methods: { members: Object.keys(VERB_METHOD_NAMES) },
        path: [{ at: 0 }],
        handler: { decorated: true },
      },
      add_namespace: {
        role: "mount",
        table: [{ at: 0 }],
        at: [{ keyword: "path" }],
        prefix: "replaces",
        noValue: "unstated",
      },
      Namespace: {
        role: "scopes",
        path: [{ keyword: "path" }],
        children: { in: "receiver" },
        noValue: "unstated",
        trailingSlash: "trimmed",
        prefixRequired: true,
      },
    },
  };
}

/**
 * What Flask and flask-restx run around a resource: the Flask app's
 * `before_request` hooks, and the error handlers the app, the API or the
 * resource's namespace registers.
 */
export function flaskRestxWrappers(
  modules: readonly string[],
): PyWrapperForm[] {
  const app = constructedFrom({ from: ["flask"], named: ["Flask"] });
  return [
    {
      type: "decoratedWrapper",
      attribute: "before_request",
      // A blueprint's own hook is skipped, because a route is decorated
      // on a namespace and the blueprint only mounts it.
      registrars: [{ made: app, covers: "everyRoute" }],
      // Flask sends whatever a before_request hook returns, and goes on
      // to the view only when it returns None.
      returnedValueResponds: true,
    },
    {
      type: "decoratedWrapper",
      attribute: "errorhandler",
      registrars: [
        { made: app, covers: "everyRoute" },
        {
          made: constructedFrom({ from: modules, named: ["Api"] }),
          covers: "everyRoute",
        },
        {
          made: constructedFrom({ from: modules, named: ["Namespace"] }),
          covers: "ownRoutes",
        },
      ],
      // `def handle(error)`.
      throwParam: 0,
    },
  ];
}

const PAGE_METHODS = ["GET", "HEAD"];

/** The decorators Flask adds a view serving one method with, and that method. */
const FLASK_SHORTCUTS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
};

/** The routes a Flask app or blueprint adds as Flask itself does, which the route table does not read. */
const FLASK_ROUTE_CALLS: Record<string, PyServingCall> = {
  route: {
    serves: "route",
    path: [{ at: 0 }, { keyword: "rule" }],
    methods: { pick: { keyword: "methods" }, unstated: ["GET"] },
  },
  // A view class lists its own methods, so one passed with none may serve any.
  add_url_rule: {
    serves: "route",
    path: [{ at: 0 }, { keyword: "rule" }],
    methods: { pick: { keyword: "methods" } },
  },
  ...Object.fromEntries(
    Object.entries(FLASK_SHORTCUTS).map(([name, method]) => [
      name,
      {
        serves: "route",
        path: [{ at: 0 }, { keyword: "rule" }],
        methods: [method],
      } satisfies PyServingCall,
    ]),
  ),
};

/** A resource flask-restx adds by a call rather than a decorator, which the route table does not read. */
const ADD_RESOURCE: Record<string, PyServingCall> = {
  add_resource: {
    serves: "route",
    path: [{ at: 1 }],
    methods: { pick: { keyword: "methods" } },
  },
};

/**
 * What a Flask app has that cannot serve a request: settings, the
 * logger, the CLI, and the context and test helpers.
 */
const FLASK_INERT = [
  "config",
  "logger",
  "cli",
  "extensions",
  "run",
  "test_client",
  "app_context",
  "test_request_context",
  "teardown_appcontext",
  "teardown_request",
  "context_processor",
  "shell_context_processor",
];

/**
 * What a blueprint has that cannot serve a request. Its own hooks run
 * only for a request one of its routes matched, so none of them serves
 * a path no route serves.
 */
const BLUEPRINT_INERT = ["after_request", "teardown_request"];

/** What an API or a namespace has that only describes a resource. */
const RESTX_INERT = [
  "model",
  "schema_model",
  "inherit",
  "parser",
  "doc",
  "expect",
  "marshal_with",
  "marshal_list_with",
  "response",
  "header",
  "param",
  "deprecated",
  "hide",
];

/**
 * Library calls handed an app that add no route and respond to no
 * request themselves: the database, migration, login, CORS and JWT
 * extensions, and Werkzeug's proxy header fix around the app's WSGI
 * callable.
 */
const FLASK_RUNNERS = [
  ...[
    { from: "flask_sqlalchemy", named: "SQLAlchemy" },
    { from: "flask_migrate", named: "Migrate" },
    { from: "flask_login", named: "LoginManager" },
    { from: "flask_cors", named: "CORS" },
    { from: "flask_jwt_extended", named: "JWTManager" },
  ].flatMap(({ from, named }) => {
    const made = constructedFrom({ from: [from], named: [named] });
    return [made, returnedBy("init_app", made)];
  }),
  constructedFrom({
    from: ["werkzeug.middleware.proxy_fix"],
    named: ["ProxyFix"],
  }),
];

/** Werkzeug's not-found error, which Flask hands to a handler registered for its status or for any class it descends from. */
const NOT_FOUND: PyNotFound = {
  status: 404,
  modules: ["werkzeug.exceptions", "werkzeug"],
  ancestors: ["Exception", "BaseException"],
};

/**
 * What a flask-restx app serves beside the resources the table reads.
 * Flask serves the app's static folder and whatever its own `route` and
 * the blueprints it registers serve, apart from the blueprint an `Api`
 * is built on. flask-restx serves its Swagger UI and `swagger.json`
 * under the prefix it gives the resources. A route added by a call on a
 * blueprint or a namespace, an error handler for the not-found error,
 * any other method such as the app's `after_request`, and any library
 * call the app is handed to but a few extensions may serve any path.
 */
export function flaskRestxServedBeside(
  modules: readonly string[],
): PyServedBeside {
  return {
    runners: FLASK_RUNNERS,
    servers: [
      {
        made: constructedFrom({ from: ["flask"], named: ["Flask"] }),
        paths: "asWritten",
        inert: FLASK_INERT,
        staticFolder: {
          folder: { keyword: "static_folder", default: "static" },
          urlPath: "static_url_path",
          positionalBefore: 1,
          methods: PAGE_METHODS,
        },
        calls: {
          ...FLASK_ROUTE_CALLS,
          register_blueprint: {
            serves: "mount",
            at: [{ keyword: "url_prefix" }],
            app: [{ at: 0 }, { keyword: "blueprint" }],
            ownPath: [{ keyword: "url_prefix" }],
            exceptCarriers: true,
          },
          register_error_handler: {
            serves: "errorHandler",
            handles: [{ at: 0 }, { keyword: "code_or_exception" }],
            notFound: NOT_FOUND,
          },
        },
      },
      {
        made: constructedFrom({ from: ["flask"], named: ["Blueprint"] }),
        paths: "underPrefix",
        servedWhereRegistered: true,
        staticFolder: {
          folder: { keyword: "static_folder", default: null },
          urlPath: "static_url_path",
          positionalBefore: 2,
          methods: PAGE_METHODS,
        },
        calls: {
          ...FLASK_ROUTE_CALLS,
          register_blueprint: {
            serves: "mount",
            at: [{ keyword: "url_prefix" }],
            app: [{ at: 0 }, { keyword: "blueprint" }],
            exceptCarriers: true,
          },
          app_errorhandler: {
            serves: "errorHandler",
            handles: [{ at: 0 }, { keyword: "code" }],
            notFound: NOT_FOUND,
          },
        },
        inert: BLUEPRINT_INERT,
      },
      {
        made: constructedFrom({ from: modules, named: ["Api"] }),
        paths: "underPrefix",
        builtIn: [
          { keyword: "doc", path: "/", methods: PAGE_METHODS, under: "routes" },
          { path: "/swagger.json", methods: PAGE_METHODS, under: "routes" },
        ],
        calls: ADD_RESOURCE,
        inert: RESTX_INERT,
      },
      {
        made: constructedFrom({ from: modules, named: ["Namespace"] }),
        paths: "underPrefix",
        calls: ADD_RESOURCE,
        inert: RESTX_INERT,
      },
    ],
  };
}

/** Why a route the table found has no path, said of the namespace or the API it is declared on. */
export const ROUTER_UNREAD: RouterUnreadWords = {
  unreached:
    "is never mounted through a single variable binding in the files read",
  shared: "shares its variable name with a second router construction",
  unlistedLoop:
    "is not mounted by name in the files read, and {loops} routers read out of a call this reading does not follow",
  rivalledMount:
    "is mounted inside a function, while {loops} routers this reading cannot name, and which of them the app runs is not written down",
  mountUnread: "is mounted with a prefix that is not a string literal",
  prefixUnread: "declares a prefix that is not a string literal",
  ontoPrefixUnread:
    "is mounted onto a router that declares a prefix that is not a string literal",
  chain: "is mounted through a chain of routers this reading cannot compose",
  prefixUnstated:
    "states no prefix where it is constructed, and its library derives one from elsewhere",
  prefixReplaced:
    "is mounted under a prefix that replaces the one it was constructed with, which this reading does not follow",
  root: {
    mountedOn: "is mounted on an object that {reason}",
    rootPrefixUnread: "states a prefix of its own that is not a string literal",
    carrierSeveral: "is built from more than one candidate",
    carrierUnfollowed: "is built from something this reading cannot follow",
    carrierShared:
      "is built from one whose variable name holds a second construction",
    carrierPrefixUnread:
      "is built from one whose prefix is not a string literal",
    carrierRepathed:
      "is built from one registered under a prefix stated where it is registered",
    carrierNested:
      "is built from one registered inside another, one hop past what this reading follows",
    carrierRegisteredTwice: "is built from one registered more than once",
  },
};

export function flaskRestxFramework(
  options: FlaskRestxPackOptions = {},
): PythonPack {
  const modules = ["flask_restx", ...(options.wrapperModules ?? [])];
  return {
    name: "flask-restx",
    version: VERSION,
    protocol: "http",
    servedBeside: flaskRestxServedBeside(modules),
    ...(options.wrapperModules !== undefined
      ? { projectModules: options.wrapperModules }
      : {}),
    discovery: [
      {
        type: "decoratedClassRoute",
        importModule: modules,
        routes: { table: flaskRestxRoutes(modules), unread: ROUTER_UNREAD },
        pathParamSyntax: "flaskConverters",
        defaultStatusCode: 200,
        // Flask reads a status out of `return body, 201`, so the 200
        // above applies only when the return writes no status.
        statusFromReturnedTuple: true,
        // flask-restx re-exports Flask's function, which re-exports
        // Werkzeug's, and a project may import it from any of the three.
        responseStatusCalls: [
          { callee: "flask_restx.abort", statusArgument: 0 },
          { callee: "flask.abort", statusArgument: 0 },
          { callee: "werkzeug.exceptions.abort", statusArgument: 0 },
        ],
        wrappers: flaskRestxWrappers(modules),
      },
    ],
    // A resource method reads the request off Flask's module-level object.
    requestObjects: [{ module: "flask", name: "request" }],
    // A path parameter is handed to the method, and the rest is read off
    // Flask's `request`: `request.args` for the query string.
    requestSpelling: {
      headers: { path: ["request", "headers"], saysWhichField: true },
      query: { path: ["request", "args"], saysWhichField: true },
      params: { path: ["pathParams"], saysWhichField: true },
      body: { path: ["request", "json"], saysWhichField: true },
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-flask-restx",
  dependencies: [{ ecosystem: "pypi", name: "flask-restx" }],
  reads: `flask-restx \`Resource\` routes (Python), including a project's own wrapper module that re-exports the route decorator. A route is served under its blueprint's \`url_prefix\`, its \`Api\`'s \`prefix\` and its namespace's \`path\`.`,
};

export default flaskRestxFramework;
