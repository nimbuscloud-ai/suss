/**
 * @suss/client-net-http: RubyPack for the calls Ruby's own
 * [Net::HTTP](https://docs.ruby-lang.org/en/master/Net/HTTP.html)
 * gives a project for making an HTTP request.
 *
 * A method that calls one of them is a client of the route it names,
 * whether it calls the module directly or builds a request object and
 * sends that. See the README for what the pack reads and where it
 * stops.
 */

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** The module methods that send a request on their own, and the method each one sends. */
const VERB_METHODS: Record<string, string> = {
  get: "GET",
  get_response: "GET",
  post: "POST",
  post_form: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

/** The request classes, and the method each one sends. */
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
    protocol: "http",
    discovery: [],
    clients: [
      {
        constantName: "Net::HTTP",
        verbMethodNames: VERB_METHODS,
        // Every one of these takes a URI object rather than a string.
        // `URI(...)` and `URI.parse(...)` belong to Ruby itself, so the
        // adapter's value tables read them and the pack says nothing.
        url: { position: 0 },
        receiverBuilders: ["new"],
        requestObject: {
          attribute: "request",
          constructors: REQUEST_CLASSES,
          urlPosition: 0,
        },
        // The status comes back as a string, which is why a caller
        // writes `response.code.to_i == 404`, read the same as any
        // other member.
        response: {
          statusCode: ["code"],
          body: ["body"],
          failureDelivery: "response",
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
  reads:
    "Net::HTTP call sites (Ruby): the module methods that send on their own, and a request object built with \`Net::HTTP::Get\` and its siblings, with the URL read through \`URI\`.",
};

export default netHttpClient;
