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

import { statedValue } from "./compile.js";
import { linkIn } from "./compileReads.js";
import { modulesOf, opsIn } from "./ops.js";

import type {
  ClientResponse,
  RequestClaim,
  RequestRecognizer,
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
  RequestMethod,
  StartLink,
} from "./chain.js";
import type { CallOps, ReceiverOrigin, ValueOps } from "./ops.js";

/** A request chain's links, picked out once when it compiles. */
interface Requesting {
  readonly client: ReceiverOrigin;
  /** The modules the client comes from, which a bare call's import is read against. */
  readonly modules: readonly string[];
  readonly table: Readonly<Record<string, RequestMethod>>;
  readonly calls: RequestMethod | null;
  readonly base: BaseUrlLink | null;
  readonly response: ClientResponse;
}

/** A request chain, as the hook an adapter's client walk dispatches to. */
export function compileRequests(
  chain: Chain<MethodMeaning>,
): RequestRecognizer {
  const requesting = requestingOf(chain);
  const hook = (_call: unknown, ctx: unknown): RequestClaim[] | null => {
    const ops = opsIn(ctx);
    const meaning = ops === null ? null : meaningAt(requesting, ops);
    return ops === null || meaning === null
      ? null
      : claimsAt(requesting, meaning, ops);
  };
  return Object.assign(hook, { response: requesting.response });
}

function requestingOf(chain: Chain<MethodMeaning>): Requesting {
  const start = linkIn<StartLink>(chain.links, "start");
  if (start === null) {
    throw new Error("a request chain needs the client its calls are made on");
  }
  const methods = linkIn<MethodsLink<RequestMethod>>(chain.links, "methods");
  const calls = linkIn<CallsLink<RequestMethod>>(chain.links, "calls");
  return {
    client: start.at.origin,
    modules: modulesOf(start.at.origin),
    table: methods?.table ?? {},
    calls: calls?.meaning ?? null,
    base: linkIn<BaseUrlLink>(chain.links, "baseUrl"),
    response: (chain.ending as HttpRequestEnding).response,
  };
}

/** What the table says the call sends, once the client is known to have made it, or null. */
function meaningAt(requesting: Requesting, ops: CallOps): RequestMethod | null {
  const method = ops.method();
  if (method === null) {
    return bareMeaning(requesting, ops);
  }
  const meaning = listedIn(requesting.table, method);
  return meaning !== null && receiverFrom(requesting.client, ops)
    ? meaning
    : null;
}

/**
 * A call with no receiver: one of the client's functions, imported by
 * name, or the client called as a function. A callee the table does not
 * list as written or as imported is asked about only when the chain says
 * what a call of the client itself sends.
 */
function bareMeaning(
  requesting: Requesting,
  ops: CallOps,
): RequestMethod | null {
  const written = ops.calleeImport?.(requesting.modules) ?? ops.calleeText();
  if (
    listedIn(requesting.table, written) !== null &&
    ops.isFrom(requesting.client)
  ) {
    const exported =
      ops.calleeImportedAs?.(requesting.modules) ?? ops.calleeText();
    return listedIn(requesting.table, exported) ?? requesting.calls;
  }
  return requesting.calls !== null && callsClient(requesting.client, ops)
    ? requesting.calls
    : null;
}

/** Whether the callee came from the client, or was written as a call that did, as `api` after `api = axios.create()`. */
function callsClient(client: ReceiverOrigin, ops: CallOps): boolean {
  return ops.isFrom(client) || ops.callee()?.isFrom(client) === true;
}

/**
 * Whether the receiver came from the client. Each origin is asked what
 * the receiver's import statement and written value say before any is
 * asked of the rules, since those settle most receivers, and the first
 * one that says yes stops the rest.
 */
function receiverFrom(client: ReceiverOrigin, ops: CallOps): boolean {
  const origins = client.origin === "anyOf" ? client.of : [client];
  const open: ReceiverOrigin[] = [];
  for (const origin of origins) {
    const settled = settledFrom(origin, ops);
    if (settled === true) {
      return true;
    }
    if (settled === undefined) {
      open.push(origin);
    }
  }
  return open.some((origin) => ops.receiverIsFrom(origin));
}

/** What the receiver's own import statement and written value say about the origin, or undefined when they leave it open. */
function settledFrom(
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
  meaning: RequestMethod,
  ops: CallOps,
): RequestClaim[] {
  const plain = claimOf(requesting, meaning, ops, undefined);
  if (plain !== null && plain.path !== null && !hasNameHole(plain.path)) {
    return [plain];
  }
  // Two constructions with the same method and path give one request,
  // since the boundary is the same for both. The request with no path is
  // the one left when no construction says where it goes.
  const byBoundary = new Map<string, RequestClaim>();
  for (const site of ops.constructionSites?.() ?? []) {
    const stated = claimOf(requesting, meaning, ops, site);
    if (stated === null || stated.path === null) {
      continue;
    }
    const key = `${stated.method} ${stated.host ?? ""} ${stated.path}`;
    if (!byBoundary.has(key)) {
      byBoundary.set(key, stated);
    }
  }
  if (byBoundary.size > 0) {
    return [...byBoundary.values()];
  }
  return plain === null ? [] : [plain];
}

/** The one request the call makes under the construction at `site`, or null when the method or the URL argument is missing. */
function claimOf(
  requesting: Requesting,
  meaning: RequestMethod,
  ops: CallOps,
  site: string | undefined,
): RequestClaim | null {
  const sent = sentBy(meaning, ops);
  if (sent === null) {
    return null;
  }
  const own = sent.url.url?.(site) ?? NOWHERE;
  const placed = underBase(baseOf(requesting.base, ops, site), own);
  const redirectDelivery =
    redirectAt(requesting.response, ops) ?? meaning.redirects;
  return {
    method: sent.method,
    path: placed.path,
    host: placed.host,
    ...(redirectDelivery === undefined ? {} : { redirectDelivery }),
  };
}

/** A URL the adapter cannot read. */
const NOWHERE: UrlTarget = { path: undefined, host: undefined };

/** The method the call sends and the value it states the URL as, or null when either is missing. */
function sentBy(
  meaning: RequestMethod,
  ops: CallOps,
): { method: string; url: ValueOps } | null {
  if ("url" in meaning) {
    const url = statedValue(ops, meaning.url);
    const { sends } = meaning;
    if (typeof sends === "string") {
      return withUrl(sends, url);
    }
    const stated = statedValue(ops, sends.from);
    const method = stated === null ? (sends.default ?? null) : stringOf(stated);
    return withUrl(method?.toUpperCase() ?? null, url);
  }
  const { sends } = meaning;
  const built = ops.argument(sends.object);
  if (built === null || built.method() !== "new") {
    return null;
  }
  const written = built.calleeText();
  const requestClass = written.slice(0, written.length - ".new".length);
  return withUrl(
    sends.classes[requestClass] ?? null,
    statedValue(built, sends.url),
  );
}

function withUrl(
  method: string | null,
  url: ValueOps | null,
): { method: string; url: ValueOps } | null {
  return method === null || url === null ? null : { method, url };
}

/** The string a value comes to, or null for anything else. */
function stringOf(value: ValueOps): string | null {
  const evaluated = value.evaluated?.() ?? null;
  return typeof evaluated === "string" ? evaluated : null;
}

/** The base URL the receiver's construction states, or null when the chain doesn't read one or the receiver is not a construction. */
function baseOf(
  link: BaseUrlLink | null,
  ops: CallOps,
  site: string | undefined,
): { url: UrlTarget; joins: BaseJoin } | null {
  const built = link === null ? null : ops.receiver();
  const stated =
    link === null || built === null ? null : statedValue(built, link.at);
  if (link === null || stated === null) {
    return null;
  }
  return { url: stated.url?.(site) ?? NOWHERE, joins: link.joins };
}

/**
 * Where a call's own URL goes under its client's base. An absolute URL
 * replaces the base. A path that says nothing about where the request
 * goes is no path, and the base's path does not go in front of it.
 */
function underBase(
  base: { url: UrlTarget; joins: BaseJoin } | null,
  own: UrlTarget,
): Pick<RequestClaim, "path" | "host"> {
  if (base === null || own.host !== undefined) {
    return {
      path: statedRequestPath(own.path, own.host) ?? null,
      host: own.host,
    };
  }
  const path = statedRequestPath(own.path, base.url.host);
  return {
    path:
      path === undefined ? null : JOINED[base.joins](base.url.path ?? "", path),
    host: base.url.host,
  };
}

const JOINED: Record<BaseJoin, (base: string, path: string) => string> = {
  appended: appendedPath,
  resolved: resolvedPath,
};

/** `path` after `base` with one slash between. A base of `/` says nothing about where the request goes. */
function appendedPath(base: string, path: string): string {
  const prefix = base.replace(/\/+$/, "");
  if (prefix === "") {
    return path;
  }
  return path.startsWith("/") ? `${prefix}${path}` : `${prefix}/${path}`;
}

// Pairing reads a hole at the front of a path as the base URL.
const OPENING_HOLE = /^(\{[^{}]+\})(.*)$/;

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

/** What the call does with a redirect when it passes the client's redirect option with a value that settles. */
function redirectAt(
  response: ClientResponse,
  ops: CallOps,
): RequestClaim["redirectDelivery"] {
  const option = response.redirectOption;
  const value =
    option === undefined
      ? null
      : (ops.keywordAt?.(option.name)?.evaluated?.() ?? null);
  return option === undefined || value === null
    ? undefined
    : redirectDeliveryWhenSet(option, value);
}
