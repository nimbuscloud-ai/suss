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
import type { PackDeclaration } from "@suss/ir-core";

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
        // httpx spells the response the way requests does, which is
        // deliberate on its part.
        response: {
          statusCode: ["status_code"],
          success: ["is_success"],
          body: ["json", "text", "content"],
          failureDelivery: "response",
        },
      },
    ],
    // Both classes document `__enter__` as giving back the client, so
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
