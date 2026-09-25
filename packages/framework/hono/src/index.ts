/**
 * A Hono handler gets one context and returns its response from it:
 *
 *   app.get("/users/:id", async (c) => {
 *     const user = await findUser(c.req.param("id"));
 *     if (!user) return c.json({ error: "not found" }, 404);
 *     return c.json(user);
 *   });
 *
 * So the terminals read `c.json(body, status)` on parameter 0, where the
 * Express pack reads `res.status(n).json(body)` on parameter 1. The
 * status defaults to 200 when the handler leaves it off.
 */

import { z } from "zod";

import {
  httpRouteDiscovery,
  routeHelperIndex,
  wrapperDiscovery,
} from "@suss/extractor";

import type { DiscoveryPattern, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

/** `app.use(fn)` applies to every route, `app.use(path, fn)` to a path. */
const HONO_WRAPPERS: ReadonlyArray<NonNullable<DiscoveryPattern["wraps"]>> = [
  { method: "use", targetPosition: 0, continuationParam: 1 },
  {
    method: "use",
    scopePosition: 0,
    targetPosition: 1,
    continuationParam: 1,
  },
  { method: "onError", targetPosition: 0, throwParam: 0 },
];

/**
 * `new OpenAPIHono({ defaultHook })` calls the hook as `(result, c)` when
 * a request fails a route's request schema. The hook responds in place
 * of the handler, and the handler never runs.
 */
const ZOD_OPENAPI_WRAPPERS: ReadonlyArray<
  NonNullable<DiscoveryPattern["wraps"]>
> = [
  ...HONO_WRAPPERS,
  { constructorOption: "defaultHook", targetPosition: 0, resultParam: 0 },
];

/**
 * A literal status in the constructor's first argument wins, so
 * `new HTTPException(404)` is a 404. The 500 applies when the status is
 * not a literal.
 */
const HTTP_EXCEPTION_CODES: Record<string, number> = {
  HTTPException: 500,
};

const METHODS = [
  ".get",
  ".post",
  ".put",
  ".delete",
  ".patch",
  ".options",
  ".all",
];

/** The hono pack takes no options, so the CLI refuses any key. */
export const optionsSchema = z.object({}).strict();

export type HonoPackOptions = z.infer<typeof optionsSchema>;

export function honoFramework(_options: HonoPackOptions = {}): PatternPack {
  return {
    name: "hono",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // `createRoute` returns its config unchanged, so the call is the route
    // object. The pack has to declare this because the function's body is
    // in the library, where suss cannot read it.
    transparentWrappers: [
      { module: "@hono/zod-openapi", name: "createRoute", argument: 0 },
    ],

    // A route on a sub-app mounted with `app.route(prefix, sub)` gets the
    // prefix in front of its path, at any depth of nesting. The README
    // covers the mounts that leave a path as written.
    discovery: [
      ...httpRouteDiscovery({
        importModule: "hono",
        importNames: ["Hono", "OpenAPIHono"],
        methods: METHODS,
        mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
      }),
      ...httpRouteDiscovery({
        importModule: "@hono/zod-openapi",
        importNames: ["OpenAPIHono"],
        methods: METHODS,
        mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
      }),
      {
        // `app.openapi(route, handler)`, where the route is often a
        // `createRoute({ method, path })` object in another file. The
        // method and path come off that object.
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "@hono/zod-openapi",
          importName: "OpenAPIHono",
          registrationChain: [".openapi"],
        },
        bindingExtraction: {
          method: {
            type: "fromArgumentProperty",
            position: 0,
            property: "method",
          },
          path: { type: "fromArgumentProperty", position: 0, property: "path" },
        },
        requiresImport: ["@hono/zod-openapi"],
      },
      // `app.use(path, mw)` runs the middleware for the routes the
      // pattern covers, and `app.onError(fn)` produces the response for
      // a route whose path ended by throwing.
      ...wrapperDiscovery({
        importModule: "hono",
        importNames: ["Hono", "OpenAPIHono"],
        wraps: HONO_WRAPPERS,
      }),
      ...wrapperDiscovery({
        importModule: "@hono/zod-openapi",
        importNames: ["OpenAPIHono"],
        wraps: ZOD_OPENAPI_WRAPPERS,
      }),
    ],

    // A route a project helper registers is read from the helper's own
    // body, before extraction, and expanded at each call site.
    projectHelpers: routeHelperIndex({
      importModule: "hono",
      importNames: ["Hono", "OpenAPIHono"],
      methods: METHODS,
    }),

    // The `createRoute` object lists the endpoint's responses, so a
    // handler that returns a status missing from that list gets a
    // contract finding.
    contractReading: {
      discovery: {
        importModule: "@hono/zod-openapi",
        importName: "OpenAPIHono",
        registrationChain: [".openapi"],
      },
      responseExtraction: { property: "responses" },
      methodProperty: "method",
      pathProperty: "path",
      endpoint: { from: "registrationArgument", position: 0 },
    },

    terminals: [
      {
        // c.json(body, status?)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 0,
          methodChain: ["json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // c.text(body, status?)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 0,
          methodChain: ["text"],
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // c.body(data, status?)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 0,
          methodChain: ["body"],
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // c.redirect(location, status?). Hono defaults to 302.
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 0,
          methodChain: ["redirect"],
        },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          defaultStatusCode: 302,
        },
      },
      {
        // c.notFound()
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 0,
          methodChain: ["notFound"],
        },
        extraction: { defaultStatusCode: 404 },
      },
      {
        // throw new HTTPException(status, { message }): Hono sends the
        // exception's status as the response.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {
          statusCode: {
            from: "constructor",
            codes: HTTP_EXCEPTION_CODES,
          },
        },
        producesResponse: true,
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [{ position: 0, role: "context" }],
    },

    // In `c.req.header("x-tenant-id")` the field is an argument, and the
    // recorded read keeps only the method, so it loses which field it was.
    requestSpelling: {
      headers: { path: ["context", "req", "header"], saysWhichField: false },
      query: { path: ["context", "req", "query"], saysWhichField: false },
      params: { path: ["context", "req", "param"], saysWhichField: false },
      body: { path: ["context", "req", "json"], saysWhichField: false },
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-hono",
  dependencies: [{ ecosystem: "npm", name: "hono" }],
  reads:
    "Hono handlers, including the \`c.json(body, status)\` argument order.",
};

export default honoFramework;
