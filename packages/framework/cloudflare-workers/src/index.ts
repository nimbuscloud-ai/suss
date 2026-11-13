/**
 * Pattern pack for a Cloudflare Workers entrypoint. A Worker registers
 * no routes. It exports an object whose properties are the triggers
 * Cloudflare calls, so discovery reads that export, and the shape of the
 * export also acts as the import gate.
 *
 * Bindings arrive as the second argument to every trigger, and the env
 * chain and the store recognizer read them there. The README explains
 * why an HTTP Worker gets one boundary for all of its paths.
 */

import { z } from "zod";

import { compile, declarationsIn, describeDiscovery } from "@suss/recognize";

import { envReads } from "./bindings.js";
import { storeBindingRecognizer } from "./storeBindings.js";
import { entrypointObject, listener } from "./triggers.js";

import type { InvocationRecognizer, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";

export { TRIGGERS, type TriggerShape } from "./handlers.js";
export { storeBindingRecognizer } from "./storeBindings.js";
export { METADATA_NAMESPACE } from "./triggers.js";

const RECOGNITION = "@suss/framework-cloudflare-workers";

/**
 * What the extraction cache keys this pack's results on. Bump it on any
 * change to the units it finds or what it reads into them.
 */
const VERSION = "4";

export const optionsSchema = z
  .object({
    /**
     * The Worker's `name` from `wrangler.toml`. When it is set, every unit
     * records it as its deployable, so a runtime-config provider pairs
     * with the Worker by name. Without it, units pair by directory.
     */
    scriptName: z.string().optional(),
  })
  .strict();

export type CloudflareWorkersPackOptions = z.infer<typeof optionsSchema>;

export function cloudflareWorkersFramework(
  options: CloudflareWorkersPackOptions = {},
): PatternPack {
  const { scriptName } = options;
  const patterns = [entrypointObject(scriptName), listener(scriptName)];
  const env = envReads({
    deploymentTarget: "worker",
    ...(scriptName === undefined ? {} : { instanceName: scriptName }),
  });
  return {
    name: "cloudflare-workers",
    version: VERSION,
    protocol: "http",
    languages: ["typescript", "javascript"],

    // Neither pattern states an import, since a Worker imports nothing to
    // be one, so the pack reads every file.
    discovery: patterns,

    terminals: [
      {
        // new Response(body, { status }). A Worker returns a Response for
        // JSON, a redirect, a stream and plain text alike.
        kind: "response",
        match: { type: "functionCall", functionName: "Response" },
        extraction: {
          body: { from: "argument", position: 0 },
          statusCode: { from: "argumentProperty", position: 1, name: "status" },
          defaultStatusCode: 200,
        },
      },
      {
        // Response.json(body, { status }), the platform's own helper.
        kind: "response",
        match: { type: "functionCall", functionName: "Response.json" },
        extraction: {
          body: { from: "argument", position: 0 },
          statusCode: { from: "argumentProperty", position: 1, name: "status" },
          defaultStatusCode: 200,
        },
      },
      {
        // Response.redirect(url, status). The platform sends 302 when
        // the caller leaves the status off.
        kind: "response",
        match: { type: "functionCall", functionName: "Response.redirect" },
        extraction: {
          statusCode: { from: "argument", position: 1 },
          defaultStatusCode: 302,
        },
      },
      {
        // A returned value that is none of the above: a Response the
        // handler got back from `fetch`, or from a helper of its own.
        kind: "return",
        match: { type: "returnStatement", excludeCallReturns: true },
        extraction: {},
      },
      { kind: "throw", match: { type: "throwExpression" }, extraction: {} },
      {
        // scheduled, queue and tail return nothing, so their bodies end
        // by running off the end.
        kind: "return",
        match: { type: "functionFallthrough" },
        extraction: {},
      },
    ],

    // Every trigger takes its event first, its bindings second and its
    // execution context third.
    inputMapping: {
      type: "positionalParams",
      params: [
        { position: 0, role: "event" },
        { position: 1, role: "config" },
        { position: 2, role: "context" },
      ],
    },

    accessRecognizers: [compile(env.declared, RECOGNITION)],

    // A store call on an env binding: `env.SESSIONS.get(key)`.
    invocationRecognizers: [storeBindingRecognizer as InvocationRecognizer],

    declarations: {
      declarations: [
        ...declarationsIn([env]).declarations,
        ...patterns.map(describeDiscovery),
      ],
    },
  };
}

export const declares: PackDeclaration = {
  kind: "framework",
  package: "@suss/framework-cloudflare-workers",
  dependencies: [
    { ecosystem: "npm", name: "wrangler" },
    { ecosystem: "npm", name: "@cloudflare/workers-types" },
  ],
  reads:
    "A Cloudflare Workers entrypoint: one unit per trigger the default export defines, and the bindings its code reads off the argument they arrive in.",
};

export default cloudflareWorkersFramework;
