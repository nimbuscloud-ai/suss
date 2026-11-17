/**
 * A fetch-like global declared as a request chain, for a test that needs
 * a client and is not about which one. The shipped fetch pack depends on
 * this package, so a test here declares its own, the way that pack does.
 */

import {
  anyOf,
  httpRequests,
  requestRecognizersOf,
  spelled,
} from "@suss/recognize";

import type { RequestRecognizer } from "@suss/extractor";
import type { RequestMethod } from "@suss/recognize";

/** `fetch(url, init)`, which sends the `method` that `init` states, or GET. */
export const FETCH_CALL: RequestMethod = {
  sends: { from: { at: 1, property: ["method"] }, default: "GET" },
  url: { at: 0 },
};

/** The request hooks for `fetch`, called by its own name or read off the runtime's global object, sending what `call` says. */
export function fetchRequests(
  call: RequestMethod = FETCH_CALL,
): RequestRecognizer[] {
  return requestRecognizersOf([
    httpRequests({
      client: anyOf(
        spelled("fetch"),
        spelled("globalThis", "window", "self", "global"),
      ),
    }).methods({ fetch: call }),
  ]);
}
