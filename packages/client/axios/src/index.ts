/**
 * @suss/client-axios: the pack for HTTP requests made with axios.
 *
 * A function that calls axios becomes a client of the route in the call.
 * Each verb method sends its own method, and `request(config)` and a
 * call of the client itself take the URL, the method and the options in
 * one object. A call on an instance `axios.create(config)` made goes
 * under the instance's `baseURL`. The README lists what the pack reads
 * and where it stops.
 */

import { z } from "zod";

import { clientResponseOf } from "@suss/extractor";
import {
  allOf,
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  returnedBy,
  spelled,
} from "@suss/recognize";

import type { ClientResponse, PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type {
  HttpRequests,
  ReceiverOrigin,
  RequestMethod,
} from "@suss/recognize";

/** The build of this pack, which the extraction cache keys on. */
const PACK_VERSION = "2";

/**
 * A project function that builds an axios instance the way
 * axios.create(...) does, declared in a dependency stub. A project that
 * wraps axios.create in its own helper calls only the helper at its use
 * sites, so the built-in factory method would miss those clients.
 */
const clientFactory = z
  .object({
    /** Module specifier the factory function is imported from. */
    module: z.string(),
    /** Name the factory function is exported under. */
    export: z.string(),
  })
  .strict();

export type AxiosClientFactory = z.infer<typeof clientFactory>;

/**
 * The options this pack accepts. The CLI checks a `-f axios=config.json`
 * file against it, except for the keys a dependency stub fills in, which
 * a config file may not set.
 */
export const optionsSchema = z
  .object({
    /**
     * Project functions that build axios instances, in addition to
     * axios.create. Calling one of these gives a client instance, the
     * same as an axios.create() result.
     */
    factories: z.array(clientFactory).optional(),
  })
  .strict();

export type AxiosPackOptions = z.infer<typeof optionsSchema>;

/** What a caller reads off an `AxiosResponse`, and what axios does with a refusal or a redirect. */
const RESPONSE = {
  responseSemantics: [
    // axios puts the parsed response body on `.data`.
    { name: "data", access: "property", semantics: { type: "body" } },
    { name: "status", access: "property", semantics: { type: "statusCode" } },
    { name: "headers", access: "property", semantics: { type: "headers" } },
  ],
  // axios rejects on a non-2xx status, so every failure reaches the
  // caller's catch block instead of coming back as a response.
  failureDelivery: "exception",
  // axios follows redirects unless the call or the instance sets
  // `maxRedirects: 0`.
  redirectDelivery: "followed",
} satisfies Pick<
  PatternPack,
  "responseSemantics" | "failureDelivery" | "redirectDelivery"
>;

/** The response every chain declares: the pack's members and deliveries, and the option that hands a redirect back. */
const CHAIN_RESPONSE: ClientResponse = {
  ...clientResponseOf(RESPONSE),
  redirectOption: { name: "maxRedirects", handsBack: [0] },
};

/** A verb that takes its config after the URL, and one that takes it after the body. */
function verb(sends: string, config: number): RequestMethod {
  return { sends, url: { at: 0 }, options: { at: config } };
}

/** A request written as one config object, `axios({ url, method })` or `.request(config)`. The method defaults to GET, as in axios. */
const CONFIG_CALL: RequestMethod = {
  sends: { from: { at: 0, property: ["method"] }, default: "GET" },
  url: { at: 0, property: ["url"] },
  options: { at: 0 },
};

/**
 * The methods in the order the pack has always read them, which decides
 * which request a function that makes several is a client of.
 */
const METHODS: Record<string, RequestMethod> = {
  get: verb("GET", 1),
  post: verb("POST", 2),
  put: verb("PUT", 2),
  delete: verb("DELETE", 1),
  patch: verb("PATCH", 2),
  head: verb("HEAD", 1),
  options: verb("OPTIONS", 1),
  request: CONFIG_CALL,
};

/**
 * Where a client comes from: the module's export called on directly,
 * which counts as the default import only under the export's own name,
 * as `axios.get(url)`, and an instance a call of the export makes, under
 * any name the file imports it as.
 */
function madeFrom(module: string, name: string): ReceiverOrigin {
  const from = [module];
  return anyOf(
    imported({ from, named: [name] }),
    allOf(spelled(name), imported({ from, named: ["default"] })),
    constructedFrom({ from, named: [name, "default"] }),
  );
}

/** axios itself, and the instances `axios.create` makes. */
export const AXIOS = httpRequests({
  client: anyOf(
    madeFrom("axios", "axios"),
    returnedBy(
      "create",
      imported({ from: ["axios"], named: ["axios", "default"] }),
    ),
  ),
})
  .methods(METHODS)
  .calls(CONFIG_CALL)
  .baseUrl({
    at: 0,
    property: ["baseURL"],
    joins: "appended",
    defaults: ["defaults", "baseURL"],
  })
  .response(CHAIN_RESPONSE)
  .example('axios.get("https://api.example.com/orders")');

/**
 * The instances a configured factory makes, which send the same methods.
 * Calling a factory builds a client and sends nothing, so a call of its
 * instance is not a request either.
 */
function factoryRequests(factory: AxiosClientFactory): HttpRequests {
  return httpRequests({ client: madeFrom(factory.module, factory.export) })
    .methods(METHODS)
    .baseUrl({ at: 0, property: ["baseURL"], joins: "appended" })
    .response(CHAIN_RESPONSE);
}

function isPathShapedSpecifier(specifier: string): boolean {
  return specifier.startsWith(".") || specifier.startsWith("/");
}

export function axiosPack(options: AxiosPackOptions = {}): PatternPack {
  const factories = options.factories ?? [];
  // Each importing file writes a relative path its own way, so the
  // import-text gate cannot match one, and a path-shaped factory reads
  // every file. The README has the details.
  const gated = !factories.some((factory) =>
    isPathShapedSpecifier(factory.module),
  );
  return {
    name: "axios",
    version: PACK_VERSION,
    protocol: "http",
    languages: ["typescript", "javascript"],

    discovery: [],
    requestRecognizers: requestRecognizersOf([
      AXIOS,
      ...factories.map(factoryRequests),
    ]),
    ...(gated
      ? {
          requiresImport: [
            "axios",
            ...factories.map((factory) => factory.module),
          ],
        }
      : {}),

    terminals: [
      {
        kind: "return",
        match: { type: "returnStatement" },
        extraction: {},
      },
      {
        kind: "throw",
        match: { type: "throwExpression" },
        extraction: {},
      },
    ],

    inputMapping: {
      type: "positionalParams",
      params: [],
    },

    ...RESPONSE,
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-axios",
  dependencies: [{ ecosystem: "npm", name: "axios" }],
  reads:
    "axios call sites, including calls on a client that \`axios.create\` made.",
};

export default axiosPack;
