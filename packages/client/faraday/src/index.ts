/**
 * @suss/client-faraday: the Ruby pack for HTTP requests made with
 * [Faraday](https://lostisland.github.io/faraday/).
 *
 * A method that calls a Faraday verb becomes a client of the route in
 * the call. The call can be on the `Faraday` constant or on a connection
 * built with `Faraday.new`. The README lists what the pack reads and
 * where it stops.
 */

import type { RubyPack } from "@suss/adapter-ruby";
import type { PackDeclaration } from "@suss/ir-core";

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

export function faradayClient(): RubyPack {
  return {
    name: "faraday",
    protocol: "http",
    discovery: [],
    clients: [
      {
        constantName: "Faraday",
        verbMethodNames: VERB_METHODS,
        url: { position: 0 },
        receiverBuilders: ["new"],
        // Calls on a connection from `Faraday.new(url: ".../v1")` get the
        // path of that URL in front of their own.
        builderUrlKeyword: "url",
        // A caller's condition on one of these members shows which
        // statuses it handles.
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
