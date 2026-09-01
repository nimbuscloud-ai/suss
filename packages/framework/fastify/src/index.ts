// @suss/framework-fastify: PatternPack for Fastify

import { z } from "zod";

import {
  httpRouteDiscovery,
  registrationHelperDiscovery,
  registrationHelperOption,
} from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";

/**
 * What `-f fastify=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * The project's own registration helpers, each expanded into the
     * routes one call registers. A helper's name belongs to one project,
     * so this arrives through per-project pack config
     * (`-f fastify=config.json`) rather than being built in here.
     */
    registrationHelpers: z.array(registrationHelperOption).optional(),
    /**
     * The directory of the config file these options came from. Whatever
     * read that file supplies this; it is not written in the file.
     */
    configDirectory: z.string().optional(),
  })
  .strict();

export type FastifyPackOptions = z.infer<typeof optionsSchema>;

export function fastifyFramework(
  options: FastifyPackOptions = {},
): PatternPack {
  return {
    name: "fastify",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // Fastify exposes the routable via either default `Fastify` or
    // named `fastify()`. Both drive handler registration the same way.
    // Unlike Express, Fastify's router supports `.head` and `.options`.
    discovery: [
      ...httpRouteDiscovery({
        importModule: "fastify",
        importNames: ["Fastify", "fastify"],
        methods: [
          ".get",
          ".post",
          ".put",
          ".delete",
          ".patch",
          ".head",
          ".options",
          ".all",
        ],
      }),
      ...registrationHelperDiscovery(
        options.registrationHelpers ?? [],
        options.configDirectory,
      ),
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

export default fastifyFramework;
