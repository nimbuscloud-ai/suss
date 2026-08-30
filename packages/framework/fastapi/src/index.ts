// @suss/framework-fastapi: PatternPack for FastAPI routes.
//
// FastAPI declares a route by decorating a function with a verb-named
// method on the app or on a router (`@app.get(path)`,
// `@router.post(path)`), where the decorator's own attribute name is
// the HTTP verb. The app and router objects are local variables rather
// than imports, so the adapter recognizes them by how they are built:
// a call to something imported from FastAPI's module, one assignment
// back (`app = FastAPI()`, `router = APIRouter()`).
//
// A route on a router is served under up to two prefixes its own file
// never writes: the router constructor's (`APIRouter(prefix="/items")`)
// and the one at the mount call (`app.include_router(router,
// prefix="/api")`). `routerComposition` gives FastAPI's spelling of
// that mounting, so the adapter can compose both literal prefixes into
// the route path, one mount hop deep. Anything past that reading, such
// as a computed prefix, a router mounted through more than a single
// variable binding, or a router mounted onto another router, keeps the
// route discovered by name with no path, and the summary says why.
//
// This slice covers discovery, prefix composition, and declared-shape
// reading (`response_model`, `status_code`, parameter and return
// annotations). It does not read dependencies, middleware, or mounted
// sub-apps.

import { z } from "zod";

import type { PythonPack } from "@suss/adapter-python";

/**
 * What `-f fastapi=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * Modules a project's own wrapper re-exports FastAPI's constructors
     * from. FastAPI's own module is always accepted. The wrapper's name
     * is the project's own choice, so it is supplied by whoever
     * configures the pack rather than hardcoded here.
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
        routerComposition: {
          routerConstructorName: "APIRouter",
          includeMethodName: "include_router",
          routerKeyword: "router",
          prefixKeyword: "prefix",
        },
      },
    ],
  };
}

export default fastapiFramework;
