import { z } from "zod";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/**
 * The response helpers moved between packages as Remix became React
 * Router, and projects on every version write the same call. Prefix
 * matching covers sub-paths such as `@remix-run/node/dist/...`, so only
 * the package roots are listed.
 */
const RESPONSE_MODULES = [
  "react-router",
  "react-router-dom",
  "@remix-run/node",
  "@remix-run/cloudflare",
  "@remix-run/deno",
  "@remix-run/server-runtime",
];

/**
 * Status codes for the `http-errors` constructors. A loader that throws
 * through a project helper passes one of these, and the status comes
 * from the argument's class name.
 */
const HTTP_ERRORS_CODES: Record<string, number> = {
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  Forbidden: 403,
  NotFound: 404,
  MethodNotAllowed: 405,
  NotAcceptable: 406,
  RequestTimeout: 408,
  Conflict: 409,
  Gone: 410,
  PayloadTooLarge: 413,
  UnsupportedMediaType: 415,
  ImATeapot: 418,
  UnprocessableEntity: 422,
  TooManyRequests: 429,
  InternalServerError: 500,
  NotImplemented: 501,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
};

/**
 * A project on v6 imports the route element and the router factories
 * from `react-router-dom`, and a project on v7 imports them from
 * `react-router`. The declarations are the same in both.
 */
const ROUTER_MODULES = ["react-router", "react-router-dom"];

/**
 * Routes the app declares in its own code, as nested `Route` elements or
 * as the same keys in objects passed to `createBrowserRouter`. The README
 * describes how nested and index routes build their paths.
 *
 * A navigation is a GET, so the route pairs with a client's GET to the
 * same path.
 */
const JSX_ROUTES: Extract<
  DiscoveryPattern["match"],
  { type: "jsxElementRoute" }
> = {
  type: "jsxElementRoute",
  importModule: ROUTER_MODULES,
  routeElement: "Route",
  pathAttribute: "path",
  elementAttribute: "element",
  indexAttribute: "index",
  childrenAttribute: "children",
  routeObjectFactories: ["createBrowserRouter"],
  elementsFactories: ["createRoutesFromElements"],
  method: "GET",
};

/**
 * The CLI checks a `-f react-router=config.json` file against this schema
 * before it calls the factory.
 */
export const optionsSchema = z
  .object({
    /**
     * Helpers this project throws HTTP errors through, as in
     * `throw myHelper(new HttpError.NotFound(), body)`. React Router has
     * no such helper, so the list is empty by default, and the pack never
     * matches a call on a name another codebase happened to use. The
     * status comes from the class name of the thrown argument, looked up
     * in the `http-errors` constructors.
     */
    errorHelpers: z.array(z.string()).optional(),
  })
  .strict();

export type ReactRouterPackOptions = z.infer<typeof optionsSchema>;

export function reactRouterFramework(
  options: ReactRouterPackOptions = {},
): PatternPack {
  return {
    name: "react-router",
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        kind: "loader",
        // The README explains why no route comes from the file name.
        match: { type: "namedExport", names: ["loader"] },
        // Route files often re-export `loader` and `action` from modules
        // that never import the router. The match reads only named
        // exports, so running it on every file costs little.
        requiresImport: [],
      },
      {
        kind: "action",
        match: { type: "namedExport", names: ["action"] },
        requiresImport: [],
      },
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
        requiresImport: [],
      },
      {
        // Most React Router apps declare their routes in JSX. Every name
        // this pattern matches comes from the router, so it needs the
        // router import.
        kind: "component",
        match: JSX_ROUTES,
        requiresImport: ROUTER_MODULES,
      },
    ],

    terminals: [
      {
        // json(data, init?), for example `return json({ user })`
        kind: "response",
        match: {
          type: "functionCall",
          functionName: "json",
          // A project helper with the same name may order its arguments
          // differently, so only the router's own helpers match.
          requiresImport: RESPONSE_MODULES,
        },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // data(value, init?), React Router v7's replacement for json()
        kind: "response",
        match: {
          type: "functionCall",
          functionName: "data",
          requiresImport: RESPONSE_MODULES,
        },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // redirect(url, status?), for example `return redirect("/login")`
        kind: "response",
        match: {
          type: "functionCall",
          functionName: "redirect",
          requiresImport: RESPONSE_MODULES,
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          defaultStatusCode: 302,
        },
      },
      {
        // The route gives the URL and the returned JSX gives what that
        // URL renders, so a routed component records both.
        kind: "render",
        match: { type: "jsxReturn" },
        extraction: {},
      },
      {
        // A loader can return plain data without a helper.
        kind: "return",
        match: { type: "returnShape" },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
      // The status is in the class name of the helper's argument, so it is
      // read through `argumentConstructor`.
      ...(options.errorHelpers ?? []).map((helper) => ({
        kind: "throw" as const,
        match: {
          type: "throwExpression" as const,
          constructorPattern: helper,
        },
        extraction: {
          statusCode: {
            from: "argumentConstructor" as const,
            position: 0,
            codes: HTTP_ERRORS_CODES,
          },
          body: { from: "argument" as const, position: 1 },
        },
        // The router turns the thrown error's status into the wire response.
        producesResponse: true,
      })),
    ],

    inputMapping: {
      type: "objectParam",
      knownProperties: {
        request: "request",
        params: "pathParams",
        context: "context",
      },
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-react-router",
  dependencies: [
    { ecosystem: "npm", name: "react-router" },
    { ecosystem: "npm", name: "react-router-dom" },
  ],
  reads: "React Router loaders, actions and routes.",
};

export default reactRouterFramework;
