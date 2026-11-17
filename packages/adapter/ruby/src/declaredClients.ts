/**
 * The request hooks a pack gives this adapter's client walk, in groups
 * whose units come together, each in the order the file writes it.
 *
 * A pack declares its library's requests with `@suss/recognize`, as
 * `requestRecognizers`, and those are one group. A pack written before
 * that lists `clients` patterns instead, and each pattern is read here
 * as the chains that say the same thing, one group per pattern, so both
 * kinds of pack run through one reader. A pattern's calls on the
 * library's constant and its calls on a value one of its builders made
 * are two chains, since only a call on the constant takes a host apart
 * from the path.
 */

import {
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
} from "@suss/recognize";

import { CONSTRUCTOR } from "./facts/languageWords.js";

import type { RequestRecognizer } from "@suss/extractor";
import type {
  BaseUrlPick,
  HttpRequests,
  OneArgument,
  RequestMethod,
  UrlArgument,
} from "@suss/recognize";
import type { RbClientCall, RubyPack } from "./pack.js";

type HookGroups = readonly (readonly RequestRecognizer[])[];

const hooksByPack = new WeakMap<RubyPack, HookGroups>();

/** The pack's request hooks: the ones it declared, then each `clients` pattern's. */
export function packRequestHooks(pack: RubyPack): HookGroups {
  let groups = hooksByPack.get(pack);
  if (groups === undefined) {
    const declared = pack.requestRecognizers ?? [];
    groups = [
      ...(declared.length === 0 ? [] : [declared]),
      ...(pack.clients ?? []).map(clientPatternHooks),
    ];
    hooksByPack.set(pack, groups);
  }
  return groups;
}

/**
 * A `clients` pattern as request chains: the verbs and the method that
 * sends a request object are the methods table, on the constant and on
 * a value a builder made, and a builder's URL or host is the base.
 */
function clientPatternHooks(
  pattern: RbClientCall,
): readonly RequestRecognizer[] {
  const url: OneArgument = {
    at: pattern.url.position,
    ...(pattern.url.keyword === undefined
      ? {}
      : { keyword: pattern.url.keyword }),
  };
  const onConstant = httpRequests({
    client: imported({ from: [pattern.constantName], named: ["*"] }),
  }).methods(methodsOf(pattern, (name) => hostFirstAt(pattern, name, url)));
  const builders = pattern.receiverBuilders ?? [];
  const onBuilt =
    builders.length === 0
      ? null
      : httpRequests({
          client: constructedFrom({
            from: [pattern.constantName],
            named: builders.map((builder) =>
              builtName(builder, pattern.constantName),
            ),
          }),
        })
          .methods(methodsOf(pattern, () => url))
          .baseUrl(builtBase(pattern));
  const response = pattern.response ?? {};
  return requestRecognizersOf(
    [onConstant, ...(onBuilt === null ? [] : [onBuilt])].map(
      (chain: HttpRequests) => chain.response(response),
    ),
  );
}

/** The verbs, each taking its URL where `urlOf` says, and the method that sends a request object, which a verb of the same name wins over. */
function methodsOf(
  pattern: RbClientCall,
  urlOf: (name: string) => UrlArgument,
): Record<string, RequestMethod> {
  const sent = pattern.requestObject;
  return {
    ...(sent === undefined
      ? {}
      : {
          [sent.attribute]: {
            sends: {
              object: 0,
              classes: sent.constructors,
              url: { at: sent.urlPosition },
            },
          },
        }),
    ...Object.fromEntries(
      Object.entries(pattern.verbMethodNames).map(([name, sends]) => [
        name,
        { sends, url: urlOf(name) },
      ]),
    ),
  };
}

/** The URL a call on the constant states, with the host, path and port in its place for a method the pattern says takes them. */
function hostFirstAt(
  pattern: RbClientCall,
  name: string,
  url: OneArgument,
): UrlArgument {
  const form = pattern.hostThenPath;
  return form === undefined || !form.methods.includes(name)
    ? url
    : {
        ...url,
        hostFirst: {
          host: { at: form.host },
          path: { at: form.path },
          port: { at: form.port },
        },
      };
}

/**
 * The name a construction by one of the builders goes by: the class
 * itself for `new`, since `Net::HTTP.new` makes an `HTTP`, and the
 * builder's own name for any other.
 */
function builtName(builder: string, constantName: string): string {
  return builder === CONSTRUCTOR
    ? (constantName.split("::").at(-1) ?? constantName)
    : builder;
}

/** Where a builder states the base: a host and a port, or a URL under its keyword or first. */
function builtBase(pattern: RbClientCall): BaseUrlPick {
  const host = pattern.builderHost;
  if (host !== undefined) {
    return {
      at: host.host,
      reads: "host",
      port: { at: host.port },
      joins: "resolved",
    };
  }
  const keyword = pattern.builderUrlKeyword;
  return {
    at: 0,
    ...(keyword === undefined ? {} : { keyword }),
    joins: "resolved",
  };
}
