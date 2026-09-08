/**
 * @suss/client-faraday: RubyPack for the calls
 * [Faraday](https://lostisland.github.io/faraday/) gives a project for
 * making an HTTP request.
 *
 * A method that calls one of them is a client of the route it names,
 * whether it calls the constant itself or a connection built with
 * `Faraday.new`. See the README for what the pack reads and where it
 * stops.
 */

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

/** The methods Faraday gives both the module and a connection, and the method each one sends. */
const VERB_METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

export function faradayClient(): RubyPack {
  return {
    name: "faraday",
    protocol: "http",
    discovery: [],
    clients: [
      {
        constantName: "Faraday",
        verbMethodNames: VERB_METHODS,
        // Every one of them takes the URL first.
        url: { position: 0 },
        receiverBuilders: ["new"],
        // `Faraday.new(url: "https://api.example.com/v1")` serves every
        // call on that connection under the path of its own URL.
        builderUrlKeyword: "url",
        // What a caller reads off the response it got back. A test on
        // one of these says which statuses the caller handles.
        response: {
          statusCode: ["status"],
          success: ["success?"],
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
  package: "@suss/client-faraday",
  dependencies: [{ ecosystem: "rubygems", name: "faraday" }],
  reads: `Faraday call sites (Ruby): a request method on the module itself or on a connection \`Faraday.new\` built, served under the path that connection's own URL states.`,
};

export default faradayClient;
