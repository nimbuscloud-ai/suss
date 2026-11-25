/**
 * Turns a request chain into the hook an adapter's client walk calls on
 * every call it visits.
 *
 * The hook asks its questions in the order of their cost. A method call
 * is looked up in the methods table before anything asks where its
 * receiver came from, and a bare call by the name it is written with, or
 * the export its own import statement binds, before anything asks where
 * its callee came from. Most calls in a body are neither, so they cost a
 * lookup. Where the receiver came from is asked of what its own import
 * statement and the value it was written as say first, and of the rules
 * only for a receiver those leave open. DESIGN.md describes the reading.
 */

import { hasNameHole } from "@suss/behavioral-ir";
import { redirectDeliveryWhenSet } from "@suss/extractor";
import { statedRequestPath } from "@suss/values";

import { NOTHING_STATED, statedValue } from "./compile.js";
import { linkIn } from "./compileReads.js";
import {
  hostBase,
  NOWHERE,
  requestTargetPath,
  urlOrHostFirst,
  urlReadingOf,
} from "./httpRequestsHost.js";
import { modulesOf, opsIn } from "./ops.js";
import {
  alternativeClaims,
  lacking,
  type Reading,
} from "./requestAlternatives.js";

import type {
  ArgumentPlace,
  ClientResponse,
  RequestClaim,
  RequestRead,
  RequestRecognizer,
  StatedRequest,
  UrlTarget,
} from "@suss/extractor";
import type {
  BaseJoin,
  BaseUrlLink,
  CallsLink,
  Chain,
  HttpRequestEnding,
  MethodMeaning,
  MethodsLink,
  OneArgument,
  RequestMethod,
  StartLink,
} from "./chain.js";
import type { UrlReading } from "./httpRequestsHost.js";
import type { CallOps, ReceiverOrigin, ValueOps } from "./ops.js";

/** A request chain's links, picked out once when it compiles. */
interface Requesting {
  readonly client: ReceiverOrigin;
  /** The modules the client comes from, which a bare call's import is read against. */
  readonly modules: readonly string[];
  readonly table: Readonly<Record<string, RequestMethod>>;
  readonly calls: RequestMethod | null;
  /** The table entry a call of the client itself reads as, when one has the same meaning. */
  readonly callsEntry: string | null;
  readonly base: BaseUrlLink | null;
  readonly response: ClientResponse;
}

/** What the table says one call sends, and the entry that says it. */
interface Matched {
  readonly meaning: RequestMethod;
  readonly entry: string | null;
}

/** A request chain, as the hook an adapter's client walk dispatches to. */
export function compileRequests(
  chain: Chain<MethodMeaning>,
): RequestRecognizer {
  const requesting = requestingOf(chain);
  const hook = (_call: unknown, ctx: unknown): RequestClaim[] | null => {
    const ops = opsIn(ctx);
    const matched = ops === null ? null : meaningAt(requesting, ops);
    return ops === null || matched === null
      ? null
      : claimsAt(requesting, matched, ops);
  };
  const defaultBase = requesting.base?.defaults;
  return Object.assign(hook, {
    response: requesting.response,
    entries: Object.keys(requesting.table),
    ...(defaultBase === undefined ? {} : { defaultBase }),
  });
}

function requestingOf(chain: Chain<MethodMeaning>): Requesting {
  const start = linkIn<StartLink>(chain.links, "start");
  if (start === null) {
    throw new Error("a request chain needs the client its calls are made on");
  }
  const methods = linkIn<MethodsLink<RequestMethod>>(chain.links, "methods");
  const calls = linkIn<CallsLink<RequestMethod>>(chain.links, "calls");
  const table = methods?.table ?? {};
  const meaning = calls?.meaning ?? null;
  return {
    client: start.at.origin,
    modules: modulesOf(start.at.origin),
    table,
    calls: meaning,
    callsEntry:
      Object.keys(table).find((entry) => table[entry] === meaning) ?? null,
    base: linkIn<BaseUrlLink>(chain.links, "baseUrl"),
    response: (chain.ending as HttpRequestEnding).response,
  };
}

/** What the table says the call sends, once the client is known to have made it, or null. */
function meaningAt(requesting: Requesting, ops: CallOps): Matched | null {
  const method = ops.method();
  if (method === null) {
    return bareMeaning(requesting, ops);
  }
  const meaning = listedIn(requesting.table, method);
  return meaning !== null && receiverFrom(requesting.client, ops)
    ? { meaning, entry: method }
    : null;
}

/**
 * A call with no receiver: one of the client's functions, imported by
 * name, or the client called as a function. A callee the table does not
 * list as written or as imported is asked about only when the chain says
 * what a call of the client itself sends.
 */
function bareMeaning(requesting: Requesting, ops: CallOps): Matched | null {
  const written = ops.calleeImport?.(requesting.modules) ?? ops.calleeText();
  if (
    listedIn(requesting.table, written) !== null &&
    calleeFrom(requesting.client, ops)
  ) {
    const exported =
      ops.calleeImportedAs?.(requesting.modules) ?? ops.calleeText();
    const listed = listedIn(requesting.table, exported);
    return listed === null
      ? callsMatched(requesting)
      : { meaning: listed, entry: exported };
  }
  return requesting.calls !== null && callsClient(requesting.client, ops)
    ? callsMatched(requesting)
    : null;
}

/** What a call of the client itself sends, or null for a chain that says nothing about one. */
function callsMatched(requesting: Requesting): Matched | null {
  return requesting.calls === null
    ? null
    : { meaning: requesting.calls, entry: requesting.callsEntry };
}

/** Whether the callee came from the client, or was written as a call that did, as `api` after `api = axios.create()`. */
function callsClient(client: ReceiverOrigin, ops: CallOps): boolean {
  return calleeFrom(client, ops) || ops.callee()?.isFrom(client) === true;
}

/**
 * Whether the receiver came from the client. Each origin is asked what
 * the receiver's import statement and written value say before any is
 * asked of the rules, since those settle most receivers, and the first
 * one that says yes stops the rest. An adapter that finds client calls
 * of its own asks this too, so both find the same receivers.
 */
export function receiverFrom(client: ReceiverOrigin, ops: CallOps): boolean {
  return settledFirst(
    client,
    (origin) => receiverSettled(origin, ops),
    (origin) => ops.receiverIsFrom(origin),
  );
}

/**
 * Whether a call with no receiver goes to the client, asked of the
 * callee the way `receiverFrom` asks of a receiver. A request walk asks
 * this of every such call in a file, and nearly every callee is settled
 * by its own import statement.
 */
function calleeFrom(client: ReceiverOrigin, ops: CallOps): boolean {
  return settledFirst(
    client,
    (origin) =>
      origin.origin === "imported"
        ? ops.calleeSettledFrom?.(origin)
        : undefined,
    (origin) => ops.isFrom(origin),
  );
}

/** Whether one of the client's origins says yes, the open ones asked of the rules only after every origin's statements are read. */
function settledFirst(
  client: ReceiverOrigin,
  settled: (origin: ReceiverOrigin) => boolean | undefined,
  asked: (origin: ReceiverOrigin) => boolean,
): boolean {
  const open: ReceiverOrigin[] = [];
  for (const origin of originsOf(client)) {
    const said = settled(origin);
    if (said === true) {
      return true;
    }
    if (said === undefined) {
      open.push(origin);
    }
  }
  return open.some(asked);
}

/** The origins a client lists, with an `anyOf` inside another read as its own origins. */
function originsOf(client: ReceiverOrigin): readonly ReceiverOrigin[] {
  return client.origin === "anyOf" ? client.of.flatMap(originsOf) : [client];
}

/** What the receiver's own import statement and written value say about the origin, or undefined when they leave it open. */
function receiverSettled(
  origin: ReceiverOrigin,
  ops: CallOps,
): boolean | undefined {
  return origin.origin === "imported" || origin.origin === "constructed"
    ? ops.receiverSettledFrom?.(origin)
    : undefined;
}

/** What the table lists under the name, and nothing an object inherits. */
function listedIn(
  table: Readonly<Record<string, RequestMethod>>,
  name: string,
): RequestMethod | null {
  return Object.hasOwn(table, name) ? (table[name] ?? null) : null;
}

/**
 * The requests the call makes. A URL the enclosing class takes in its
 * constructor can differ between constructions, so when the call's own
 * reading leaves a hole, each construction gives a request of its own.
 */
function claimsAt(
  requesting: Requesting,
  matched: Matched,
  ops: CallOps,
): RequestClaim[] {
  const reading = readingOf(requesting, matched, ops, undefined);
  const alternatives = lacking(reading)
    ? alternativeClaims(ops, reading, (under) =>
        readingOf(requesting, matched, under, undefined),
      )
    : null;
  if (alternatives !== null) {
    return alternatives;
  }
  const plain = reading?.claim ?? null;
  if (plain !== null && plain.path !== null && !hasNameHole(plain.path)) {
    return [plain];
  }
  // Two constructions with the same method and path give one request,
  // since the boundary is the same for both. The request with no path is
  // the one left when no construction says where it goes.
  const byBoundary = new Map<string, RequestClaim>();
  for (const site of ops.constructionSites?.() ?? []) {
    const stated = claimOf(requesting, matched, ops, site);
    if (stated === null || stated.path === null) {
      continue;
    }
    const key = `${stated.method} ${stated.host ?? ""} ${stated.path}`;
    if (!byBoundary.has(key)) {
      byBoundary.set(key, { ...stated, site });
    }
  }
  if (byBoundary.size > 0) {
    return [...byBoundary.values()];
  }
  return plain === null ? [] : [plain];
}

/**
 * The one request the call makes under the construction at `site`, or
 * null when the method or the URL argument is missing, or when the URL
 * is one the client reads without a request.
 */
function claimOf(
  requesting: Requesting,
  matched: Matched,
  ops: CallOps,
  site: string | undefined,
): RequestClaim | null {
  return readingOf(requesting, matched, ops, site)?.claim ?? null;
}

function readingOf(
  requesting: Requesting,
  { meaning, entry }: Matched,
  ops: CallOps,
  site: string | undefined,
): Reading | null {
  const sent = sentBy(meaning, ops, site);
  const own = sent === null ? null : sent.url(site);
  if (sent === null || own === null || own.local === true) {
    return null;
  }
  // The construction is looked for only when the chain reads a base off
  // it, or when the call leaves the redirect option to it.
  let built: CallOps | null | undefined;
  const construction = (): CallOps | null => {
    built ??= constructionOf(ops);
    return built;
  };
  const based =
    requesting.base === null
      ? NO_BASE
      : baseOf(requesting.base, construction(), site);
  const { base } = based;
  const placed = underBase(base, own, sent.written);
  const redirectDelivery =
    redirectAt(requesting.response, meaning, ops, {
      built: construction,
      link: requesting.base,
    }) ?? meaning.redirects;
  const stated = statedRequest(sent, own, base);
  // An absolute URL replaces the base, so only a relative one leaves part unread.
  const baseUnread =
    based.unread ||
    (own.host === undefined && takesWrittenDefault(requesting, base, ops));
  const partUnread =
    own.tookDefault === true || (baseUnread && own.host === undefined);
  const claim: RequestClaim = {
    method: sent.method,
    path: placed.path,
    host: placed.host,
    ...(redirectDelivery === undefined ? {} : { redirectDelivery }),
    ...(partUnread ? { urlPartUnread: true as const } : {}),
    read: {
      entry,
      ...sent.read,
      ...("options" in meaning && meaning.options !== undefined
        ? { options: placeOf(meaning.options) }
        : {}),
      ...(base === null ? {} : { base: { ...base.url, joins: base.joins } }),
      ...(baseUnread ? { baseUnread: true as const } : {}),
      ...(stated === undefined ? {} : { stated }),
    },
  };
  return {
    claim,
    methodOpen: sent.methodOpen,
    methodGuessed: sent.methodGuessed,
  };
}

/**
 * Whether the call's client takes a base the program writes to the
 * library's defaults, as `axios.defaults.baseURL = url` sets one. The
 * client was built with no base of its own, and the write is made
 * through something the client comes from, such as the library itself.
 */
function takesWrittenDefault(
  requesting: Requesting,
  base: Base | null,
  ops: CallOps,
): boolean {
  const path = requesting.base?.defaults;
  if (path === undefined || base !== null) {
    return false;
  }
  return (ops.propertyWrites?.(path) ?? []).some((write) =>
    receiverFrom(requesting.client, write),
  );
}

/** The values the request's method and host came from, or undefined when the call states neither as a value. */
function statedRequest(
  sent: Sent,
  own: UrlTarget,
  base: Base | null,
): StatedRequest | undefined {
  const host = hostStated(sent, own, base);
  const { method } = sent.values;
  if (method === undefined && host === undefined) {
    return undefined;
  }
  return {
    ...(method === undefined ? {} : { method }),
    ...(host === undefined ? {} : { host }),
  };
}

/**
 * The value the host is read from: the call's own URL, unless the
 * request goes under the base its client was built with, as a path or a
 * URL suss cannot read does.
 */
function hostStated(
  sent: Sent,
  own: UrlTarget,
  base: Base | null,
): StatedRequest["host"] {
  if (base === null || own.host !== undefined) {
    const url = sent.values.url;
    return url === undefined ? undefined : { value: url, within: "url" };
  }
  return {
    value: base.stated,
    within: base.link.reads === "host" ? "host" : "url",
  };
}

/** What a call states its method and URL as, and where. */
interface Sent {
  readonly method: string | null;
  readonly url: UrlReading;
  /** The URL argument when it comes to one string, which is how an empty URL shows. */
  readonly written: () => string | null;
  readonly read: Pick<RequestRead, "url" | "method">;
  /** The values the call states the method and a URL with a host in it as. */
  readonly values: { readonly method?: ValueOps; readonly url?: ValueOps };
  /** As `Reading` says. */
  readonly methodOpen: boolean;
  readonly methodGuessed: boolean;
}

/** A method the table writes, or one read from a value that settled, is sure. */
const SURE = { methodOpen: false, methodGuessed: false } as const;

/**
 * The method the call sends and how it states the URL, or null when
 * either is missing. A request object kept on a field can differ between
 * the constructions at each `site`.
 */
function sentBy(
  meaning: RequestMethod,
  ops: CallOps,
  site: string | undefined,
): Sent | null {
  if ("url" in meaning) {
    const urlValue = urlArgument(ops, meaning.url);
    const url = urlOrHostFirst(ops, urlValue, meaning.url.hostFirst);
    const written = writtenOf(urlValue);
    const { sends } = meaning;
    const urlPlace = placeOf(meaning.url);
    // A host passed on its own beside the path is not inside this URL.
    const hostIn = meaning.url.hostFirst === undefined ? urlValue : null;
    if (typeof sends === "string") {
      return withUrl(sends, url, written, {
        read: { url: urlPlace, method: sends },
        values: valuesOf(null, hostIn),
        ...SURE,
      });
    }
    // A method the call states and suss cannot settle sends the default
    // too, so the request is kept with the method the library sends most.
    const stated = statedValue(ops, sends.from);
    const settled = stated === null ? null : stringOf(stated);
    const method = settled ?? sends.default ?? null;
    if (method === null && !passedIn(stated, ops)) {
      return null;
    }
    return withMethodAndUrl(method?.toUpperCase() ?? null, url, written, {
      read: {
        url: urlPlace,
        method: {
          at: placeOf(sends.from),
          ...(sends.default === undefined ? {} : { default: sends.default }),
        },
      },
      values: valuesOf(stated, hostIn),
      methodOpen: stated !== null && settled === null,
      methodGuessed:
        settled === null &&
        method !== null &&
        (stated !== null || optionsUnread(ops, sends.from)),
    });
  }
  const { sends } = meaning;
  const built = madeBy(ops.valueAt(sends.object), site, () =>
    ops.argument(sends.object),
  );
  if (built === null || built.method() !== "new") {
    return null;
  }
  const written = built.calleeText();
  const requestClass = written.slice(0, written.length - ".new".length);
  const method = sends.classes[requestClass] ?? null;
  const urlValue = urlArgument(built, sends.url);
  return withUrl(method, urlReadingOf(urlValue), writtenOf(urlValue), {
    read: { url: { at: sends.object }, method: method ?? "" },
    values: valuesOf(null, urlValue),
    ...SURE,
  });
}

/**
 * Whether the call passes the object the method is read from and suss
 * cannot read that object in full, so it may set a method suss did not
 * see.
 */
function optionsUnread(ops: CallOps, pick: OneArgument): boolean {
  if (pick.property === undefined) {
    return false;
  }
  const passed = ops.valueAt(pick.at);
  return passed !== null && (passed.object?.() ?? null) === null;
}

function valuesOf(
  method: ValueOps | null,
  url: ValueOps | null,
): Sent["values"] {
  return {
    ...(method === null ? {} : { method }),
    ...(url === null ? {} : { url }),
  };
}

/** The string a URL argument comes to, read only when a base asks. */
function writtenOf(value: ValueOps | null): () => string | null {
  return () => (value === null ? null : stringOf(value));
}

/** Where a pick reads an argument, as a claim says it. */
function placeOf(pick: OneArgument): ArgumentPlace {
  return {
    at: pick.at,
    ...(pick.keyword === undefined ? {} : { keyword: pick.keyword }),
    ...(pick.property === undefined ? {} : { property: pick.property }),
  };
}

/**
 * The value the call states the URL as. A URL a `*args` fills, or one a
 * `**kwargs` could pass under its keyword, is a URL suss cannot read, so
 * the call still makes a request, with no path. So is the URL property
 * of an options object suss cannot read, as `api({ ...config })`.
 */
function urlArgument(ops: CallOps, pick: OneArgument): ValueOps | null {
  const stated = statedValue(ops, pick);
  if (stated !== null || pick.of !== undefined) {
    return stated;
  }
  if (pick.property !== undefined && ops.valueAt(pick.at) !== null) {
    return UNREAD;
  }
  return splatMayFill(ops, pick) ? UNREAD : null;
}

/** Whether a `*args` or a `**kwargs` the call passes can fill the place `pick` reads. */
function splatMayFill(ops: CallOps, pick: OneArgument): boolean {
  const splats = ops.splats?.();
  const from = splats?.positionalFrom ?? null;
  const positional = from !== null && from <= pick.at;
  const keyword = splats?.keywords === true && pick.keyword !== undefined;
  return positional || keyword;
}

/** A URL argument suss cannot read, which reads as no URL at all. */
const UNREAD: ValueOps = { ...NOTHING_STATED, url: () => NOWHERE };

/** What a call states, apart from its method and URL. */
type Stated = Pick<Sent, "read" | "values" | "methodOpen" | "methodGuessed">;

function withUrl(
  method: string | null,
  url: UrlReading | null,
  written: Sent["written"],
  stated: Stated,
): Sent | null {
  return method === null
    ? null
    : withMethodAndUrl(method, url, written, stated);
}

/** The request, with a null method when the method is one the caller passes and nothing settles. */
function withMethodAndUrl(
  method: string | null,
  url: UrlReading | null,
  written: Sent["written"],
  stated: Stated,
): Sent | null {
  return url === null ? null : { method, url, written, ...stated };
}

/**
 * Whether the value is one of the parameters of the function the call
 * is written in. A request whose method is such a parameter still goes
 * out with whatever method each caller passes.
 */
function passedIn(value: ValueOps | null, ops: CallOps): boolean {
  const body = ops.enclosingBody?.() ?? null;
  return (
    value !== null &&
    body !== null &&
    (value.parameterNamed?.(body) ?? null) !== null
  );
}

/**
 * The call a value was made by, through everything the adapter's rules
 * say it was written as, a call into one of the project's own methods
 * included, and under the construction at `site` when one is given.
 * `otherwise` reads it where the adapter cannot say.
 */
function madeBy(
  value: ValueOps | null,
  site: string | undefined,
  otherwise: () => CallOps | null,
): CallOps | null {
  if (value?.asCall === undefined) {
    return otherwise();
  }
  return value.asCall(
    site === undefined
      ? { follow: "writtenAs" }
      : { follow: "writtenAs", site },
  );
}

/** The string a value comes to, or null for anything else. */
function stringOf(value: ValueOps): string | null {
  const evaluated = value.evaluated?.() ?? null;
  return typeof evaluated === "string" ? evaluated : null;
}

/**
 * The construction the client the call is made on was made by, or null
 * when it is not one: the receiver's, or for the client called as a
 * function, the callee's, as `api(config)` after `api = axios.create()`.
 */
function constructionOf(ops: CallOps): CallOps | null {
  if (ops.method() === null) {
    return ops.callee();
  }
  return madeBy(ops.receiverValue?.() ?? null, undefined, () => ops.receiver());
}

/**
 * The base URL the receiver's construction states, or null when the
 * chain doesn't read one or the receiver is not a construction. A base
 * appended to has a hole only when the program works it out at runtime,
 * and a guess in front of every path would move each to a route nobody
 * serves, so its path is left out and its host kept.
 *
 * `unread` is set when the construction states a base suss did not read
 * in full and the call's path leaves it out: a base left out as above,
 * one that took a fallback's default, one refused because its path ends
 * in a hole, and one in an options object suss cannot read.
 */
function baseOf(
  link: BaseUrlLink,
  built: CallOps | null,
  site: string | undefined,
): BaseRead {
  if (built === null) {
    return NO_BASE;
  }
  const stated = statedValue(built, link.at);
  if (stated === null) {
    const unread =
      optionsUnread(built, link.at) || splatMayFill(built, link.at);
    return { base: null, unread };
  }
  const url = BASE_READ[link.reads ?? "url"](built, link, site, stated);
  if (url === null) {
    return NO_BASE;
  }
  if (refusedBase(link, url)) {
    return { base: null, unread: endsInHole(url.path) };
  }
  const guessed =
    link.joins === "appended" &&
    url.path !== undefined &&
    hasNameHole(url.path);
  return {
    base: {
      url: guessed ? { path: undefined, host: url.host } : url,
      joins: link.joins,
      link,
      stated,
    },
    unread: guessed || url.tookDefault === true || nothingRead(url, stated),
  };
}

/** Whether a base gave neither a path nor a host, and is not the empty string, which gives neither too. */
function nothingRead(url: UrlTarget, stated: ValueOps): boolean {
  return (
    url.path === undefined &&
    url.host === undefined &&
    stated.evaluated?.() !== ""
  );
}

/** The base a construction gives its client, and whether suss left part of it out of the call's path. */
interface BaseRead {
  readonly base: Base | null;
  readonly unread: boolean;
}

const NO_BASE: BaseRead = { base: null, unread: false };

function endsInHole(path: string | undefined): boolean {
  return path?.endsWith("}") === true;
}

/** The base a client was built with, and the link that says how its library uses it. */
interface Base {
  readonly url: UrlTarget;
  readonly joins: BaseJoin;
  readonly link: BaseUrlLink;
  /** The value the construction states the base as. */
  readonly stated: ValueOps;
}

/**
 * Whether the library refuses the base, so the client is never built. A
 * path that ends in a hole may or may not end with `/` when it runs, and
 * it is refused too, since reading it either way would guess.
 */
function refusedBase(link: BaseUrlLink, url: UrlTarget): boolean {
  const path = url.path ?? "";
  return (
    link.trailingSlash === "required" && path !== "" && !path.endsWith("/")
  );
}

/** How a construction states its base: a URL, or a host with its port. */
const BASE_READ: Record<
  NonNullable<BaseUrlLink["reads"]> | "url",
  (
    built: CallOps,
    link: BaseUrlLink,
    site: string | undefined,
    stated: ValueOps,
  ) => UrlTarget | null
> = {
  url: (_built, _link, site, stated) => stated.url?.(site) ?? NOWHERE,
  host: hostBase,
};

/**
 * Where a call's own URL goes under its client's base. An absolute URL
 * replaces the base. A path that says nothing about where the request
 * goes is no path, and the base's path does not go in front of it.
 */
function underBase(
  base: Base | null,
  own: UrlTarget,
  written: Sent["written"],
): Pick<RequestClaim, "path" | "host"> {
  if (base === null) {
    return ownPlace(own);
  }
  if (own.host !== undefined) {
    const kept =
      base.link.schemeRelative === "path"
        ? schemeRelativeUnder(base, written())
        : null;
    return kept ?? ownPlace(own);
  }
  if (written() === "") {
    return { path: emptyPathUnder(base), host: base.url.host };
  }
  const ownPath =
    base.joins === "asWritten" ? requestTargetPath(own.path) : own.path;
  const path = statedRequestPath(ownPath, base.url.host);
  return {
    path:
      path === undefined ? null : JOINED[base.joins](base.url.path ?? "", path),
    host: base.url.host,
  };
}

/** Where a call's own URL goes when no base comes into it. */
function ownPlace(own: UrlTarget): Pick<RequestClaim, "path" | "host"> {
  return {
    path: statedRequestPath(own.path, own.host) ?? null,
    host: own.host,
  };
}

/**
 * Where a URL that starts with `//` goes on a library that reads it as
 * a path: after the base's path and a `/`, on the base's host. Null for
 * any other URL, which goes where it says.
 */
function schemeRelativeUnder(
  base: Base,
  written: string | null,
): Pick<RequestClaim, "path" | "host"> | null {
  if (written?.startsWith("//") !== true || base.url.path === undefined) {
    return null;
  }
  const directory = base.url.path.endsWith("/")
    ? base.url.path
    : `${base.url.path}/`;
  return {
    path: `${directory}${written.replace(/[?#].*$/, "")}`,
    host: base.url.host,
  };
}

/**
 * Where a call that passes an empty URL goes: to the base's path, ended
 * with `/` for a library that adds one. A client built on a host sends
 * the empty string as the request target, which Net::HTTP refuses.
 */
function emptyPathUnder(base: Base): string | null {
  if (base.link.reads === "host" || base.url.path === undefined) {
    return null;
  }
  const path = base.url.path === "" ? "/" : base.url.path;
  return base.link.trailingSlash === "added" && !path.endsWith("/")
    ? `${path}/`
    : path;
}

const JOINED: Record<BaseJoin, (base: string, path: string) => string> = {
  appended: appendedPath,
  resolved: resolvedPath,
  asWritten: asWrittenPath,
};

/**
 * `path` under `base` the way the library joins them, for an adapter
 * that puts a request it read again under the base a claim reports.
 */
export function joinedPath(
  joins: BaseJoin,
  base: string,
  path: string,
): string {
  return JOINED[joins](base, path);
}

/**
 * `path` after `base` with one slash between, under a base of `/` too,
 * with dot segments removed, since httpx and axios both parse the joined
 * URL. A path that starts with a hole under a base with no path keeps
 * the hole in front, since pairing reads it as the base URL.
 */
function appendedPath(base: string, path: string): string {
  const prefix = base.replace(/\/+$/, "");
  if (path.startsWith("/")) {
    return withoutDotSegmentsAfterHole(`${prefix}${path}`);
  }
  if (prefix === "" && OPENING_HOLE.test(path)) {
    return withoutDotSegmentsAfterHole(path);
  }
  return withoutDotSegmentsAfterHole(`${prefix}/${path}`);
}

/** The path the call writes, to the base's host, whatever the base's path. */
function asWrittenPath(_base: string, path: string): string {
  return path;
}

// Pairing reads a hole at the front of a path as the base URL.
const OPENING_HOLE = /^(\{[^{}]+\})(.*)$/;

const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;

/** The path with its dot segments removed after any hole at its front, and as it is when it has none. */
function withoutDotSegmentsAfterHole(path: string): string {
  if (!DOT_SEGMENT.test(path)) {
    return path;
  }
  const opening = OPENING_HOLE.exec(path);
  if (opening !== null) {
    return `${opening[1]}${withoutDotSegmentsAfterHole(opening[2] ?? "")}`;
  }
  return withoutDotSegments(path);
}

/**
 * `path` resolved against `base` the way RFC 3986 resolves a reference:
 * a path that starts with `/` replaces the base's path, and any other
 * goes after the base's last segment. A hole at the front of the base is
 * the base URL, which stays in front either way.
 */
function resolvedPath(base: string, path: string): string {
  const opening = OPENING_HOLE.exec(base);
  if (opening !== null) {
    return `${opening[1]}${resolvedPath(opening[2] ?? "", path)}`;
  }
  if (path.startsWith("/")) {
    return withoutDotSegments(path);
  }
  const directory = base.endsWith("/") ? base : `${base}/`;
  return withoutDotSegments(directory + path);
}

/** The path with each `.` dropped and each `..` taken back one segment, as RFC 3986 does. */
function withoutDotSegments(path: string): string {
  const segments = path.replace(/^\//, "").split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      kept.pop();
    } else if (segment !== ".") {
      kept.push(segment);
    }
  }
  const last = segments.at(-1);
  if (last === "." || last === "..") {
    kept.push("");
  }
  return `/${kept.join("/")}`;
}

/** The construction the client was made by, looked for when asked, and where the chain reads its base off it. */
interface Construction {
  readonly built: () => CallOps | null;
  readonly link: BaseUrlLink | null;
}

/**
 * What the call does with a redirect when it, or else the construction
 * its client was made by, sets the client's redirect option to a value
 * that settles: `fetch(url, { redirect: "manual" })`, or
 * `axios.create({ maxRedirects: 0 })` for every call on the instance.
 */
function redirectAt(
  response: ClientResponse,
  meaning: RequestMethod,
  ops: CallOps,
  construction: Construction,
): RequestClaim["redirectDelivery"] {
  const option = response.redirectOption;
  if (option === undefined) {
    return undefined;
  }
  const value = optionSet(option.name, meaning, ops, construction);
  return value === undefined || value === null
    ? undefined
    : redirectDeliveryWhenSet(option, value);
}

type Setting = string | number | boolean | null | undefined;

/**
 * The value the call sets an option to: as a keyword, or as a property
 * of the options object the method takes. Undefined when the call leaves
 * the option out, and null when it passes something suss cannot read.
 * For a method that takes an options object, an option the call leaves
 * out is read off the client's construction, in the object it is built
 * with: the one it states its base in, or else its first argument.
 */
function optionSet(
  name: string,
  meaning: RequestMethod,
  ops: CallOps,
  { built, link }: Construction,
): Setting {
  const keyword = ops.keywordAt?.(name) ?? null;
  if (keyword !== null) {
    return keyword.evaluated?.() ?? null;
  }
  const pick = "options" in meaning ? meaning.options : undefined;
  if (pick === undefined) {
    return undefined;
  }
  const atCall = settingIn(statedValue(ops, pick), name);
  const made = atCall === undefined ? built() : null;
  return made === null
    ? atCall
    : settingIn(statedValue(made, { at: link?.at.at ?? 0 }), name);
}

/** What an options object sets the option to, as `optionSet` reads it. */
function settingIn(options: ValueOps | null, name: string): Setting {
  if (options === null) {
    return undefined;
  }
  const held = options.property(name);
  if (held !== null) {
    return held.evaluated?.() ?? null;
  }
  // An object suss reads in full leaves the option out. Anything else,
  // a parameter or a call suss cannot follow, could set it.
  return options.object?.() === null ? null : undefined;
}
