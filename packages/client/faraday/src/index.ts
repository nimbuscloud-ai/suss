/**
 * @suss/client-faraday: the Ruby pack for HTTP requests made with
 * [Faraday](https://lostisland.github.io/faraday/).
 *
 * A method that calls a Faraday verb becomes a client of the route in
 * the call. The call can be on the `Faraday` constant or on a connection
 * built with `Faraday.new`. The README lists what the pack reads and
 * where it stops.
 */

import {
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  verbs,
} from "@suss/recognize";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** The build of this pack, which the extraction cache keys on. */
const PACK_VERSION = "3";

/** Faraday has these methods on both the module and a connection. */
const VERB_METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

/** The module's own request methods, and the same calls on a connection `Faraday.new` built. */
export const FARADAY = httpRequests({
  client: anyOf(
    imported({ from: ["Faraday"], named: ["*"] }),
    constructedFrom({ from: ["Faraday"], named: ["Faraday"] }),
  ),
})
  .methods({
    ...verbs(VERB_METHODS, { at: 0 }),
    // `run_request(:post, url, body, headers)`, which the verbs call.
    run_request: { sends: { from: { at: 0 } }, url: { at: 1 } },
  })
  // On a connection from `Faraday.new(url: ".../v1")`, `get("orders")`
  // goes to `/v1/orders` and `get("/orders")` to `/orders`. Faraday puts
  // `./` before a path that starts with `//`, to keep it on the base host.
  .baseUrl({ keyword: "url", at: 0, joins: "resolved", schemeRelative: "path" })
  // A caller's condition on one of these members shows which statuses
  // it handles.
  .response({
    statusCode: ["status"],
    success: ["success?"],
    body: ["body"],
    failureDelivery: "response",
    // Faraday follows a redirect only with the follow_redirects
    // middleware added, so a plain connection hands the 3xx back.
    redirectDelivery: "response",
  })
  .example('Faraday.new(url: "https://api.example.com/v1").get("orders")');

export function faradayClient(): RubyPack {
  return {
    name: "faraday",
    version: PACK_VERSION,
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf([FARADAY]),
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-faraday",
  dependencies: [{ ecosystem: "rubygems", name: "faraday" }],
  reads: `Faraday call sites (Ruby): a request method on the module itself or on a connection \`Faraday.new\` built, with the call's path resolved against that connection's own URL the way Faraday resolves it.`,
};

export default faradayClient;
