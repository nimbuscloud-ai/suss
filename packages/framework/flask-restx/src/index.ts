// @suss/framework-flask-restx: PatternPack for flask-restx `Resource`
// routes, including a project's own wrapper module re-exporting the
// route decorator.
//
// flask-restx declares a route by decorating a `Resource` subclass
// with `Namespace.route(path)` (or `Api.route(path)`); the HTTP verb
// comes from which of the class's own methods is defined (`get`,
// `post`, `put`, `delete`, `patch`, `head`, `options`), not from a
// per-method decorator. The measured corpus this pack is built against
// (see docs/internal/proposals/language-adapters.md) puts almost every
// service's routes behind one internal wrapper module rather than a
// direct `flask_restx` import, so `wrapperModules` is the project-
// supplied half of `importModule`: the library's own module is always
// accepted, and a project names its wrapper alongside it, mirroring
// how the TypeScript decorator packs accept a project's own re-export
// of a framework decorator.
//
// v0 scope: discovery and declared-shape reading only (parameter
// annotations, a return annotation), no terminal / body reading, per
// the language-adapters proposal's slice 2. Response marshaling
// (`@ns.marshal_with`, `@ns.expect`) is slice 3.

import type { PythonPack } from "@suss/adapter-python";

export interface FlaskRestxPackOptions {
  /**
   * Modules a project's own wrapper re-exports flask-restx's route
   * decorator from. flask-restx's own module is always accepted; this
   * adds the wrapper a project built around it. Supplied by whoever
   * configures the pack for their project, not hardcoded here (see
   * docs/internal/style.md on pack vocabulary): the name is the
   * project's own choice, not something flask-restx defines.
   */
  wrapperModules?: string[];
}

const VERB_METHOD_NAMES: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  delete: "DELETE",
  patch: "PATCH",
  head: "HEAD",
  options: "OPTIONS",
};

export function flaskRestxFramework(
  options: FlaskRestxPackOptions = {},
): PythonPack {
  return {
    name: "flask-restx",
    protocol: "http",
    discovery: [
      {
        type: "decoratedClassRoute",
        importModule: ["flask_restx", ...(options.wrapperModules ?? [])],
        decoratorName: "route",
        verbMethodNames: VERB_METHOD_NAMES,
        // flask-restx paths spell a template parameter in Flask's
        // converter syntax (`/orders/<int:order_id>`, `/users/<name>`),
        // the library's own routing, named here for the adapter's
        // reader; there is no annotated-class body convention to
        // declare.
        pathParamSyntax: "flaskConverters",
      },
    ],
  };
}

export default flaskRestxFramework;
