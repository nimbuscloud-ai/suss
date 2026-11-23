/**
 * @suss/client-web: the pack for HTTP requests made with the WHATWG
 * `fetch`.
 *
 * A function that calls fetch becomes a client of the route in the call.
 * The URL is the first argument, the method is the `method` of the
 * options after it, GET when it states none, and `redirect` there says
 * whether the call follows a redirect. The README lists what the pack
 * reads and where it stops.
 */

import { clientResponseOf } from "@suss/extractor";
import {
  anyOf,
  httpRequests,
  requestRecognizersOf,
  spelled,
} from "@suss/recognize";

import type { PatternPack } from "@suss/extractor";
import type { PackDeclaration } from "@suss/ir-core";
import type { RequestMethod } from "@suss/recognize";

/** The build of this pack, which the extraction cache keys on. */
const PACK_VERSION = "2";

/** What a caller reads off a fetch `Response`, and what fetch does with a redirect by default. */
const RESPONSE = {
  responseSemantics: [
    {
      name: "ok",
      access: "property",
      semantics: { type: "statusRange", min: 200, max: 299 },
    },
    { name: "status", access: "property", semantics: { type: "statusCode" } },
    { name: "json", access: "method", semantics: { type: "body" } },
    { name: "text", access: "method", semantics: { type: "body" } },
    { name: "body", access: "property", semantics: { type: "body" } },
    { name: "headers", access: "property", semantics: { type: "headers" } },
  ],
  // fetch follows 301, 302, 303, 307 and 308, so the caller sees the
  // final response, unless the call passes `redirect: "manual"` or
  // `redirect: "error"`.
  redirectDelivery: "followed",
} satisfies Pick<PatternPack, "responseSemantics" | "redirectDelivery">;

const FETCH_CALL: RequestMethod = {
  sends: { from: { at: 1, property: ["method"] }, default: "GET" },
  url: { at: 0 },
  options: { at: 1 },
};

/**
 * `fetch(url, init)`, and the same function read off the global object.
 * A `fetch` the program binds itself, such as one a caller hands in or
 * one imported from a fetch library, is read as fetch too, since it is
 * nearly always an implementation of it.
 */
export const FETCH = httpRequests({
  client: anyOf(
    spelled("fetch"),
    spelled("globalThis", "window", "self", "global"),
  ),
})
  .methods({ fetch: FETCH_CALL })
  .response({
    ...clientResponseOf(RESPONSE),
    redirectOption: { name: "redirect", handsBack: ["manual", "error"] },
  })
  .example('fetch("https://api.example.com/orders")');

export function webFetchPack(): PatternPack {
  return {
    name: "fetch",
    version: PACK_VERSION,
    protocol: "http",
    languages: ["typescript"],

    discovery: [],
    requestRecognizers: requestRecognizersOf([FETCH]),

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
  package: "@suss/client-web",
  dependencies: [],
  shippedWith: "typescript",
  sourcePattern: /(?:^|[^.\w$]|\b(?:window|globalThis|self)\.)fetch\s*\(/m,
  reads: "Global \`fetch\` call sites.",
};

export default webFetchPack;
