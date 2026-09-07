/**
 * @suss/client-aiohttp: PythonPack for the calls
 * [aiohttp](https://docs.aiohttp.org/) gives a project for making an
 * HTTP request.
 *
 * Every request goes through a session, which a project opens as a
 * context manager and calls a verb method on. See the README for what
 * the pack reads and where it stops.
 */

import type { PythonPack } from "@suss/adapter-python";

/** The methods a session gives a project, and the method each one sends. */
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
  };
}

export default aiohttpClient;
