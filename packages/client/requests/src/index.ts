/**
 * @suss/client-requests: PythonPack for the calls
 * [requests](https://requests.readthedocs.io/) gives a project for
 * making an HTTP request.
 *
 * A function that calls one of them is a client of the route it names.
 * The seven verb functions say the method themselves, `request` takes
 * it as its first argument, and a `Session` takes the same calls. See
 * the README for what the pack reads and where it stops.
 */

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

/** The seven functions `requests` exports, and the method each one sends. */
const VERB_FUNCTIONS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

export function requestsClient(): PythonPack {
  return {
    name: "requests",
    protocol: "http",
    discovery: [],
    clients: [
      {
        type: "clientCall",
        importModule: ["requests"],
        verbAttributeNames: VERB_FUNCTIONS,
        // Every one of them takes the URL first, and `url=` is the
        // keyword for all of them but `request`, which takes `url`
        // second and still calls it that.
        url: { position: 0, keyword: "url" },
        methodCall: {
          attribute: "request",
          methodPosition: 0,
          methodKeyword: "method",
          urlPosition: 1,
        },
        receiverConstructors: ["Session"],
        // What a caller reads off the response it got back. A test on
        // one of these says which statuses the caller handles.
        response: {
          statusCode: ["status_code"],
          success: ["ok"],
          body: ["json", "text", "content"],
          failureDelivery: "response",
        },
      },
    ],
    // `Session.__enter__` returns the session, so `with
    // requests.Session() as s` puts the constructed session in s.
    contextManagers: [{ module: "requests", returnsSelf: ["Session"] }],
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-requests",
  dependencies: [{ ecosystem: "pypi", name: "requests" }],
  reads:
    "requests call sites (Python): the seven verb functions, \`requests.request\`, and a \`Session\`, each bound to the method and path the call states.",
};

export default requestsClient;
