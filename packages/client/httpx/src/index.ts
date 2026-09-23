/**
 * @suss/client-httpx: the Python pack for HTTP requests made with
 * [httpx](https://www.python-httpx.org/).
 *
 * A function that calls httpx becomes a client of the route in the
 * call. Each verb function sends one method, `request` takes the method
 * as its first argument, and both client classes have the same calls.
 * The README lists what the pack reads and where it stops.
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
        receiverConstructors: ["Client", "AsyncClient"],
        // httpx copies the requests response API, with `is_success` in
        // place of `ok`.
        response: {
          statusCode: ["status_code"],
          success: ["is_success"],
          body: ["json", "text", "content"],
          failureDelivery: "response",
        },
      },
    ],
    // Both classes document `__enter__` as returning the client, so
    // `with httpx.Client() as c` puts the constructed client in c.
    contextManagers: [
      { module: "httpx", returnsSelf: ["Client", "AsyncClient"] },
    ],
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-httpx",
  dependencies: [{ ecosystem: "pypi", name: "httpx" }],
  reads:
    "httpx call sites (Python): the verb functions, \`httpx.request\`, and a \`Client\` or \`AsyncClient\` held in an assignment or opened with \`with\`.",
};

export default httpxClient;
