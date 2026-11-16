/**
 * @suss/client-net-http: the Ruby pack for HTTP requests made with
 * Ruby's built-in
 * [Net::HTTP](https://docs.ruby-lang.org/en/master/Net/HTTP.html).
 *
 * A method that calls Net::HTTP becomes a client of the route in the
 * call. It can call a module method directly, or build a request object
 * and send that. The README lists what the pack reads and where it
 * stops.
 */

import {
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  verbs,
} from "@suss/recognize";

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";
import type { RequestMethod, UrlArgument } from "@suss/recognize";

/** The build of this pack, which the extraction cache keys on. */
const PACK_VERSION = "2";

/** Methods that send a request without a request object. */
const VERB_METHODS: Record<string, string> = {
  get: "GET",
  get_response: "GET",
  get_print: "GET",
  post: "POST",
  post_form: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

const REQUEST_CLASSES: Record<string, string> = {
  "Net::HTTP::Get": "GET",
  "Net::HTTP::Post": "POST",
  "Net::HTTP::Put": "PUT",
  "Net::HTTP::Patch": "PATCH",
  "Net::HTTP::Delete": "DELETE",
  "Net::HTTP::Head": "HEAD",
  "Net::HTTP::Options": "OPTIONS",
};

// These methods take a URI object. `URI(...)` and `URI.parse(...)` are
// part of Ruby, so the adapter already evaluates them and the pack adds
// nothing for them.
const URL_FIRST: UrlArgument = { at: 0 };

// `Net::HTTP.get("api.example.com", "/orders", 8080)` passes the host
// and the path apart. The get methods decide by the second argument: a
// path means this form, and a hash means headers.
const HOST_FIRST: UrlArgument = {
  ...URL_FIRST,
  hostFirst: { host: { at: 0 }, path: { at: 1 }, port: { at: 2 } },
};

const REQUEST_OBJECT: RequestMethod = {
  sends: { object: 0, classes: REQUEST_CLASSES, url: { at: 0 } },
};

// `code` is a string, so callers write `response.code.to_i == 404`. That
// comparison is read the same way as one on any other member.
const RESPONSE = {
  statusCode: ["code"],
  body: ["body"],
  failureDelivery: "response",
  // Net::HTTP never follows a redirect.
  redirectDelivery: "response",
} as const;

/** The calls on `Net::HTTP` itself. */
export const NET_HTTP = httpRequests({
  client: imported({ from: ["Net::HTTP"], named: ["*"] }),
})
  .methods({
    ...verbs(VERB_METHODS, URL_FIRST),
    ...verbs({ get: "GET", get_response: "GET", get_print: "GET" }, HOST_FIRST),
    request: REQUEST_OBJECT,
  })
  .response(RESPONSE)
  .example('Net::HTTP.get(URI("https://api.example.com/orders"))');

/**
 * The same calls on a connection `Net::HTTP.new(host, port)` opened,
 * which take a path and go to the connection's host.
 */
export const NET_HTTP_CONNECTION = httpRequests({
  client: constructedFrom({ from: ["Net::HTTP"], named: ["HTTP"] }),
})
  .methods({ ...verbs(VERB_METHODS, URL_FIRST), request: REQUEST_OBJECT })
  .baseUrl({ at: 0, reads: "host", port: { at: 1 }, joins: "resolved" })
  .response(RESPONSE)
  .example('Net::HTTP.new("api.example.com").get("/orders")');

export function netHttpClient(): RubyPack {
  return {
    name: "net-http",
    version: PACK_VERSION,
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf([NET_HTTP, NET_HTTP_CONNECTION]),
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-net-http",
  dependencies: [],
  shippedWith: "ruby",
  sourcePattern: /\bNet::HTTP\b/,
  reads:
    "Net::HTTP call sites (Ruby): the module methods that send on their own, given a URL or a host and a path, and a request object built with \`Net::HTTP::Get\` and its siblings, with the URL read through \`URI\`.",
};

export default netHttpClient;
