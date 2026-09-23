/**
 * flask-restx `Resource` routes for the Python adapter. A route is a
 * class decorated with `Namespace.route(path)` or `Api.route(path)`, and
 * each of its methods named after a verb (`get`, `post`, ...) serves
 * that verb.
 *
 * The pack does not read response marshaling (`@ns.marshal_with`,
 * `@ns.expect`).
 */

import { z } from "zod";

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

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
    ...(options.wrapperModules !== undefined
      ? { projectModules: options.wrapperModules }
      : {}),
    discovery: [
      {
        type: "decoratedClassRoute",
        importModule: ["flask_restx", ...(options.wrapperModules ?? [])],
        decoratorName: "route",
        verbMethodNames: VERB_METHOD_NAMES,
        pathParamSyntax: "flaskConverters",
        // The Python adapter's README has a table of what each of these
        // settings does to a written prefix.
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
        wrappers: [
          {
            type: "decoratedWrapper",
            attribute: "before_request",
            // A blueprint's own hook is skipped, because a route is decorated
            // on a namespace and the blueprint only mounts it.
            registrars: [
              {
                constructorName: "Flask",
                importModule: ["flask"],
                covers: "everyRoute",
              },
            ],
            // Flask sends whatever a before_request hook returns, and
            // goes on to the view only when it returns None.
            returnedValueResponds: true,
          },
          {
            type: "decoratedWrapper",
            attribute: "errorhandler",
            registrars: [
              {
                constructorName: "Flask",
                importModule: ["flask"],
                covers: "everyRoute",
              },
              { constructorName: "Api", covers: "everyRoute" },
              { constructorName: "Namespace", covers: "ownRoutes" },
            ],
            // `def handle(error)`.
            throwParam: 0,
          },
        ],
      },
    ],
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-flask-restx",
  dependencies: [{ ecosystem: "pypi", name: "flask-restx" }],
  reads: `flask-restx \`Resource\` routes (Python), including a project's own wrapper module that re-exports the route decorator.`,
};

export default flaskRestxFramework;
