// @suss/framework-fastify: PatternPack for Fastify

import { z } from "zod";

import { httpRouteDiscovery, routeHelperIndex } from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

const METHODS = [
  ".get",
  ".post",
  ".put",
  ".delete",
  ".patch",
  ".head",
  ".options",
  ".all",
];

/** The fastify pack takes no configuration. */
export const optionsSchema = z.object({}).strict();

export type FastifyPackOptions = z.infer<typeof optionsSchema>;

export function fastifyFramework(
  _options: FastifyPackOptions = {},
): PatternPack {
  return {
    name: "fastify",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // Fastify exposes the routable via either default `Fastify` or
    // named `fastify()`. Both drive handler registration the same way.
    discovery: [
      ...httpRouteDiscovery({
        importModule: "fastify",
        importNames: ["Fastify", "fastify"],
        methods: METHODS,
      }),
    ],

    // A route a project helper registers is read from the helper's own
    // body, before extraction, and expanded at each call site.
    projectHelpers: routeHelperIndex({
      importModule: "fastify",
      importNames: ["Fastify", "fastify"],
      methods: METHODS,
    }),

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
        // reply.status(N).send(body), `.status` is the Express-style alias
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
        // reply.send(body): implicit 200
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
      {
        // `return user`, `return { id, name }`, `return await db.find(id)`,
        // Fastify serialises the returned value as a 200 response body.
        // `excludeCallReturns: true` keeps `return reply.send(...)` out
        // of this branch: that call already lands as a parameterMethodCall
        // terminal above, and matching it here would double-fire.
        kind: "response",
        match: {
          type: "returnStatement",
          excludeCallReturns: true,
        },
        extraction: {
          defaultStatusCode: 200,
        },
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

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-fastify",
  dependencies: [{ ecosystem: "npm", name: "fastify" }],
  reads: "Fastify handlers.",
};

export default fastifyFramework;
