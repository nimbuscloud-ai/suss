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
