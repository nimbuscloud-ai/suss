/**
 * FastAPI routes for the Python adapter. The app and the router are local
 * variables, so the adapter finds them by the call that built them
 * (`app = FastAPI()`, `router = APIRouter()`), one assignment back from an
 * import of `fastapi`.
 *
 * `routerComposition` lets the adapter put the router's prefix and the
 * `include_router` prefix in front of a route's path, one mount deep. The
 * README lists the cases where a route keeps its name and gets no path.
 */

import { z } from "zod";

import { STATUS_CONSTANTS } from "./statusConstants.js";

import type { ParameterSource, PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

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
  return {
    name: "fastapi",
    protocol: "http",
    requestSpelling: REQUEST_SPELLING,
    ...(options.wrapperModules !== undefined
      ? { projectModules: options.wrapperModules }
      : {}),
    discovery: [
      {
        type: "decoratedFunctionRoute",
        importModule: ["fastapi", ...(options.wrapperModules ?? [])],
        verbAttributeNames: VERB_ATTRIBUTE_NAMES,
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
        routerComposition: {
          routerConstructorName: "APIRouter",
          includeMethodName: "include_router",
          routerKeyword: "router",
          prefixKeyword: "prefix",
        },
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
  reads: `FastAPI routes (Python). The verb comes from the decorator's attribute name, \`APIRouter\` prefixes are composed one \`include_router\` hop deep, and \`response_model\` and \`status_code\` are taken as the declared contract.`,
};

export default fastapiFramework;
