// @suss/framework-flask-restx: PatternPack for flask-restx `Resource`
// routes, including a project's own wrapper module that re-exports the
// route decorator.
//
// flask-restx declares a route by decorating a `Resource` subclass with
// `Namespace.route(path)` or `Api.route(path)`. The HTTP verb comes
// from which of the class's own methods is defined (`get`, `post`,
// `put`, `delete`, `patch`, `head`, `options`) rather than from a
// per-method decorator.
//
// Production services usually put their routes behind one internal
// wrapper module instead of importing `flask_restx` directly, so
// `wrapperModules` is the project-supplied half of `importModule`. The
// library's own module is always accepted, and a project adds its
// wrapper alongside it. The TypeScript decorator packs accept a
// project's own re-export of a framework decorator the same way.
//
// This slice covers discovery, prefix composition, and declared-shape
// reading from parameter and return annotations. It does not read
// terminals or bodies, and it does not read response marshaling
// (`@ns.marshal_with`, `@ns.expect`).

import type { PythonPack } from "@suss/adapter-python";

export interface FlaskRestxPackOptions {
  /**
   * Modules a project's own wrapper re-exports flask-restx's route
   * decorator from. flask-restx's own module is always accepted. The
   * wrapper's name is the project's own choice, so it is supplied by
   * whoever configures the pack rather than hardcoded here.
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
        pathParamSyntax: "flaskConverters",
        // What each of these settings means for a written prefix is the
        // grid in the Python adapter's README.
        pathRepeatedSlashes: "merged",
        routerComposition: {
          routerConstructorName: "Namespace",
          includeMethodName: "add_namespace",
          prefixKeyword: "path",
          mountPrefixEffect: "replaces",
          constructorPrefixRequired: true,
          constructorPrefixTrailingSlash: "trimmed",
          noValuePrefix: "unstated",
          mountObjectPrefix: {
            prefixKeyword: "prefix",
            carrier: {
              importModule: ["flask"],
              constructorName: "Blueprint",
              argumentIndex: 0,
              prefixKeyword: "url_prefix",
              handoffMethodName: "init_app",
              registerMethodName: "register_blueprint",
            },
          },
        },
        // Flask returns 200 from a resource method that returns a value
        // and sets no status of its own.
        defaultStatusCode: 200,
      },
    ],
  };
}

export default flaskRestxFramework;
