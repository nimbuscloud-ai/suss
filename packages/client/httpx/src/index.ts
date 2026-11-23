/**
 * @suss/client-httpx: the Python pack for HTTP requests made with
 * [httpx](https://www.python-httpx.org/).
 *
 * A function that calls httpx becomes a client of the route in the
 * call. Each verb function sends one method, `request` takes the method
 * as its first argument, and both client classes have the same calls.
 * The README lists what the pack reads and where it stops.
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
const PACK_VERSION = "3";

const URL_FIRST: OneArgument = { at: 0, keyword: "url" };

const VERBS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

const METHODS: Record<string, RequestMethod> = {
  ...verbs(VERBS, URL_FIRST),
  request: {
    sends: { from: { at: 0, keyword: "method" } },
    url: { at: 1, keyword: "url" },
  },
};

/** The module's own functions, and the same calls on a `Client` or an `AsyncClient`. */
export const HTTPX = httpRequests({
  client: anyOf(
    imported({ from: ["httpx"], named: ["*", ...Object.keys(METHODS)] }),
    constructedFrom({ from: ["httpx"], named: ["Client", "AsyncClient"] }),
  ),
})
  .methods(METHODS)
  // httpx takes `base_url` only by keyword, ends its path with `/`, and
  // puts a relative path after it whether or not the path starts with `/`.
  .baseUrl({
    at: 0,
    keyword: "base_url",
    joins: "appended",
    trailingSlash: "added",
  })
  // httpx copies the requests response API, with `is_success` in place
  // of `ok`, and hands a 3xx back unless the call passes
  // `follow_redirects=True`.
  .response({
    statusCode: ["status_code"],
    success: ["is_success"],
    body: ["json", "text", "content"],
    failureDelivery: "response",
    redirectDelivery: "response",
    redirectOption: { name: "follow_redirects", handsBack: [false] },
  })
  .example('httpx.get("https://api.example.com/orders")');

export function httpxClient(): PythonPack {
  return {
    name: "httpx",
    version: PACK_VERSION,
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf([HTTPX]),
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
