// @suss/framework-fastapi: PatternPack for FastAPI routes.
//
// FastAPI declares a route by decorating a function with a verb-named
// method on the app or on a router (`@app.get(path)`,
// `@router.post(path)`), where the decorator's own attribute name is
// the HTTP verb. The app and router objects are local variables, not
// imports, so the adapter recognizes them by construction: a call to
// something imported from FastAPI's module, one assignment back
// (`app = FastAPI()`, `router = APIRouter()`).
//
// A route on a router is served under up to two prefixes the route
// file never states: the router constructor's own
// (`APIRouter(prefix="/items")`) and the one at the mount call
// (`app.include_router(router, prefix="/api")`). `routerComposition`
// names FastAPI's spelling of that mounting so the adapter can
// compose both literal prefixes into the route path, one mount hop
// deep. Anything past that reading (a computed prefix, a router
// mounted through more than a single variable binding, a router
// mounted onto another router) keeps the route discovered by name
// with no path, and the summary says why.
//
// v0 scope, per the language-adapters proposal's slice 3: discovery,
// prefix composition, and declared-shape reading (`response_model`,
// `status_code`, parameter and return annotations). Dependencies,
// middleware, and mounted sub-apps are not read.

import type { PythonPack } from "@suss/adapter-python";

export interface FastapiPackOptions {
  /**
   * Modules a project's own wrapper re-exports FastAPI's constructors
   * from (`from myapp.compat import APIRouter`). FastAPI's own module
   * is always accepted; this adds the wrapper a project built around
   * it. Supplied by whoever configures the pack for their project,
   * not hardcoded here (see docs/internal/style.md on pack
   * vocabulary): the name is the project's own choice, not something
   * FastAPI defines.
   */
  wrapperModules?: string[];
}

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
    discovery: [
      {
        type: "decoratedFunctionRoute",
        importModule: ["fastapi", ...(options.wrapperModules ?? [])],
        verbAttributeNames: VERB_ATTRIBUTE_NAMES,
        responseModelKeyword: "response_model",
        statusCodeKeyword: "status_code",
        routerComposition: {
          routerConstructorName: "APIRouter",
          includeMethodName: "include_router",
          prefixKeyword: "prefix",
        },
      },
    ],
  };
}

export default fastapiFramework;
