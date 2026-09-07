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
      },
    ],
  };
}

export default faradayClient;
