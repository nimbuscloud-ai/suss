/**
 * The cases the client URL check runs. Each one is a single call: the
 * base its client was built with and the URL the call passes. A path
 * writes a template hole as `{order_id}`, and each language renders it
 * as its own interpolation.
 *
 * httpx, aiohttp, Faraday and axios take a base URL, so they share one
 * table: every base crossed with every path, plus full URLs called with
 * no base. Net::HTTP takes a host and a path, so it has its own table.
 */

/** A library, spelled as the name of the suss pack that models it. */
export type Library = "httpx" | "aiohttp" | "faraday" | "axios" | "net-http";

export const LIBRARIES: readonly Library[] = [
  "httpx",
  "aiohttp",
  "faraday",
  "axios",
  "net-http",
];

/** How a Net::HTTP case calls: `Net::HTTP.get(host, path)`, `Net::HTTP.new(host).get(path)`, the same with a `Net::HTTP::Get` object, or `Net::HTTP.get(URI(url))`. */
export type NetHttpForm = "get" | "new" | "request" | "uri";

export interface UrlCase {
  /** The name of the function the case is written in, unique across libraries. */
  readonly id: string;
  readonly library: Library;
  /** Which entry of the base table the case uses. */
  readonly baseKind: string;
  /** Which entry of the path table the case uses. */
  readonly pathKind: string;
  /** The URL the client is built with, or the host for Net::HTTP; null when the call has neither. */
  readonly base: string | null;
  readonly path: string;
  readonly port: number | null;
  readonly form: NetHttpForm | null;
}

export const HOLE_NAME = "order_id";

const BASES: Record<string, string> = {
  host: "https://api.example.com",
  hostSlash: "https://api.example.com/",
  path: "https://api.example.com/v1",
  pathSlash: "https://api.example.com/v1/",
  twoSegments: "https://api.example.com/v1/beta",
  query: "https://api.example.com/v1?key=abc",
  querySlash: "https://api.example.com/v1/?key=abc",
};

const ABSOLUTE_PATH = "/orders";

const PATHS: Record<string, string> = {
  absolute: ABSOLUTE_PATH,
  relative: "orders",
  empty: "",
  parent: "../orders",
  absoluteParent: "/v2/../orders",
  query: "/orders?status=open",
  relativeQuery: "orders?status=open",
  fullUrl: "https://other.example.com/orders",
  schemeRelative: "//other.example.com/orders",
  hole: `/orders/{${HOLE_NAME}}`,
  relativeHole: `orders/{${HOLE_NAME}}`,
};

const FULL_URLS: Record<string, string> = {
  fullUrl: "https://api.example.com/orders",
  fullUrlNoPath: "https://api.example.com",
  fullUrlParent: "https://api.example.com/v1/../orders",
  fullUrlQuery: "https://api.example.com/orders?status=open",
  fullUrlHole: `https://api.example.com/orders/{${HOLE_NAME}}`,
};

/** Net::HTTP sends a path as the request target unchanged, so it leaves out the paths that only differ in how a base joins them. */
const NET_HTTP_PATH_KINDS = new Set([
  "absolute",
  "relative",
  "empty",
  "absoluteParent",
  "query",
  "fullUrl",
  "hole",
]);

/** Each Net::HTTP call form, with the port it passes. */
const NET_HTTP_CALLS: Record<
  string,
  { form: NetHttpForm; port: number | null }
> = {
  get: { form: "get", port: null },
  getPort: { form: "get", port: 8080 },
  new: { form: "new", port: null },
  newPort: { form: "new", port: 8080 },
  request: { form: "request", port: null },
};

/** Hosts a caller might pass that are not host names. */
const NET_HTTP_BAD_HOSTS: Record<string, string> = {
  hostSlash: "api.example.com/",
  scheme: "https://api.example.com",
  hostPath: "api.example.com/v1",
};

function caseId(library: Library, ...parts: string[]): string {
  return [library.replace("-", "_"), ...parts].join("__");
}

function baseUrlCases(library: Library): UrlCase[] {
  const cases: UrlCase[] = [];
  for (const [baseKind, base] of Object.entries(BASES)) {
    for (const [pathKind, path] of Object.entries(PATHS)) {
      cases.push({
        id: caseId(library, baseKind, pathKind),
        library,
        baseKind,
        pathKind,
        base,
        path,
        port: null,
        form: null,
      });
    }
  }

  for (const [pathKind, path] of Object.entries(FULL_URLS)) {
    cases.push({
      id: caseId(library, "none", pathKind),
      library,
      baseKind: "none",
      pathKind,
      base: null,
      path,
      port: null,
      form: null,
    });
  }

  return cases;
}

function netHttpCases(): UrlCase[] {
  const library: Library = "net-http";
  const cases: UrlCase[] = [];
  const paths = Object.entries(PATHS).filter(([kind]) =>
    NET_HTTP_PATH_KINDS.has(kind),
  );
  for (const [callKind, call] of Object.entries(NET_HTTP_CALLS)) {
    for (const [pathKind, path] of paths) {
      cases.push({
        id: caseId(library, callKind, pathKind),
        library,
        baseKind: callKind,
        pathKind,
        base: "api.example.com",
        path,
        port: call.port,
        form: call.form,
      });
    }
  }

  for (const [hostKind, host] of Object.entries(NET_HTTP_BAD_HOSTS)) {
    for (const form of ["get", "new"] as const) {
      cases.push({
        id: caseId(library, form, hostKind),
        library,
        baseKind: `${form} ${hostKind}`,
        pathKind: "absolute",
        base: host,
        path: ABSOLUTE_PATH,
        port: null,
        form,
      });
    }
  }

  for (const [pathKind, url] of Object.entries(FULL_URLS)) {
    cases.push({
      id: caseId(library, "uri", pathKind),
      library,
      baseKind: "uri",
      pathKind,
      base: null,
      path: url,
      port: null,
      form: "uri",
    });
  }

  return cases;
}

const CASES_BY_LIBRARY: Record<Library, () => UrlCase[]> = {
  httpx: () => baseUrlCases("httpx"),
  aiohttp: () => baseUrlCases("aiohttp"),
  faraday: () => baseUrlCases("faraday"),
  axios: () => baseUrlCases("axios"),
  "net-http": netHttpCases,
};

export function casesFor(library: Library): UrlCase[] {
  return CASES_BY_LIBRARY[library]();
}
