/**
 * @suss/client-requests: the Python pack for HTTP requests made with
 * [requests](https://requests.readthedocs.io/).
 *
 * A function that calls requests becomes a client of the route in the
 * call. Each of the seven verb functions sends one method, `request`
 * takes the method as its first argument, and a `Session` has the same
 * calls. The README lists what the pack reads and where it stops.
 */

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

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
        // The verb functions take the URL first and `request` takes it
        // second. All of them accept it as `url=`.
        url: { position: 0, keyword: "url" },
        methodCall: {
          attribute: "request",
          methodPosition: 0,
          methodKeyword: "method",
          urlPosition: 1,
        },
        receiverConstructors: ["Session"],
        // A caller's condition on one of these members shows which
        // statuses it handles.
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
