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

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** Module methods that send a request without a request object. */
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

export function netHttpClient(): RubyPack {
  return {
    name: "net-http",
    version: "1",
    protocol: "http",
    discovery: [],
    clients: [
      {
        constantName: "Net::HTTP",
        verbMethodNames: VERB_METHODS,
        // These methods take a URI object. `URI(...)` and `URI.parse(...)`
        // are part of Ruby, so the adapter already evaluates them and the
        // pack adds nothing for them.
        url: { position: 0 },
        // `Net::HTTP.get("api.example.com", "/orders", 8080)` passes the
        // host and the path apart. The get methods decide by the second
        // argument: a path means this form, and a hash means headers.
        hostThenPath: {
          methods: ["get", "get_response", "get_print"],
          host: 0,
          path: 1,
          port: 2,
        },
        receiverBuilders: ["new"],
        // `Net::HTTP.new(host, port)` takes no path, so a call on it goes
        // to that host with the call's own path.
        builderHost: { host: 0, port: 1 },
        requestObject: {
          attribute: "request",
          constructors: REQUEST_CLASSES,
          urlPosition: 0,
        },
        // `code` is a string, so callers write `response.code.to_i == 404`.
        // That comparison is read the same way as one on any other member.
        response: {
          statusCode: ["code"],
          body: ["body"],
          failureDelivery: "response",
          // Net::HTTP never follows a redirect.
          redirectDelivery: "response",
        },
      },
    ],
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
