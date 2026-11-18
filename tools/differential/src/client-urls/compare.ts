/**
 * Decides whether suss and the library agree on one case. Both sides
 * come down to a host and a path before they are compared, because suss
 * does not record the scheme or the query. A hole matches a hole
 * whatever it is called. Dot segments are compared as each side wrote
 * them, since a library that sends `/v1/../orders` sends exactly that.
 *
 * When the library refuses the base, suss agrees by leaving the base
 * out. When it refuses the call itself, suss agrees by not recording a
 * request.
 */

import { HOLE_SENTINEL, type LibraryResult } from "./library.js";

import type { UrlCase } from "./cases.js";
import type { SussRequest } from "./suss.js";

export interface Comparison {
  readonly case: UrlCase;
  readonly library: LibraryResult;
  readonly suss: readonly SussRequest[];
  /** Null when the two sides agree, and otherwise what differs. */
  readonly disagreement: string | null;
}

export interface HostAndPath {
  readonly host: string;
  readonly path: string;
}

const URL_PARTS = /^(?:([a-z][a-z0-9+.-]*):)?\/\/([^/?#]*)([^?#]*)/i;
const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

function normalizePath(path: string): string {
  const holes = path
    .replaceAll(HOLE_SENTINEL, "{}")
    .replace(/\{[^}]*\}/g, "{}");
  return holes === "" ? "/" : holes;
}

/** The host and path of an absolute or scheme-relative URL, or null for anything else. The default port is dropped. */
export function hostAndPath(url: string): HostAndPath | null {
  const parts = URL_PARTS.exec(url);
  if (parts === null) {
    return null;
  }

  const [, scheme = "", authority = "", path = ""] = parts;
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  const defaultPort = DEFAULT_PORTS[scheme.toLowerCase()];
  const portSuffix = `:${defaultPort}`;
  return {
    host:
      defaultPort !== undefined && host.endsWith(portSuffix)
        ? host.slice(0, -portSuffix.length)
        : host,
    path: normalizePath(path),
  };
}

function urlDisagreement(
  url: string,
  suss: readonly SussRequest[],
): string | null {
  const expected = hostAndPath(url);
  if (expected === null) {
    return `the library built ${url}, which is not an absolute URL`;
  }

  if (suss.length !== 1) {
    return suss.length === 0
      ? "suss does not record a request"
      : `suss records ${suss.length} requests`;
  }

  const [request] = suss as [SussRequest];
  if (request.method !== "GET") {
    return `suss records the method ${request.method}`;
  }

  if (request.path === null) {
    return "suss does not record a path";
  }

  const differences: string[] = [];
  if (normalizePath(request.path) !== expected.path) {
    differences.push("the path differs");
  }

  if (request.host === null) {
    differences.push("suss leaves out the host");
  } else if (request.host.toLowerCase() !== expected.host) {
    differences.push("the host differs");
  }

  return differences.length === 0 ? null : differences.join(" and ");
}

/** True when suss put the case's base into the URL it records. */
function usesBase(c: UrlCase, request: SussRequest): boolean {
  const own = hostAndPath(c.path);
  if (request.host !== null && request.host.toLowerCase() !== own?.host) {
    return true;
  }

  if (c.base === null || request.path === null) {
    return false;
  }

  const basePath = hostAndPath(c.base)?.path.replace(/\/$/, "") ?? "";
  return (
    basePath !== "" &&
    request.path.startsWith(`${basePath}/`) &&
    !c.path.startsWith(basePath)
  );
}

function refusalDisagreement(
  c: UrlCase,
  refusedBase: boolean,
  suss: readonly SussRequest[],
): string | null {
  const recorded = suss.filter((request) => request.path !== null);
  if (recorded.length === 0) {
    return null;
  }

  if (!refusedBase) {
    return "suss records a request the library refuses to send";
  }

  return recorded.some((request) => usesBase(c, request))
    ? "suss joins a base the library refuses"
    : null;
}

export function compare(
  c: UrlCase,
  library: LibraryResult,
  suss: readonly SussRequest[],
): Comparison {
  const disagreement =
    library.kind === "url"
      ? urlDisagreement(library.url, suss)
      : refusalDisagreement(c, library.base, suss);
  return { case: c, library, suss, disagreement };
}
