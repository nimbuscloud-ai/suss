// @suss/framework-react-router: the PatternPack for React Router.

import { z } from "zod";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";

/**
 * Modules that export `json`, `data`, and `redirect`. The response
 * helpers moved between packages as Remix became React Router, and a
 * project on any of these versions writes the same call, so all of them
 * count.
 *
 * Prefix matching covers the sub-paths (`@remix-run/node/dist/...`), so
 * only the package roots are listed.
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
 * Status codes for the `http-errors` package's named constructors. A
 * loader that throws through a project wrapper passes one of these, and
 * the argument's class name is where the status comes from. Kept as a
 * module-scope
 * constant so pack consumers can inspect / extend the mapping.
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
 * Modules the route element and the router factories come from. A
 * project on v6 imports them from `react-router-dom` and one on v7
 * from `react-router`, and both write the same declarations.
 */
const ROUTER_MODULES = ["react-router", "react-router-dom"];

/**
 * How React Router declares routes in the app itself, rather than in
 * the file layout: a `Route` element carrying a path and the element
 * it renders, nested inside other routes whose paths it joins, with an
 * index route serving its parent's path. `createBrowserRouter` takes
 * the same keys as an array of objects, nesting through `children`
 * where the JSX form nests elements, and `createRoutesFromElements`
 * turns the JSX form into that array.
 *
 * A navigation is a GET, which is what a client calling the same path
 * pairs against.
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
 * What `-f react-router=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * Helpers this project throws HTTP errors through, as
     * `throw myHelper(new HttpError.NotFound(), body)`. React Router
     * declares no such helper, so nothing is assumed by default and a
     * project that installs this pack never matches a call on a name some
     * other codebase happened to use. The thrown argument's class name
     * gives the status, read against the `http-errors` constructors.
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
        match: { type: "namedExport", names: ["loader"] },
        // No route derived from the filename. React Router only
        // reads routes that way when the project opted in by
        // importing @react-router/fs-routes, and the pack language
        // has no way to say "only when that import is there". A
        // loader whose route came out of a guess pairs with whatever
        // consumer matches the guess, which is worse than pairing
        // with nothing.
        // Empty gate: route files often re-export `loader` /
        // `action` from non-router-importing modules
        // (server-side data functions, shared util re-exports).
        // A heuristic gate would miss those. The dispatch only
        // looks at named exports, so paying for the walk on
        // every file is fine.
        requiresImport: [],
      },
      {
        kind: "action",
        match: { type: "namedExport", names: ["action"] },
        // No route derived from the filename. React Router only
        // reads routes that way when the project opted in by
        // importing @react-router/fs-routes, and the pack language
        // has no way to say "only when that import is there". A
        // loader whose route came out of a guess pairs with whatever
        // consumer matches the guess, which is worse than pairing
        // with nothing.
        requiresImport: [],
      },
      {
        kind: "component",
        match: { type: "namedExport", names: ["default"] },
        requiresImport: [],
      },
      {
        // The route tree the app declares in its own JSX, which is how
        // most React Router apps say what serves which URL. Gated on
        // the router import, since the whole pattern is written with
        // names that come out of it.
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
          // These names come from the router, so a same-named helper
          // the project wrote is a different function, with its own
          // argument order, and must not match.
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
          // These names come from the router, so a same-named helper
          // the project wrote is a different function, with its own
          // argument order, and must not match.
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
          // These names come from the router, so a same-named helper
          // the project wrote is a different function, with its own
          // argument order, and must not match.
          requiresImport: RESPONSE_MODULES,
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          defaultStatusCode: 302,
        },
      },
      {
        // What a routed component renders. The route says which
        // URL reaches this component, and the JSX it returns is what
        // that URL renders, so the pack reads both rather than
        // reporting the route and nothing behind it.
        kind: "render",
        match: { type: "jsxReturn" },
        extraction: {},
      },
      {
        // Loaders return data directly
        kind: "return",
        match: { type: "returnShape" },
        extraction: {
          body: { from: "argument", position: 0 },
        },
      },
      // A project's error helper puts the status in the class name of its
      // argument, so resolve through `argumentConstructor` rather
      // than taking the argument's raw source text as a status value.
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

export default reactRouterFramework;
