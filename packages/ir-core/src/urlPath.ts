/**
 * urlPath.ts: the path part of a URL, however the URL was written.
 *
 * Two sides of one boundary spell it differently. A provider says
 * `/orders`, because a route is mounted at a path. A consumer says
 * `http://backend.internal/orders`, because a call has to say which
 * host. They are the same boundary, and pairing them means reading the
 * path out of both.
 *
 * The query and the fragment come off with the origin. Neither picks a
 * route: `/orders?page=2` reaches the same handler as `/orders`.
 */

const SCHEME_ORIGIN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/;
const PROTOCOL_RELATIVE_ORIGIN = /^\/\/[^/]*/;

/**
 * The path a URL states, with any origin, query, and fragment removed.
 *
 * Text that states no origin comes back with only the query and the
 * fragment removed, since a relative URL is already a path. A URL that
 * is nothing but an origin comes back as an empty string, which is what
 * a caller wanting a path should treat as "the root".
 */
export function pathAfterOrigin(text: string): string {
  const withoutOrigin = text
    .replace(SCHEME_ORIGIN, "")
    .replace(PROTOCOL_RELATIVE_ORIGIN, "");
  const cut = withoutOrigin.search(/[?#]/);
  return cut === -1 ? withoutOrigin : withoutOrigin.slice(0, cut);
}

/** Whether the text opens with an origin rather than with a path. */
export function statesAnOrigin(text: string): boolean {
  return SCHEME_ORIGIN.test(text) || PROTOCOL_RELATIVE_ORIGIN.test(text);
}
