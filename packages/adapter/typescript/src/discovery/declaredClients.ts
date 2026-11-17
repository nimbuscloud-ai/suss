/**
 * declaredClients.ts: the request hooks a pack gives this adapter's
 * discovery. A pack declared with `@suss/recognize` lists them as
 * `requestRecognizers`. A pack written before that lists `clientCall`
 * patterns, and each one whose binding reads the request off the call is
 * read here as the chain that says the same thing. A pattern whose
 * binding reads a contract, or reads nothing, or that takes any method
 * on the client, keeps finding its calls through the client's origin in
 * clientCall.ts, and its binding is read where the adapter reads one.
 */

import {
  allOf,
  anyOf,
  constructedFrom,
  httpRequests,
  imported,
  requestRecognizersOf,
  returnedBy,
  spelled,
} from "@suss/recognize";

import type {
  BindingExtraction,
  DiscoveryPattern,
  PatternPack,
  ReceiverOrigin,
  RequestRecognizer,
} from "@suss/extractor";
import type { HttpRequests, OneArgument, RequestMethod } from "@suss/recognize";
import type { PackRequestHook } from "./requestCalls.js";

type ClientCallMatch = Extract<
  DiscoveryPattern["match"],
  { type: "clientCall" }
>;

/** The objects a global is reachable through, in a browser or in Node. */
const RUNTIME_GLOBALS = ["globalThis", "window", "self", "global"];

/** What a pack says about its requests beyond its discovery patterns. */
export type RequestsOfPack = Pick<
  PatternPack,
  "requestRecognizers" | "redirectOption"
>;

/** The request hooks the pack declared, each giving its units in the order its table lists its methods. */
export function declaredRequestHooks(
  pack: RequestsOfPack | undefined,
): readonly PackRequestHook[] {
  return (pack?.requestRecognizers ?? []).map((hook) => ({
    hook,
    ranked: true,
  }));
}

/** The hook each pattern compiles to, per pack, since two packs can share a pattern and name different redirect options. */
const hooksByPack = new WeakMap<
  object,
  WeakMap<DiscoveryPattern, RequestRecognizer | null>
>();
const NO_PACK = {};

/** The pattern read as a request chain, or null for one a chain cannot say. */
export function patternRequestHook(
  pattern: DiscoveryPattern,
  pack: RequestsOfPack | undefined,
): RequestRecognizer | null {
  const owner = pack ?? NO_PACK;
  let hooks = hooksByPack.get(owner);
  if (hooks === undefined) {
    hooks = new WeakMap();
    hooksByPack.set(owner, hooks);
  }
  const known = hooks.get(pattern);
  if (known !== undefined) {
    return known;
  }
  const read = requestPatternOf(pattern);
  const [hook = null] =
    read === null ? [] : requestRecognizersOf([chainOf(read, pack)]);
  hooks.set(pattern, hook);
  return hook;
}

/** A `clientCall` pattern the chain can say, with what each call sends and the names it is called by. */
interface RequestPattern {
  readonly match: ClientCallMatch;
  readonly meaning: RequestMethod;
  readonly names: readonly string[];
}

/**
 * The pattern as a chain can say it, or null for one whose binding reads
 * something other than the call, or that takes any method on the client.
 */
function requestPatternOf(pattern: DiscoveryPattern): RequestPattern | null {
  const { match, bindingExtraction: binding } = pattern;
  const meaning =
    match.type === "clientCall" && binding !== undefined
      ? meaningOf(binding)
      : null;
  if (match.type !== "clientCall" || meaning === null) {
    return null;
  }
  const names =
    match.importModule === "global" ? [match.importName] : match.methodFilter;
  return names === undefined ? null : { match, meaning, names };
}

/**
 * A `clientCall` pattern as a request chain: the methods it lists, or
 * the global's own name, send the request its binding reads off the
 * call, and a client it says is callable sends one when called.
 */
function chainOf(
  { match, meaning, names }: RequestPattern,
  pack: RequestsOfPack | undefined,
): HttpRequests {
  const methods = httpRequests({ client: clientOriginOf(match) }).methods(
    Object.fromEntries(names.map((name) => [name, meaning])),
  );
  const called = match.callable === true ? methods.calls(meaning) : methods;
  const based =
    match.basePathOption === undefined
      ? called
      : called.baseUrl({
          at: 0,
          property: [match.basePathOption],
          joins: "appended",
        });
  return pack?.redirectOption === undefined
    ? based
    : based.response({ redirectOption: pack.redirectOption });
}

/** What the binding says one call sends, or null for a binding read off something other than the call. */
function meaningOf(binding: BindingExtraction): RequestMethod | null {
  const url = argumentOf(binding.path);
  const sends = sendsOf(binding.method);
  if (url === null || sends === null) {
    return null;
  }
  const options =
    binding.options === undefined
      ? {}
      : { options: { at: binding.options.position } };
  return { sends, url, ...options } as RequestMethod;
}

function argumentOf(path: BindingExtraction["path"]): OneArgument | null {
  if (path.type === "fromArgument") {
    return { at: path.position };
  }
  return path.type === "fromArgumentProperty"
    ? { at: path.position, property: [path.property] }
    : null;
}

function sendsOf(
  method: BindingExtraction["method"],
): RequestMethod["sends"] | null {
  if (method.type === "literal") {
    return method.value;
  }
  if (method.type !== "fromArgumentProperty") {
    return null;
  }
  return {
    from: { at: method.position, property: [method.property] },
    ...(method.default === undefined ? {} : { default: method.default }),
  };
}

/**
 * Where a `clientCall` pattern's client comes from: a global by its name,
 * or else the import itself, what it constructs when called, and what
 * each factory method returns. The import called on directly counts as
 * a default import only under the pattern's own name, `axios.get(url)`,
 * while a call that builds an instance can name it anything.
 */
export function clientOriginOf(match: ClientCallMatch): ReceiverOrigin {
  if (match.importModule === "global") {
    return anyOf(spelled(match.importName), spelled(...RUNTIME_GLOBALS));
  }
  const from = [match.importModule];
  const named = [match.importName, "default"];
  const anyName = imported({ from, named });
  return anyOf(
    imported({ from, named: [match.importName] }),
    allOf(spelled(match.importName), imported({ from, named: ["default"] })),
    constructedFrom({ from, named }),
    ...(match.factoryMethods ?? []).map((method) =>
      returnedBy(method, anyName),
    ),
  );
}
