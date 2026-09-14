/**
 * An HTTP library written the way a client pack writes one, with the
 * two shapes a pack can declare: request methods on the constant
 * itself, and a call that sends a request object built elsewhere. None
 * of these strings appear anywhere in the adapter's own source.
 */

import type { RbClientCall, RubyPack } from "../pack.js";

export function requestCallsPattern(
  overrides: Partial<RbClientCall> = {},
): RbClientCall {
  return {
    constantName: "HttpClient",
    verbMethodNames: { get: "GET", post: "POST" },
    url: { position: 0, keyword: "url" },
    receiverBuilders: ["build"],
    builderUrlKeyword: "base",
    ...overrides,
  };
}

/** A library that sends a request built somewhere else. */
export function wrappedUrlsPattern(): RbClientCall {
  return requestCallsPattern({
    verbMethodNames: { get: "GET" },
    url: { position: 0 },
    requestObject: {
      attribute: "send_it",
      constructors: { "HttpClient::Get": "GET", "HttpClient::Post": "POST" },
      urlPosition: 0,
    },
  });
}

export function httpClientTestPack(
  pattern: RbClientCall = requestCallsPattern(),
): RubyPack {
  return {
    name: "httpclient",
    protocol: "http",
    discovery: [],
    clients: [pattern],
  };
}
