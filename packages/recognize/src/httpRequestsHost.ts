/**
 * Reads a host a request call, or the construction of its client, passes
 * as an argument of its own instead of inside a URL:
 *
 *   Net::HTTP.get("api.example.com", "/orders", 8080)
 *   Net::HTTP.new("api.example.com", 8080).get("/orders")
 *
 * The host is read through `ValueOps.host`, which writes it with its port
 * the way the host of `http://host:port` is written, so it pairs with an
 * absolute URL to the same place.
 */

import { statedValue } from "./compile.js";

import type { UrlTarget } from "@suss/extractor";
import type { BaseUrlLink, HostFirst } from "./chain.js";
import type { CallOps, ValueOps } from "./ops.js";

/**
 * A call's URL, read under the construction at a site, or null when the
 * call passes no URL. A URL the adapter cannot read has no path.
 */
export type UrlReading = (site: string | undefined) => UrlTarget | null;

/** A URL the adapter cannot read. */
export const NOWHERE: UrlTarget = { path: undefined, host: undefined };

/** The URL a value states, or null for no value. */
export function urlReadingOf(value: ValueOps | null): UrlReading | null {
  return value === null ? null : (site) => value.url?.(site) ?? NOWHERE;
}

/**
 * The URL a call states as `url`, or the host, path and port it passes
 * in its place when `hostFirst` says the method takes them. Which form a
 * call takes can differ between constructions, so each site decides.
 */
export function urlOrHostFirst(
  ops: CallOps,
  url: ValueOps | null,
  hostFirst: HostFirst | undefined,
): UrlReading | null {
  const plain = urlReadingOf(url);
  const path =
    hostFirst === undefined ? null : statedValue(ops, hostFirst.path);
  if (hostFirst === undefined || path === null) {
    return plain;
  }
  const host = statedValue(ops, hostFirst.host);
  const port =
    hostFirst.port === undefined ? null : statedValue(ops, hostFirst.port);
  return (site) => {
    if (path.isString?.(site) !== true) {
      return plain === null ? null : plain(site);
    }
    const own = path.url?.(site);
    // Net::HTTP sends a full URL as the request target, and a server
    // takes the request's host from it (RFC 9112, section 3.2.2).
    if (own?.host !== undefined) {
      return own;
    }
    return {
      path: requestTargetPath(own?.path),
      host: hostNamed(host, port, site),
      ...(own?.tookDefault === true || tookDefault([host, port], site)
        ? { tookDefault: true }
        : {}),
    };
  };
}

/**
 * The host and port a client's construction states, with `host` the
 * value it states the host as, as a base URL with no path, or null when
 * it states no host suss can read.
 */
export function hostBase(
  built: CallOps,
  link: BaseUrlLink,
  site: string | undefined,
  host: ValueOps,
): UrlTarget | null {
  const port = link.port === undefined ? null : statedValue(built, link.port);
  const read = hostNamed(host, port, site);
  if (read === undefined) {
    return null;
  }
  return {
    path: "",
    host: read,
    ...(tookDefault([host, port], site) ? { tookDefault: true } : {}),
  };
}

/**
 * Whether any of the values took a fallback's default over a value that
 * did not read. `host` gives a string, which has no room for the mark,
 * so the mark is read off the value as a URL.
 */
function tookDefault(
  values: readonly (ValueOps | null)[],
  site: string | undefined,
): boolean {
  return values.some((value) => value?.url?.(site)?.tookDefault === true);
}

/**
 * The host a value states with its port, or undefined when the value
 * writes a URL or a path in place of a host name, as
 * `Net::HTTP.new("https://api.example.com")` does. Net::HTTP cannot
 * connect to such an address.
 */
function hostNamed(
  host: ValueOps | null,
  port: ValueOps | null,
  site: string | undefined,
): string | undefined {
  const written = host?.evaluated?.();
  if (typeof written === "string" && written.includes("/")) {
    return undefined;
  }
  return host?.host?.(port, site);
}

/**
 * A path the library can send as the request target: one that starts
 * with `/`, or with a hole that may. Net::HTTP sends `orders` as it is
 * written, which no server reads as a path, so that is no path.
 */
export function requestTargetPath(
  path: string | undefined,
): string | undefined {
  return path === undefined || path.startsWith("/") || path.startsWith("{")
    ? path
    : undefined;
}
