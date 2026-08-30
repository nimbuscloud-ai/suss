/**
 * Small helpers for pattern packs that are built the same way.
 *
 * The pack interface is deliberately declarative: a PatternPack is a data
 * object the adapter interprets, and most differences between frameworks are
 * best expressed that way. A few patterns, though, repeat word for word
 * across packs, and this module collects those so they are written once.
 */

import type { DiscoveryPattern } from "./framework.js";
import type { EffectArg } from "./index.js";

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
  const calls: DiscoveryPattern[] = opts.importNames.map((importName) => ({
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
      path: { type: "fromArgument", position: 0 },
    },
    ...(opts.mount !== undefined ? { mount: opts.mount } : {}),
    requiresImport: [opts.importModule],
  }));

  if (opts.importNames.length === 0) {
    // No import, no routable to guard the loop with.
    return calls;
  }

  return [
    ...calls,
    // Routes registered in a loop over an array of specs, a shape
    // registration-call discovery cannot see. The receiver comes from
    // the same import declaration as the calls above, so a loop that
    // never touches this library's routable is left alone.
    {
      kind,
      match: {
        type: "registrationLoop",
        elementShape: LOOP_ELEMENT_SHAPE,
        receiver: {
          importModule: opts.importModule,
          importNames: [...opts.importNames],
        },
      },
      requiresImport: [opts.importModule],
    },
  ];
}

/**
 * Discovery entries for the functions a framework registers around its
 * handlers: middleware, error handlers, validation hooks.
 *
 * A wrapper becomes a unit of its own, summarized like any other, so
 * these entries carry no `bindingExtraction` and no registration chain.
 * Their `match` is there for the import and the imported name, which is
 * how wrapper discovery works out which variables in a file are the
 * routable. One entry per (import name, wrapper shape) pair, since a
 * framework can register more than one kind of wrapper on a routable.
 */
export function wrapperDiscovery(opts: {
  importModule: string;
  importNames: readonly string[];
  wraps: ReadonlyArray<NonNullable<DiscoveryPattern["wraps"]>>;
  /** Defaults to "middleware". Override for packs that want another kind. */
  kind?: string;
}): DiscoveryPattern[] {
  return opts.importNames.flatMap((importName) =>
    opts.wraps.map((wraps) => ({
      kind: opts.kind ?? "middleware",
      match: {
        type: "registrationCall" as const,
        importModule: opts.importModule,
        importName,
        registrationChain: [],
      },
      wraps: { ...wraps },
      requiresImport: [opts.importModule],
    })),
  );
}

/**
 * The property names a route-spec object conventionally uses. One
 * convention across every HTTP framework pack, so a project whose
 * specs spell them differently is out of scope rather than a per-pack
 * setting nobody remembers to set.
 */
const LOOP_ELEMENT_SHAPE = {
  methodKey: "method",
  pathKey: "path",
  handlerKey: "handler",
} as const;

/**
 * One route a project helper registers when called, spelled with `{N}`
 * placeholders for the call's positional arguments.
 */
export interface RegistrationHelper {
  /** The helper's exported name, as the project's code imports it. */
  helperName: string;
  /** The module the helper is imported from, to tell two apart. */
  importModule?: string;
  registrations: Array<{
    method: string;
    pathTemplate: string;
    handlerArg: string;
  }>;
}

/**
 * Discovery patterns for a project's own registration helpers.
 *
 * A helper like `registerCrud(app, "users", handlers)` registers
 * routes the call-site never spells out, so registration-call
 * discovery cannot see them. The helper's name belongs to one project,
 * which is why this arrives through per-project pack config rather
 * than shipping inside any framework pack:
 *
 *   suss extract -f express=config.json
 *
 * with `{ "registrationHelpers": [...] }` in the file.
 */
export function registrationHelperDiscovery(
  helpers: readonly RegistrationHelper[],
  kind = "handler",
): DiscoveryPattern[] {
  return helpers.map((helper) => ({
    kind,
    match: {
      type: "registrationTemplate",
      helperName: helper.helperName,
      ...(helper.importModule !== undefined
        ? { importModule: helper.importModule }
        : {}),
      registrations: helper.registrations.map((one) => ({ ...one })),
    },
  }));
}

/**
 * The payload behind a `JSON.stringify(...)` call, or the argument
 * unchanged when it is anything else. A producer serializes its message
 * before sending it, and the shape worth comparing across the boundary
 * is what went in, not the string that came out.
 */
export function unwrapJsonStringify(body: EffectArg | null): EffectArg | null {
  if (body === null || typeof body !== "object") {
    return body;
  }
  const candidate = body as {
    kind?: string;
    callee?: string;
    args?: EffectArg[];
  };
  if (candidate.kind !== "call" || candidate.callee !== "JSON.stringify") {
    return body;
  }
  const inner = candidate.args?.[0];
  return inner ?? body;
}
