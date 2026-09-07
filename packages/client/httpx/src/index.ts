/**
 * @suss/client-httpx: PythonPack for the calls
 * [httpx](https://www.python-httpx.org/) gives a project for making an
 * HTTP request.
 *
 * A function that calls one of them is a client of the route it names.
 * The verb functions say the method themselves, `request` takes it as
 * its first argument, and both clients take the same calls. See the
 * README for what the pack reads and where it stops.
 */

import type { PythonPack } from "@suss/adapter-python";

/** The functions httpx exports at the top level, and the method each one sends. */
const VERB_FUNCTIONS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

export function httpxClient(): PythonPack {
  return {
    name: "httpx",
    protocol: "http",
    discovery: [],
    clients: [
      {
        type: "clientCall",
        importModule: ["httpx"],
        verbAttributeNames: VERB_FUNCTIONS,
        url: { position: 0, keyword: "url" },
        methodCall: {
          attribute: "request",
          methodPosition: 0,
          methodKeyword: "method",
          urlPosition: 1,
        },
        // Both are written as a context manager as often as they are
        // assigned, and the adapter reads a `with ... as` the same way.
        receiverConstructors: ["Client", "AsyncClient"],
      },
    ],
  };
}

export default httpxClient;
