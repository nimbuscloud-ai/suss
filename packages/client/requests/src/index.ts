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

type PyClientCall = NonNullable<PythonPack["clients"]>[number];
type RedirectDelivery = NonNullable<
  NonNullable<PyClientCall["response"]>["redirectDelivery"]
>;

const VERB_FUNCTIONS_THAT_FOLLOW: Record<string, string> = {
  get: "GET",
  post: "POST",
  put: "PUT",
  patch: "PATCH",
  delete: "DELETE",
  options: "OPTIONS",
};

/**
 * The verb calls in `verbs`, on the module or a `Session`, which do
 * `redirectDelivery` with a redirect unless the call passes
 * `allow_redirects` to say otherwise.
 */
function verbCalls(
  verbs: Record<string, string>,
  redirectDelivery: RedirectDelivery,
): PyClientCall {
  return {
    type: "clientCall",
    importModule: ["requests"],
    verbAttributeNames: verbs,
    url: { position: 0, keyword: "url" },
    receiverConstructors: ["Session"],
    // A caller's condition on one of these members shows which
    // statuses it handles.
    response: {
      statusCode: ["status_code"],
      success: ["ok"],
      body: ["json", "text", "content"],
      failureDelivery: "response",
      redirectDelivery,
      redirectOption: { name: "allow_redirects", handsBack: [false] },
    },
  };
}

export function requestsClient(): PythonPack {
  return {
    name: "requests",
    protocol: "http",
    discovery: [],
    // `head` defaults `allow_redirects` to False, and every other call,
    // `request("HEAD", url)` included, defaults it to True.
    clients: [
      {
        ...verbCalls(VERB_FUNCTIONS_THAT_FOLLOW, "followed"),
        // The verb functions take the URL first and `request` takes it
        // second. All of them accept it as `url=`.
        methodCall: {
          attribute: "request",
          methodPosition: 0,
          methodKeyword: "method",
          urlPosition: 1,
        },
      },
      verbCalls({ head: "HEAD" }, "response"),
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
