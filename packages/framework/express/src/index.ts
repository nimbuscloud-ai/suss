// @suss/framework-express: PatternPack for Express

import { z } from "zod";

import {
  httpRouteDiscovery,
  routeHelperIndex,
  wrapperDiscovery,
} from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";

const METHODS = [".get", ".post", ".put", ".delete", ".patch", ".all"];

// The response methods that return `res` itself, so a header set inside
// the chain leaves what it sends unchanged.
const HEADER_SETTERS = [
  "set",
  "header",
  "type",
  "contentType",
  "location",
  "cookie",
  "clearCookie",
  "append",
  "vary",
  "links",
  "attachment",
];

function responseChain(...methodChain: string[]) {
  return {
    type: "parameterMethodCall" as const,
    parameterPosition: 1,
    methodChain,
    passThroughMethods: HEADER_SETTERS,
  };
}

/** The express pack takes no configuration. */
export const optionsSchema = z.object({}).strict();

export type ExpressPackOptions = z.infer<typeof optionsSchema>;

export function expressFramework(
  _options: ExpressPackOptions = {},
): PatternPack {
  return {
    name: "express",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // Express exposes the routable via either `Router()` (named) or
    // `express()` (default). Both drive handler registration the same
    // way; `httpRouteDiscovery` emits one DiscoveryPattern per name.
    // Either can also be mounted onto another with `app.use(prefix,
    // router)`, so a route declared on the mounted router summarizes
    // with the mount's prefix composed in.
    discovery: [
      ...httpRouteDiscovery({
        importModule: "express",
        importNames: ["Router", "express"],
        methods: METHODS,
        mount: { method: "use", prefixPosition: 0, targetPosition: 1 },
      }),
      // `app.use(fn)` registers middleware, and the same call with a
      // four-argument function registers an error handler. Arity is the
      // only thing that tells the two apart.
      ...wrapperDiscovery({
        importModule: "express",
        importNames: ["Router", "express"],
        wraps: [
          { method: "use", targetPosition: 0, continuationParam: 2 },
          {
            method: "use",
            targetPosition: 0,
            continuationParam: 3,
            throwParam: 0,
            arity: 4,
          },
        ],
      }),
    ],

    // A route a project helper registers is read from the helper's own
    // body, before extraction, and expanded at each call site.
    projectHelpers: routeHelperIndex({
      importModule: "express",
      importNames: ["Router", "express"],
      methods: METHODS,
    }),

    terminals: [
      {
        // res.status(N).json(body)
        kind: "response",
        match: responseChain("status", "json"),
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.json(body): implicit 200
        kind: "response",
        match: responseChain("json"),
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // res.status(N).send(body)
        kind: "response",
        match: responseChain("status", "send"),
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.send(body): implicit 200
        kind: "response",
        match: responseChain("send"),
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // res.status(N).end(): a status with no body, 204 most often
        kind: "response",
        match: responseChain("status", "end"),
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.end(): implicit 200 with no body
        kind: "response",
        match: responseChain("end"),
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // res.sendStatus(N): sends status code with status text as body
        kind: "response",
        match: responseChain("sendStatus"),
        extraction: {
          statusCode: { from: "argument", position: 0 },
        },
      },
      {
        // res.redirect(url) or res.redirect(status, url)
        // Arg 0 is a status code only in the 2-arg form; minArgs prevents
        // extracting the URL string as a status code in the 1-arg form.
        kind: "response",
        match: responseChain("redirect"),
        extraction: {
          statusCode: { from: "argument", position: 0, minArgs: 2 },
          defaultStatusCode: 302,
        },
      },
      {
        // throw new SomeError(...); express error middleware sends the
        // error's status as the wire response.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {
          statusCode: { from: "property", name: "status" },
        },
        producesResponse: true,
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "request" },
        { position: 1, role: "response" },
        { position: 2, role: "next" },
      ],
    },
  };
}

export default expressFramework;
