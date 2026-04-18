// pack-helpers.ts — small helpers for pattern packs that share structure.
//
// The pack interface is deliberately declarative: each PatternPack is a
// data object the adapter interprets. Most framework differences are
// best expressed that way. A few shapes, though, repeat verbatim across
// packs — this module collects those.

import type { DiscoveryPattern } from "./framework.js";

/**
 * Build the `discovery` entries for an HTTP-server framework whose
 * handlers are registered via `app.get(path, handler)` /
 * `router.post(...)` / etc.
 *
 * Each `importNames` entry produces one DiscoveryPattern — libraries
 * typically expose both a default export and a named export that both
 * produce the routable instance (e.g. Express has `express()` and
 * `Router()`; Fastify has `fastify()` and `Fastify`). The binding
 * extraction (method from registration, path from position 0) is
 * identical across every HTTP server framework we support.
 *
 * Callers still supply the `methods` list directly: different
 * frameworks support different HTTP verbs (Fastify includes `.head` /
 * `.options`, Express historically does not by default).
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
      method: { type: "fromRegistration", position: "methodName" },
      path: { type: "fromRegistration", position: 0 },
    },
  }));
}
