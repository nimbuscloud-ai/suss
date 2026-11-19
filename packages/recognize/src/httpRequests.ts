/**
 * A pack that recognizes the HTTP requests a library's calls send:
 *
 *   requests.get("https://api.example.com/orders")
 *   session.request("POST", url)
 *   Faraday.new(url: "https://api.example.com/v1").get("orders")
 *
 * A chain says what the requests are made on, which methods send one and
 * where each takes its method and URL, where the client's construction
 * states a base URL, and what a caller can read off the response. The
 * adapter makes the function the call is written in a client of each
 * request the chain finds, so the chain doesn't record an effect itself.
 */

import { chainStart } from "./chain.js";

import type { ClientResponse } from "@suss/extractor";
import type {
  BaseJoin,
  Chain,
  HttpRequestEnding,
  Link,
  MethodMeaning,
  OneArgument,
  RequestMethod,
  SentAsNamed,
  UrlArgument,
} from "./chain.js";
import type { ReceiverOrigin } from "./ops.js";

export interface HttpRequestsSpec {
  /** What the requests are made on: the receiver of a method, or the callee of a bare call. */
  readonly client: ReceiverOrigin;
}

/** A chain over requests, and the links that can still be added. */
export interface HttpRequests {
  /**
   * The methods that send a request, by the name the call is written
   * with. A bare call is looked up by the export its import binds, so
   * `get(url)` after `from requests import get` is `get`.
   */
  methods(table: Readonly<Record<string, RequestMethod>>): HttpRequests;
  /** What a call of the client itself sends, as `fetch(url)` or `api(config)` after `api = axios.create()`. */
  calls(meaning: RequestMethod): HttpRequests;
  /**
   * Where the client's construction states a base URL, and how the
   * library puts a call's path under it. `reads: "host"` says the
   * argument is a host with the port at `port`, and no path.
   */
  baseUrl(pick: BaseUrlPick): HttpRequests;
  /** What a caller can read off the response, and what the client does with a refusal or a redirect. */
  response(response: ClientResponse): HttpRequests;
  /** A line of code this matches, which the pack's tests run. */
  example(code: string): HttpRequests;
  /** The links and the ending, as data. */
  readonly declared: Chain<MethodMeaning>;
}

/** Where a construction states a base URL, as `HttpRequests.baseUrl` takes it. */
export type BaseUrlPick = OneArgument & {
  readonly joins: BaseJoin;
  readonly reads?: "host";
  readonly port?: OneArgument;
  readonly trailingSlash?: "required" | "added";
  readonly schemeRelative?: "path";
};

/**
 * A methods table entry for each verb, each sending its method and
 * taking the URL where `url` says: `{ get: "GET", post: "POST" }`.
 */
export function verbs(
  table: Readonly<Record<string, string>>,
  url: UrlArgument,
): Record<string, SentAsNamed> {
  return Object.fromEntries(
    Object.entries(table).map(([name, sends]) => [name, { sends, url }]),
  );
}

/** A pack that recognizes the requests a library sends. */
export function httpRequests(spec: HttpRequestsSpec): HttpRequests {
  const ending: HttpRequestEnding = { yields: "httpRequest", response: {} };
  return chainFrom({
    links: chainStart(spec.client),
    ending,
    example: null,
  });
}

/** The same chain with one more link, or with its ending or example set. */
function chainFrom(declared: Chain<MethodMeaning>): HttpRequests {
  const adding = (link: Link<MethodMeaning>): HttpRequests =>
    chainFrom({ ...declared, links: [...declared.links, link] });

  return {
    declared,
    methods: (table) => adding({ asks: "methods", table, ignoringCase: false }),
    calls: (meaning) => adding({ asks: "calls", meaning }),
    baseUrl: ({ joins, reads, port, trailingSlash, schemeRelative, ...at }) =>
      adding({
        asks: "baseUrl",
        at,
        joins,
        ...(reads === undefined ? {} : { reads }),
        ...(port === undefined ? {} : { port }),
        ...(trailingSlash === undefined ? {} : { trailingSlash }),
        ...(schemeRelative === undefined ? {} : { schemeRelative }),
      }),
    response: (response) =>
      chainFrom({
        ...declared,
        ending: { yields: "httpRequest", response },
      }),
    example: (code) => chainFrom({ ...declared, example: code }),
  };
}
