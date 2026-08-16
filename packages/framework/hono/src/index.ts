// @suss/framework-hono: PatternPack for Hono
//
// A Hono handler takes one context and returns its response, rather than
// writing to a response object it was handed:
//
//   app.get("/users/:id", async (c) => {
//     const user = await findUser(c.req.param("id"));
//     if (!user) return c.json({ error: "not found" }, 404);
//     return c.json(user);
//   });
//
// So the terminals below read `c.json(body, status)` at parameter 0,
// where Express reads `res.status(n).json(body)` at parameter 1. The
// status is the second argument, and it defaults to 200 when the handler
// leaves it off.

import { httpRouteDiscovery } from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";

/**
 * Status codes for Hono's `HTTPException`, thrown rather than returned.
 * The constructor takes the status as its first argument, so the codes
 * map is only consulted for the named subclasses some projects define.
 */
const HTTP_EXCEPTION_CODES: Record<string, number> = {
  HTTPException: 500,
};

export function honoFramework(): PatternPack {
  return {
    name: "hono",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // createRoute wraps its config without changing it; the call IS the
    // route object. Declared here because the wrapper's body lives in
    // the library, where nobody can read it.
    transparentWrappers: [
      { callee: "createRoute", argument: 0, module: "@hono/zod-openapi" },
    ],

    // `new Hono()` and `new OpenAPIHono()` both register the same way.
    // Sub-apps mounted with `app.route(prefix, sub)` compose the
    // prefix into a route declared on the sub-app, following the sub-app
    // through an import when it's declared in another file. A mount
    // nested more than one level deep composes too, since the same
    // index a mount resolves to is asked again for its own mount; a
    // mount the resolution store can't follow to a concrete sub-app,
    // or whose prefix isn't a string literal, leaves the route's path
    // as written.
    discovery: [
      ...httpRouteDiscovery({
        importModule: "hono",
        importNames: ["Hono", "OpenAPIHono"],
        methods: [
          ".get",
          ".post",
          ".put",
          ".delete",
          ".patch",
          ".options",
          ".all",
        ],
        mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
      }),
      ...httpRouteDiscovery({
        importModule: "@hono/zod-openapi",
        importNames: ["OpenAPIHono"],
        methods: [
          ".get",
          ".post",
          ".put",
          ".delete",
          ".patch",
          ".options",
          ".all",
        ],
        mount: { method: "route", prefixPosition: 0, targetPosition: 1 },
      }),
      {
        // app.openapi(route, handler), where the route is a
        // createRoute({ method, path, ... }) object that usually lives
        // on a shared contract in another file. The fact layer follows
        // the reference, and the route object has its own method and path on
        // it.
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
    ],

    // The createRoute object registered alongside the handler declares
    // the endpoint's responses, so a handler returning a status the
    // route never declares is a contract finding, not a style choice.
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
        // throw new HTTPException(status, { message }); hono sends the
        // exception's status as the wire response.
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

    // One parameter, the context, carrying the request and the response
    // methods together.
    inputMapping: {
      type: "positionalParams",
      params: [{ position: 0, role: "context" }],
    },
  };
}

export default honoFramework;
