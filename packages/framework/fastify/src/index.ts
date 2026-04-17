// @suss/framework-fastify — PatternPack for Fastify

import type { PatternPack } from "@suss/extractor";

const HTTP_METHODS = [
  ".get",
  ".post",
  ".put",
  ".delete",
  ".patch",
  ".head",
  ".options",
];

export function fastifyFramework(): PatternPack {
  return {
    name: "fastify",
    languages: ["typescript", "javascript"],

    discovery: [
      {
        // import Fastify from "fastify"; const app = Fastify();
        // app.get("/path", handler)
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "fastify",
          importName: "Fastify",
          registrationChain: HTTP_METHODS,
        },
        bindingExtraction: {
          method: { type: "fromRegistration", position: "methodName" },
          path: { type: "fromRegistration", position: 0 },
        },
      },
      {
        // import { fastify } from "fastify"; const app = fastify();
        // app.get("/path", handler)
        kind: "handler",
        match: {
          type: "registrationCall",
          importModule: "fastify",
          importName: "fastify",
          registrationChain: HTTP_METHODS,
        },
        bindingExtraction: {
          method: { type: "fromRegistration", position: "methodName" },
          path: { type: "fromRegistration", position: 0 },
        },
      },
    ],

    terminals: [
      {
        // reply.code(N).send(body)
        kind: "response",
        match: {
          type: "parameterMethodCall",
          parameterPosition: 1,
          methodChain: ["code", "send"],
        },
        extraction: {
          statusCode: { from: "argument", position: 0 },
          body: { from: "argument", position: 0 },
        },
      },
      {
        // reply.status(N).send(body) — `.status` is the Express-style alias
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
        // reply.send(body) — implicit 200
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
        // reply.redirect(url) or reply.redirect(N, url)
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
        // throw new Error(...) / throw httpErrors.notFound() / etc.
        // Status code is left for the consumer to infer from exception type;
        // Fastify error libraries vary too widely to map here.
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "request" },
        { position: 1, role: "reply" },
      ],
    },
  };
}

export default fastifyFramework;
