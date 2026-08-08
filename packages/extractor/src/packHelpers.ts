/**
 * Small helpers for pattern packs that are built the same way.
 *
 * The pack interface is deliberately declarative: a PatternPack is a data
 * object the adapter interprets, and most differences between frameworks are
 * best expressed that way. A few patterns, though, repeat word for word
 * across packs, and this module collects those so they are written once.
 */

import type { DiscoveryPattern } from "./framework.js";

/**
 * Build the `discovery` entries for an HTTP-server framework whose handlers
 * are registered with `app.get(path, handler)`, `router.post(...)`, and the
 * like.
 *
 * Each `importNames` entry produces one DiscoveryPattern, because a library
 * usually exposes both a default export and a named export that each produce
 * the routable instance (Express has `express()` and
 * `Router()`, Fastify has `fastify()` and `Fastify`). The binding
 * extraction, method from the registration and path from position 0, is
 * the same for every HTTP server framework we support.
 *
 * Callers still pass the `methods` list themselves, because frameworks
 * support different HTTP verbs. Fastify includes `.head` and `.options`;
 * Express historically does not by default.
 *
 * @example
 *   discovery: httpRouteDiscovery({
 *     importModule: "express",
 *     importNames: ["Router", "express"],
 *     methods: [".get", ".post", ".put", ".delete", ".patch"],
 *   })
 */
export function httpRouteDiscovery(opts: {
  importModule: string;
  importNames: readonly string[];
  methods: readonly string[];
  /** Defaults to "handler". Override for packs that want a different kind. */
  kind?: string;
  /**
   * How this framework's routable can itself be mounted onto another
   * one under a path prefix, so a route declared on the mounted value gets
   * summarized with the prefix built into its path. See `DiscoveryPattern`.
   */
  mount?: DiscoveryPattern["mount"];
}): DiscoveryPattern[] {
  const kind = opts.kind ?? "handler";
  return opts.importNames.map((importName) => ({
    kind,
    match: {
      type: "registrationCall",
      importModule: opts.importModule,
      importName,
      registrationChain: [...opts.methods],
    },
    bindingExtraction: {
      // `.all` registers every method, so it records "*", which the pairing
      // engine treats as agreeing with any method at all.
      method: {
        type: "fromRegistration",
        position: "methodName",
        nameMap: { all: "*" },
      },
      path: { type: "fromRegistration", position: 0 },
    },
    ...(opts.mount !== undefined ? { mount: opts.mount } : {}),
    requiresImport: [opts.importModule],
  }));
}
