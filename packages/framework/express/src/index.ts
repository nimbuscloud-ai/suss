// @suss/framework-express — PatternPack for Express

import { httpRouteDiscovery } from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";

export function expressFramework(): PatternPack {
  return {
    name: "express",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // Express exposes the routable via either `Router()` (named) or
    // `express()` (default). Both drive handler registration the same
    // way; `httpRouteDiscovery` emits one DiscoveryPattern per name.
    discovery: httpRouteDiscovery({
      importModule: "express",
      importNames: ["Router", "express"],
      methods: [".get", ".post", ".put", ".delete", ".patch"],
    }),

    terminals: [
      {
        // res.status(N).json(body)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "json"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.json(body) — implicit 200
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["json"],
        },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // res.status(N).send(body)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["status", "send"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // res.send(body) — implicit 200
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["send"],
        },
        extraction: {
          body: { from: "argument", position: 0 },
          defaultStatusCode: 200,
        },
      },
      {
        // res.sendStatus(N) — sends status code with status text as body
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["sendStatus"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
        },
      },
      {
        // res.redirect(url) or res.redirect(status, url)
        // Arg 0 is a status code only in the 2-arg form; minArgs prevents
        // extracting the URL string as a status code in the 1-arg form.
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["redirect"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0, minArgs: 2 },
          defaultStatusCode: 302,
        },
      },
      {
        // throw new SomeError(...)
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {
          statusCode: { from: "property", name: "status" },
        },
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
