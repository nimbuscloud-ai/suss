/**
 * The request hooks a pack gives this adapter's client walk.
 *
 * A pack declares its library's requests with `@suss/recognize`, as
 * `requestRecognizers`. A pack written before that lists `clients`
 * patterns instead, and each pattern is read here as the chain that says
 * the same thing, so both kinds of pack run through one reader.
 */

import {
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
} from "@suss/recognize";

import type { RequestRecognizer } from "@suss/extractor";
import type { OneArgument, RequestMethod } from "@suss/recognize";
import type { PyClientCall, PythonPack } from "./pack.js";

const hooksByPack = new WeakMap<PythonPack, readonly RequestRecognizer[]>();

/** The pack's request hooks: the ones it declared, then one per `clients` pattern. */
export function packRequestHooks(
  pack: PythonPack,
): readonly RequestRecognizer[] {
  let hooks = hooksByPack.get(pack);
  if (hooks === undefined) {
    hooks = [
      ...(pack.requestRecognizers ?? []),
      ...(pack.clients ?? []).flatMap(clientPatternHooks),
    ];
    hooksByPack.set(pack, hooks);
  }
  return hooks;
}

/**
 * A `clients` pattern as a request chain: the verb attributes and the
 * method call are the methods table, the module's own functions and a
 * receiver one of its constructors built are the client.
 */
function clientPatternHooks(
  pattern: PyClientCall,
): readonly RequestRecognizer[] {
  const url: OneArgument = {
    at: pattern.url.position,
    keyword: pattern.url.keyword,
  };
  const table: Record<string, RequestMethod> = Object.fromEntries(
    Object.entries(pattern.verbAttributeNames).map(([verb, sends]) => [
      verb,
      { sends, url },
    ]),
  );
  const call = pattern.methodCall;
  if (call !== undefined) {
    table[call.attribute] = {
      sends: {
        from: {
          at: call.methodPosition,
          ...(call.methodKeyword === undefined
            ? {}
            : { keyword: call.methodKeyword }),
        },
      },
      url: { at: call.urlPosition, keyword: pattern.url.keyword },
    };
  }
  const constructors = pattern.receiverConstructors ?? [];
  const client = anyOf(
    imported({
      from: pattern.importModule,
      named: ["*", ...Object.keys(table)],
    }),
    ...(constructors.length === 0
      ? []
      : [constructedFrom({ from: pattern.importModule, named: constructors })]),
  );
  return requestRecognizersOf([
    httpRequests({ client })
      .methods(table)
      .response(pattern.response ?? {}),
  ]);
}
