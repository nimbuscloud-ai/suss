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

type PyClientCall = NonNullable<PythonPack["clients"]>[number];
type RedirectDelivery = NonNullable<
  NonNullable<PyClientCall["response"]>["redirectDelivery"]
>;

const VERB_METHODS_THAT_FOLLOW: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
};

/**
 * The verb methods in `verbs` on a `ClientSession`, which do
 * `redirectDelivery` with a redirect unless the call passes
 * `allow_redirects` to say otherwise.
 */
function verbCalls(
  verbs: Record<string, string>,
  redirectDelivery: RedirectDelivery,
): PyClientCall {
  return {
    type: "clientCall",
    importModule: ["aiohttp"],
    verbAttributeNames: verbs,
    url: { position: 0, keyword: "url" },
    receiverConstructors: ["ClientSession"],
    response: {
      redirectDelivery,
      redirectOption: { name: "allow_redirects", handsBack: [false] },
    },
  };
}

export function aiohttpClient(): PythonPack {
  return {
    name: "aiohttp",
    protocol: "http",
    discovery: [],
    // `head` defaults `allow_redirects` to False, and every other call,
    // `request("HEAD", url)` included, defaults it to True.
    clients: [
      {
        ...verbCalls(VERB_METHODS_THAT_FOLLOW, "followed"),
        methodCall: {
          attribute: "request",
          methodPosition: 0,
          methodKeyword: "method",
          urlPosition: 1,
        },
      },
      verbCalls({ head: "HEAD" }, "response"),
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
