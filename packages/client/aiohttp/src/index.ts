/**
 * @suss/client-aiohttp: the Python pack for HTTP requests made with
 * [aiohttp](https://docs.aiohttp.org/).
 *
 * Every aiohttp request goes through a session. A project usually opens
 * the session with `async with` and calls a verb method on it. The
 * README lists what the pack reads and where it stops.
 */

import type { PythonPack } from "@suss/adapter-python";
import type { PackDeclaration } from "@suss/ir-core";

const VERB_METHODS: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  head: "HEAD",
  options: "OPTIONS",
};

export function aiohttpClient(): PythonPack {
  return {
    name: "aiohttp",
    protocol: "http",
    discovery: [],
    clients: [
      {
        type: "clientCall",
        importModule: ["aiohttp"],
        verbAttributeNames: VERB_METHODS,
        url: { position: 0, keyword: "url" },
        methodCall: {
          attribute: "request",
          methodPosition: 0,
          methodKeyword: "method",
          urlPosition: 1,
        },
        receiverConstructors: ["ClientSession"],
      },
    ],
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
