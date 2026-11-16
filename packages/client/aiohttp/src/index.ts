/**
 * @suss/client-aiohttp: the Python pack for HTTP requests made with
 * [aiohttp](https://docs.aiohttp.org/).
 *
 * Every aiohttp request goes through a session. A project usually opens
 * the session with `async with` and calls a verb method on it. The
 * README lists what the pack reads and where it stops.
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
const PACK_VERSION = "1";

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

/** The request methods on a `ClientSession`. */
export const AIOHTTP = httpRequests({
  client: anyOf(
    imported({ from: ["aiohttp"], named: ["*", ...Object.keys(METHODS)] }),
    constructedFrom({ from: ["aiohttp"], named: ["ClientSession"] }),
  ),
})
  .methods(METHODS)
  .response({
    redirectDelivery: "followed",
    redirectOption: { name: "allow_redirects", handsBack: [false] },
  })
  .example('aiohttp.ClientSession().get("https://api.example.com/orders")');

export function aiohttpClient(): PythonPack {
  return {
    name: "aiohttp",
    version: PACK_VERSION,
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf([AIOHTTP]),
    // `ClientSession.__aenter__` returns the session, so `async with
    // aiohttp.ClientSession() as s` puts the constructed session in s.
    contextManagers: [{ module: "aiohttp", returnsSelf: ["ClientSession"] }],
  };
}

/** What this pack reads, and what a project has to be using for it to. */
export const declares: PackDeclaration = {
  kind: "client",
  package: "@suss/client-aiohttp",
  dependencies: [{ ecosystem: "pypi", name: "aiohttp" }],
  reads:
    "aiohttp call sites (Python): the request methods on a \`ClientSession\`, opened with \`async with\` or held in an assignment.",
};

export default aiohttpClient;
