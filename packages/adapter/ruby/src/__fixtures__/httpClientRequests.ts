/**
 * An HTTP library declared the way a client pack declares one, as request
 * chains: request methods on the constant itself, and the same methods on
 * a value one of its builders made, under the base the builder takes. The
 * adapter's own source contains none of these strings.
 */

import {
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  verbs,
} from "@suss/recognize";

import type { ClientResponse } from "@suss/extractor";
import type { HttpRequests, RequestMethod } from "@suss/recognize";
import type { RubyPack } from "../pack.js";

/** What a test changes about the library: its constant, whether it has a builder, and its response members. */
export interface TestHttpClient {
  readonly constant?: string;
  readonly built?: boolean;
  readonly response?: ClientResponse;
}

/** `HttpClient.get(url)`, and the same calls on what `HttpClient.build(base: url)` returns. */
export function requestCalls({
  constant = "HttpClient",
  built = true,
  response = {},
}: TestHttpClient = {}): readonly HttpRequests[] {
  const methods = verbs(
    { get: "GET", post: "POST" },
    { at: 0, keyword: "url" },
  );
  const onConstant = httpRequests({
    client: imported({ from: [constant], named: ["*"] }),
  }).methods(methods);
  const onBuilt = httpRequests({
    client: constructedFrom({ from: [constant], named: ["build"] }),
  })
    .methods(methods)
    .baseUrl({ at: 0, keyword: "base", joins: "resolved" });
  return (built ? [onConstant, onBuilt] : [onConstant]).map((chain) =>
    chain.response(response),
  );
}

/**
 * A library whose `fetch` on the constant can take a host, a path and a
 * port, and whose builder takes a host and a port.
 */
export function hostArguments(): readonly HttpRequests[] {
  const url = { at: 0 };
  return [
    httpRequests({
      client: imported({ from: ["HttpClient"], named: ["*"] }),
    }).methods({
      get: { sends: "GET", url },
      fetch: {
        sends: "GET",
        url: {
          ...url,
          hostFirst: { host: { at: 0 }, path: { at: 1 }, port: { at: 2 } },
        },
      },
    }),
    httpRequests({
      client: constructedFrom({ from: ["HttpClient"], named: ["build"] }),
    })
      .methods(verbs({ get: "GET", fetch: "GET" }, url))
      .baseUrl({ at: 0, reads: "host", port: { at: 1 }, joins: "resolved" }),
  ];
}

/** A library that sends a request built somewhere else, as well as a verb. */
export function wrappedUrls(): readonly HttpRequests[] {
  const methods: Record<string, RequestMethod> = {
    send_it: {
      sends: {
        object: 0,
        classes: { "HttpClient::Get": "GET", "HttpClient::Post": "POST" },
        url: { at: 0 },
      },
    },
    get: { sends: "GET", url: { at: 0 } },
  };
  return [
    httpRequests({
      client: imported({ from: ["HttpClient"], named: ["*"] }),
    }).methods(methods),
    httpRequests({
      client: constructedFrom({ from: ["HttpClient"], named: ["build"] }),
    })
      .methods(methods)
      .baseUrl({ at: 0, keyword: "base", joins: "resolved" }),
  ];
}

export function httpClientTestPack(
  requests: readonly HttpRequests[] = requestCalls(),
): RubyPack {
  return {
    name: "httpclient",
    protocol: "http",
    discovery: [],
    requestRecognizers: requestRecognizersOf(requests),
  };
}
