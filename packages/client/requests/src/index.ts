/**
 * @suss/client-requests: the Python pack for HTTP requests made with
 * [requests](https://requests.readthedocs.io/).
 *
 * A function that calls requests becomes a client of the route in the
 * call. Each of the seven verb functions sends one method, `request`
 * takes the method as its first argument, and a `Session` has the same
 * calls. The README lists what the pack reads and where it stops.
 */

import {
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  verbs,
} from "@suss/recognize";

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";
import type { OneArgument, RequestMethod } from "@suss/recognize";

/** The build of this pack, which the extraction cache keys on. */
const PACK_VERSION = "2";

// The verb functions take the URL first and `request` takes it second.
// All of them accept it as `url=`.
const URL_FIRST: OneArgument = { at: 0, keyword: "url" };

const VERBS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
};

// `head` defaults `allow_redirects` to False, and every other call,
// `request("HEAD", url)` included, defaults it to True.
const METHODS: Record<string, RequestMethod> = {
  ...verbs(VERBS, URL_FIRST),
  head: { sends: "HEAD", url: URL_FIRST, redirects: "response" },
  request: {
    sends: { from: { at: 0, keyword: "method" } },
    url: { at: 1, keyword: "url" },
  },
};

/** The module's own functions, and the same calls on a `Session`. */
export const REQUESTS = httpRequests({
  client: anyOf(
    imported({ from: ["requests"], named: ["*", ...Object.keys(METHODS)] }),
    constructedFrom({ from: ["requests"], named: ["Session"] }),
  ),
})
  .methods(METHODS)
  // A caller's condition on one of these members shows which statuses
  // it handles.
  .response({
    statusCode: ["status_code"],
    success: ["ok"],
    body: ["json", "text", "content"],
    failureDelivery: "response",
    redirectDelivery: "followed",
    redirectOption: { name: "allow_redirects", handsBack: [false] },
  })
  .example('requests.get("https://api.example.com/orders")');

export function requestsClient(): PythonPack {
  return {
    name: "requests",
    version: PACK_VERSION,
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf([REQUESTS]),
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
