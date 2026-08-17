/**
 * @suss/framework-cloudflare-workers: the PatternPack for a Cloudflare
 * Workers entrypoint.
 *
 * A Worker registers no routes. It exports an object whose properties
 * are the triggers Cloudflare invokes, so discovery reads that export
 * rather than a registration call, and the export shape is also the
 * import gate. What each trigger becomes is in `handlers.ts`.
 * Configuration arrives as the second argument to every trigger rather
 * than through `process.env`, so `envBindings.ts` reads it there. The
 * README says why an HTTP Worker gets one boundary rather than one per
 * path.
 */

import { cloudflareWorkersDiscovery } from "./discovery.js";
import { envBindingRecognizer } from "./envBindings.js";

import type { PatternPack } from "@suss/extractor";

export { cloudflareWorkersDiscovery, METADATA_NAMESPACE } from "./discovery.js";
export { envBindingRecognizer } from "./envBindings.js";
export { TRIGGERS, type TriggerShape } from "./handlers.js";

export interface CloudflareWorkersPackOptions {
  /**
   * The name the deployment gives this Worker, which is `name` in
   * `wrangler.toml`. Supplying it stamps every unit with the deployable
   * it runs as, so a runtime-config provider pairs by unit instead of by
   * directory. Left out, the directory decides.
   */
  scriptName?: string;
}

export function cloudflareWorkersFramework(
  options: CloudflareWorkersPackOptions = {},
): PatternPack {
  return {
    name: "cloudflare-workers",
    protocol: "http",
    languages: ["typescript", "javascript"],

    // Nothing is registered in code, so there is no data-driven
    // discovery to declare.
    discovery: [],
    discoverUnits: cloudflareWorkersDiscovery(options),

    terminals: [
      {
        // new Response(body, { status }), which is what a Worker returns
        // for everything: JSON, a redirect, a stream, plain text.
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

    accessRecognizers: [envBindingRecognizer(options)],
  };
}

export default cloudflareWorkersFramework;
