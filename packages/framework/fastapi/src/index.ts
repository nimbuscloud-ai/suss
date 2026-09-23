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

import type { PythonPack } from "@suss/adapter-python";
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

export function fastapiFramework(options: FastapiPackOptions = {}): PythonPack {
  return {
    name: "fastapi",
    protocol: "http",
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
        // FastAPI returns 200 for a route that declares no status.
        defaultStatusCode: 200,
        responseModelKeyword: "response_model",
        statusCodeKeyword: "status_code",
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
