/**
 * The path part of a URL, however the URL was written.
 *
 * The two sides of one boundary spell a URL differently. A provider
 * writes `/orders`, because a route is mounted at a path. A consumer
 * writes `http://backend.internal/orders`, because a call has to give a
 * host. Pairing them means reading the path out of both.
 *
 * The query and the fragment are removed along with the origin, because
 * neither one picks a route: `/orders?page=2` reaches the same handler
 * as `/orders`.
 */

const SCHEME_ORIGIN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/;
const PROTOCOL_RELATIVE_ORIGIN = /^\/\/[^/]*/;

/**
 * The path a URL states, with any origin, query, and fragment removed.
 *
 * Text without an origin comes back with only the query and the
 * fragment removed, since a relative URL is already a path. A URL that
 * is only an origin comes back as an empty string, and a caller should
 * treat that as the root.
 */
export function pathAfterOrigin(text: string): string {
  const withoutOrigin = text
    .replace(SCHEME_ORIGIN, "")
    .replace(PROTOCOL_RELATIVE_ORIGIN, "");
  const cut = withoutOrigin.search(/[?#]/);
  return cut === -1 ? withoutOrigin : withoutOrigin.slice(0, cut);
}

/** Whether the text starts with an origin (a scheme and host, or `//host`). */
export function statesAnOrigin(text: string): boolean {
  return SCHEME_ORIGIN.test(text) || PROTOCOL_RELATIVE_ORIGIN.test(text);
}

// Suffixes kept for private networks and for examples. A name under one
// of them is never someone else's public API.
const PRIVATE_SUFFIXES = [
  "local",
  "internal",
  "localhost",
  "lan",
  "home.arpa",
  "svc",
  "test",
  "example",
  "invalid",
  "example.com",
  "example.net",
  "example.org",
];

const PRIVATE_IPV4 =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/;

/** The host without its port, lowercased, with no trailing dot. */
function hostnameOf(host: string): string {
  const lower = host.toLowerCase();
  const name = lower.startsWith("[")
    ? lower.slice(0, lower.indexOf("]") + 1)
    : (lower.split(":")[0] ?? lower);
  return name.replace(/\.$/, "");
}

/**
 * Whether a host a client wrote out can belong to the project itself: a
 * loopback or private address, a name with no dot such as a container's
 * service name, or a name under a suffix kept for private networks or
 * examples. Any other name is a public host the project does not serve.
 */
export function hostCanBeOwn(host: string): boolean {
  const name = hostnameOf(host);
  if (name === "[::1]" || /^\[f[cd]/.test(name) || PRIVATE_IPV4.test(name)) {
    return true;
  }
  if (!name.includes(".")) {
    return true;
  }
  return PRIVATE_SUFFIXES.some(
    (suffix) => name === suffix || name.endsWith(`.${suffix}`),
  );
}
