// @suss/framework-hono — PatternPack for Hono
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

    // `new Hono()` and `new OpenAPIHono()` both register the same way.
    // Sub-apps mounted with `app.route(path, sub)` keep the path they
    // were declared with, which is a gap worth naming: a route declared
    // on a sub-app is reported without its mount prefix.
    discovery: httpRouteDiscovery({
      importModule: "hono",
      importNames: ["Hono", "OpenAPIHono"],
      methods: [".get", ".post", ".put", ".delete", ".patch", ".options"],
    }),

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
        // throw new HTTPException(status, { message })
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {
          statusCode: {
            from: "constructor",
            codes: HTTP_EXCEPTION_CODES,
          },
        },
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
