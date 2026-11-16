/**
 * FastAPI routes for the Python adapter. The app and the router are local
 * variables, so the routes are found by the call that built them
 * (`app = FastAPI()`, `router = APIRouter()`), from an import of
 * `fastapi`.
 *
 * The route table puts each router's prefix and each `include_router`
 * prefix in front of a route's path, through however many routers are
 * mounted on one another. The README lists the cases where a route keeps
 * its name and gets no path.
 */

import { z } from "zod";

import { STATUS_CONSTANTS } from "./statusConstants.js";

import type {
  ParameterSource,
  PythonPack,
  RouterUnreadWords,
} from "@suss/adapter-python";
import type { RouteTableDeclaration, ServesRole } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "1";

/**
 * The CLI checks a `-f fastapi=config.json` file against this schema. A
 * config file may not set a key that only a dependency stub fills.
 */
export const optionsSchema = z
  .object({
    /**
     * Modules that re-export FastAPI's constructors, on top of `fastapi`
     * itself. A dependency stub fills this in; a project's config file
     * may not set it.
     */
    wrapperModules: z.array(z.string()).optional(),
  })
  .strict();

export type FastapiPackOptions = z.infer<typeof optionsSchema>;

const VERB_ATTRIBUTE_NAMES: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

/** The decorators FastAPI registers a wrapper with on the app, which leave an app its function builds where it is. */
const WRAPPER_DECORATORS = ["middleware", "exception_handler"];

const SERVES = (method: string): ServesRole => ({
  role: "serves",
  methods: [method],
  path: [{ at: 0 }],
  handler: { decorated: true },
});

/**
 * FastAPI's app and routers as a route table. A route is a decorator
 * called on either, and `include_router` mounts a router onto the app or
 * onto another router. Starlette serves a route at the mount's prefix,
 * then the router's own, then the route's path, joined as written.
 */
export function fastapiRoutes(
  modules: readonly string[],
): RouteTableDeclaration {
  return {
    roots: {
      kinds: { FastAPI: 0 },
      children: { in: "receiver" },
      in: "file",
      unlessDropped: { owned: WRAPPER_DECORATORS },
    },
    from: modules,
    joins: "asWritten",
    loops: ["for"],
    throughWrappers: true,
    roles: {
      ...Object.fromEntries(
        Object.entries(VERB_ATTRIBUTE_NAMES).map(([name, method]) => [
          name,
          SERVES(method),
        ]),
      ),
      include_router: {
        role: "mount",
        table: [{ at: 0 }, { keyword: "router" }],
        at: [{ keyword: "prefix" }],
        prefix: "inFront",
      },
      APIRouter: {
        role: "scopes",
        path: [{ keyword: "prefix" }],
        children: { in: "receiver" },
        noValue: "unreadable",
        trailingSlash: "kept",
      },
    },
  };
}

/** Why a route the table found has no path, said of the router it is declared on. */
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
};

/**
 * The part of the request each of FastAPI's parameter functions reads.
 * A header parameter's `_` is a `-` on the wire, since FastAPI converts
 * the name unless the call gives one of its own.
 */
const PARAMETER_SOURCES: Record<string, ParameterSource> = {
  Header: { role: "headers", underscoresAs: "-" },
  Query: { role: "queryParams" },
  Path: { role: "pathParams" },
  Body: { role: "requestBody" },
  Form: { role: "requestBody" },
  Cookie: { role: "cookies" },
};

/**
 * Which part of the request each parameter role is read from. A cookie
 * has no section of its own, so a read of one is not compared.
 */
const REQUEST_SPELLING = {
  headers: { path: ["headers"], saysWhichField: true },
  query: { path: ["queryParams"], saysWhichField: true },
  params: { path: ["pathParams"], saysWhichField: true },
  body: { path: ["requestBody"], saysWhichField: true },
};

// The classes FastAPI supplies a parameter for when the parameter is
// annotated with one, under every module that exports them.
const INJECTED_PARAMETER_TYPES = [
  "fastapi.Request",
  "fastapi.Response",
  "fastapi.BackgroundTasks",
  "fastapi.WebSocket",
  "fastapi.requests.Request",
  "fastapi.requests.HTTPConnection",
  "fastapi.responses.Response",
  "fastapi.background.BackgroundTasks",
  "fastapi.websockets.WebSocket",
  "fastapi.security.SecurityScopes",
  "starlette.requests.Request",
  "starlette.requests.HTTPConnection",
  "starlette.responses.Response",
  "starlette.background.BackgroundTasks",
  "starlette.websockets.WebSocket",
];

export function fastapiFramework(options: FastapiPackOptions = {}): PythonPack {
  const modules = ["fastapi", ...(options.wrapperModules ?? [])];
  return {
    name: "fastapi",
    version: VERSION,
    protocol: "http",
    requestSpelling: REQUEST_SPELLING,
    ...(options.wrapperModules !== undefined
      ? { projectModules: options.wrapperModules }
      : {}),
    discovery: [
      {
        type: "decoratedFunctionRoute",
        importModule: modules,
        routes: { table: fastapiRoutes(modules), unread: ROUTER_UNREAD },
        pathParamSyntax: "braces",
        annotatedClassIsRequestBody: true,
        // FastAPI resolves both of these itself and calls the handler with
        // the result, so a parameter defaulted to one is never sent.
        injectedParameterCallees: ["Depends", "Security"],
        // FastAPI also hands a route these objects by the annotation alone.
        injectedParameterTypes: INJECTED_PARAMETER_TYPES,
        parameterSources: PARAMETER_SOURCES,
        parameterAliasKeyword: "alias",
        // FastAPI returns 200 for a route that declares no status.
        defaultStatusCode: 200,
        // FastAPI checks every declared request input before the handler
        // runs, and responds to a bad one itself.
        validationFailureStatus: 422,
        statusCodeConstants: STATUS_CONSTANTS,
        responseModelKeyword: "response_model",
        statusCodeKeyword: "status_code",
        responsesKeyword: "responses",
        // FastAPI re-exports Starlette's class, and a project may import
        // it from either module.
        responseStatusCalls: [
          {
            callee: "fastapi.HTTPException",
            statusKeyword: "status_code",
            statusArgument: 0,
          },
          {
            callee: "starlette.exceptions.HTTPException",
            statusKeyword: "status_code",
            statusArgument: 0,
          },
        ],
        // A route may respond by returning one of these built with a status.
        responseConstructors: [
          { callee: "fastapi.Response", statusKeyword: "status_code" },
          {
            callee: "starlette.responses.Response",
            statusKeyword: "status_code",
          },
          {
            callee: "fastapi.responses.JSONResponse",
            statusKeyword: "status_code",
          },
          {
            callee: "starlette.responses.JSONResponse",
            statusKeyword: "status_code",
          },
        ],
        wrappers: [
          {
            type: "dependency",
            callees: ["Depends", "Security"],
            keyword: "dependencies",
            registrars: [
              { constructorName: "FastAPI", covers: "everyRoute" },
              { constructorName: "APIRouter", covers: "ownRoutes" },
            ],
          },
          {
            type: "decoratedWrapper",
            attribute: "middleware",
            registrars: [{ constructorName: "FastAPI", covers: "everyRoute" }],
            // `async def m(request, call_next)`.
            continuationParam: 1,
          },
          {
            type: "decoratedWrapper",
            attribute: "exception_handler",
            registrars: [{ constructorName: "FastAPI", covers: "everyRoute" }],
            // `async def h(request, exc)`.
            throwParam: 1,
          },
        ],
      },
    ],
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-fastapi",
  dependencies: [{ ecosystem: "pypi", name: "fastapi" }],
  reads: `FastAPI routes (Python). The verb comes from the decorator's attribute name, \`APIRouter\` prefixes are composed through every \`include_router\` mount on the way from the app, and \`response_model\` and \`status_code\` are taken as the declared contract.`,
};

export default fastapiFramework;
