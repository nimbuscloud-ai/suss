// @suss/framework-express: PatternPack for Express

import { z } from "zod";

import {
  httpRouteDiscovery,
  registrationHelperDiscovery,
  registrationHelperOption,
  wrapperDiscovery,
} from "@suss/extractor";

import type { PatternPack } from "@suss/extractor";

/**
 * What `-f express=config.json` may say. The CLI parses the file against it
 * before the factory runs.
 */
export const optionsSchema = z
  .object({
    /**
     * The project's own registration helpers, each expanded into the
     * routes one call registers. A helper's name belongs to one project,
     * so this arrives through per-project pack config
     * (`-f express=config.json`) rather than being built in here.
     */
    registrationHelpers: z.array(registrationHelperOption).optional(),
    /**
     * The directory of the config file these options came from. Whatever
     * read that file supplies this; it is not written in the file.
     */
    configDirectory: z.string().optional(),
  })
  .strict();

export type ExpressPackOptions = z.infer<typeof optionsSchema>;

export function expressFramework(
  options: ExpressPackOptions = {},
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
        methods: [".get", ".post", ".put", ".delete", ".patch", ".all"],
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
      ...registrationHelperDiscovery(
        options.registrationHelpers ?? [],
        options.configDirectory,
      ),
    ],

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
        // res.json(body): implicit 200
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
        // res.send(body): implicit 200
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
        // res.sendStatus(N): sends status code with status text as body
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
