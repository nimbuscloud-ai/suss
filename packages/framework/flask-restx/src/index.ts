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
        // A resource declared on a namespace is served under the
        // namespace's own path, and the route's decorator states only
        // the part after it: `Namespace(path="/orders")` plus
        // `@ns.route("/<int:order_id>")` is served at
        // `/orders/<int:order_id>`. `add_namespace` is where the app
        // mounts it, and a `path` there replaces the namespace's own
        // rather than going in front of it, so the adapter abstains on
        // one instead of composing it. A namespace constructed without
        // `path` is served under a path flask-restx derives from its
        // name, which nothing reads here, so it abstains too. The
        // namespace strips trailing slashes off its own path before
        // the route's path joins it, so `path="/orders/"` serves what
        // `path="/orders"` serves, and `path="/"` adds nothing.
        // Both sites ask whether the path is truthy, so `path=""`,
        // `path=None`, `path=False` and `path=0` all say exactly what
        // writing no `path` says.
        routerComposition: {
          routerConstructorName: "Namespace",
          includeMethodName: "add_namespace",
          prefixKeyword: "path",
          mountPrefixEffect: "replaces",
          constructorPrefixRequired: true,
          constructorPrefixTrailingSlash: "trimmed",
          noValuePrefix: "unstated",
        },
        // A resource method that returns a value and marks no status
        // answers 200, which is Flask's own behavior behind
        // flask-restx, so a method whose return annotation states a
        // shape states a status too.
        defaultStatusCode: 200,
      },
    ],
  };
}

export default flaskRestxFramework;
