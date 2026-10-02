/**
 * Turns an evaluated value into the path a boundary serves.
 *
 * A provider writes `app.get(USERS, handler)` and a consumer writes
 * `fetch(USERS)`, and the two pair only when both are read the same way.
 * Every adapter reads a path through this module, so a prefix constant,
 * a joined path, or a name assigned in a branch comes out the same in
 * each language. A hole the evaluator could not fill is written
 * `{name}`, or `{name*}` when it is a joined list. A piece that is one
 * of a few texts is written `(v1|v2)`. The path leaves out an absolute
 * URL's origin, and `hostOf` reads the host on its own, so pairing can
 * tell a call to the app from a call to another company's API. A query
 * string ends a request URL's path, and a route pattern keeps its `?`.
 */

import { patternHole, rangedHole, setPiece } from "@suss/ir-core";

import { literalOf } from "./value.js";

import type { Piece, Value } from "./value.js";

const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

// Matches the host as well, so replacing a match with "" leaves the
// path's own leading "/" in place, the same as `new URL(...).pathname`.
const URL_ORIGIN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\/[^/]*/;

const PROTOCOL_RELATIVE = /^\/\//;
const PROTOCOL_RELATIVE_ORIGIN = /^\/\/[^/]*/;

function isAbsoluteUrlLiteral(text: string): boolean {
  return URL_SCHEME.test(text) || PROTOCOL_RELATIVE.test(text);
}

function stripOriginManually(text: string): string {
  if (URL_SCHEME.test(text)) {
    return text.replace(URL_ORIGIN, "");
  }
  if (PROTOCOL_RELATIVE.test(text)) {
    return text.replace(PROTOCOL_RELATIVE_ORIGIN, "");
  }
  return text;
}

/**
 * Where the path ends in a URL a request goes to: at the query or the
 * fragment. A route pattern a server registers has neither, and a `?`
 * there marks an optional parameter, `/:pk/:filename?`.
 */
type PathEnd = RegExp | null;

const REQUEST_PATH_END: PathEnd = /[?#]/;
const ROUTE_PATTERN_END: PathEnd = null;

function endOfPath(text: string, end: PathEnd): number {
  return end === null ? -1 : text.search(end);
}

function stripQueryAndFragment(text: string, end: PathEnd): string {
  const idx = endOfPath(text, end);
  return idx === -1 ? text : text.slice(0, idx);
}

// Each hole becomes this Unicode noncharacter in the flattened text. It
// never appears in an actual URL, and it is not a "/", a colon or a
// scheme character.
const SUBSTITUTION = "\uFFFF";

// A scheme can be written out, substituted whole, or built from both,
// and a bare "//" starts an authority with no scheme at all.
const AUTHORITY_OPENER = /^(?:[-+.\uFFFFa-zA-Z0-9]+:\/\/|\/\/)/;

/** Where the authority starts and ends in the flattened text, or null for a relative URL. */
interface Authority {
  start: number;
  end: number;
}

function authorityOf(flattened: string, end: PathEnd): Authority | null {
  const opener = AUTHORITY_OPENER.exec(flattened);
  if (opener !== null) {
    const slash = flattened.indexOf("/", opener[0].length);
    return {
      start: opener[0].length,
      end: slash === -1 ? flattened.length : slash,
    };
  }
  if (end !== REQUEST_PATH_END) {
    return null;
  }
  // A relative URL cannot have a colon in its first segment. With a hole
  // there too, as in `${scheme}:${url}` or `${host}:${port}/x`, the hole
  // hides the authority, so the whole segment is the authority.
  const slash = flattened.indexOf("/");
  const head = slash === -1 ? flattened : flattened.slice(0, slash);
  return head.includes(":") && head.includes(SUBSTITUTION)
    ? { start: 0, end: head.length }
    : null;
}

// Zero when the string is not an absolute URL, so all of it is path.
// The whole length when the authority never ends, so none of it is.
function originEndOf(flattened: string, end: PathEnd): number {
  return authorityOf(flattened, end)?.end ?? 0;
}

// A query string can start partway through a piece of text. Nothing
// after it belongs to the path, including a later hole.
function appendPathText(
  path: string,
  text: string,
  end: PathEnd,
): { path: string; stop: boolean } {
  const idx = endOfPath(text, end);
  if (idx === -1) {
    return { path: path + text, stop: false };
  }
  return { path: path + text.slice(0, idx), stop: true };
}

/** A protocol-relative string needs a scheme added before it will parse. */
function parseAbsoluteUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    // Falls through to the protocol-relative case below.
  }
  if (!PROTOCOL_RELATIVE.test(text)) {
    return undefined;
  }
  try {
    return new URL(`https:${text}`);
  } catch {
    return undefined;
  }
}

function pathnameOfAbsoluteLiteral(text: string): string {
  const parsed = parseAbsoluteUrl(text);
  if (parsed !== undefined) {
    return parsed.pathname;
  }
  // `new URL` rejects some strings that do start with a scheme or a
  // protocol-relative "//", a bare "https://" among them.
  return stripQueryAndFragment(stripOriginManually(text), REQUEST_PATH_END);
}

// Undefined rather than "" when the literal has no path: an empty string
// is invalid in the IR and `restBinding` throws on one.
function pathFromLiteralUrl(text: string, end: PathEnd): string | undefined {
  const path = isAbsoluteUrlLiteral(text)
    ? pathnameOfAbsoluteLiteral(text)
    : stripQueryAndFragment(text, end);
  return path === "" ? undefined : path;
}

/** A piece that is one literal contributes it; anything else is a hole. */
function flattenedPiece(piece: Piece): string {
  return piece.kind === "text" && piece.options.length === 1
    ? (piece.options[0] ?? "")
    : SUBSTITUTION;
}

/**
 * How a piece the evaluator could not reduce to one text is written in
 * the path. A hole keeps the number of segments it covers. A piece that
 * is one of a few texts is written as that set, so a version prefix
 * assigned in a branch comes back as each of its branches.
 */
function openPiece(piece: Piece): string {
  if (piece.kind === "hole") {
    return rangedHole(piece.name, piece.range);
  }
  return setPiece(piece.options) ?? patternHole("value");
}

// A string with holes in it: `/pet/{id}` for `` `/pet/${id}` ``. A hole
// before the authority's closing "/" is part of the authority whatever
// it is, and a hole after the path ends is not part of anything.
function pathFromPieces(
  pieces: readonly Piece[],
  end: PathEnd,
): string | undefined {
  const originEnd = originEndOf(pieces.map(flattenedPiece).join(""), end);
  let path = "";
  let stop = false;
  // Where the piece currently being read starts in the flattened text.
  let at = 0;

  for (const piece of pieces) {
    if (stop) {
      break;
    }
    const flattened = flattenedPiece(piece);
    if (flattened === SUBSTITUTION) {
      if (at >= originEnd) {
        path += openPiece(piece);
      }
    } else {
      const appended = appendPathText(
        path,
        flattened.slice(Math.max(0, originEnd - at)),
        end,
      );
      path = appended.path;
      stop = appended.stop;
    }
    at += flattened.length;
  }

  return path === "" ? undefined : path;
}

// The fetch standard's local schemes. Fetching a URL with one of them
// sends no request out of the process.
const LOCAL_SCHEME = /^(?:about|blob|data):/i;

/**
 * Whether a forced value is a URL that fetch reads without a network
 * request, such as a base64 `data:` URI. A call with one crosses no
 * boundary, so client discovery skips it.
 */
export function isLocalUrl(value: Value): boolean {
  if (value.kind !== "string") {
    return false;
  }
  const first = value.pieces[0];
  return (
    first?.kind === "text" &&
    first.options.length > 0 &&
    first.options.every((option) => LOCAL_SCHEME.test(option))
  );
}

/**
 * The path in a forced value. Undefined when the value is not a string
 * or has no path in it, so the caller leaves the boundary unbound
 * instead of guessing one.
 */
export function pathOf(value: Value): string | undefined {
  return pathEndingAt(value, REQUEST_PATH_END);
}

/**
 * The host written in an absolute URL, with its port, as `api.example.com:8443`.
 * A piece of the authority the evaluator could not read is written
 * `{name}`, so a host suss read can be told from one it could not.
 * Undefined for a relative URL, which goes wherever the page or the
 * client's base sends it.
 */
export function hostOf(value: Value): string | undefined {
  if (value.kind !== "string" || isLocalUrl(value)) {
    return undefined;
  }
  const literal = literalOf(value);
  const host =
    literal === null ? hostFromPieces(value.pieces) : hostFromLiteral(literal);
  return host === "" ? undefined : host;
}

function hostFromLiteral(text: string): string | undefined {
  if (!isAbsoluteUrlLiteral(text)) {
    return undefined;
  }
  const parsed = parseAbsoluteUrl(text);
  if (parsed !== undefined) {
    return parsed.host;
  }
  const authority = text.replace(/^[a-zA-Z][a-zA-Z\d+.-]*:/, "").slice(2);
  return withoutUserInfo(authority.split(/[/?#]/)[0] ?? "").toLowerCase();
}

function hostFromPieces(pieces: readonly Piece[]): string | undefined {
  const authority = authorityOf(
    pieces.map(flattenedPiece).join(""),
    REQUEST_PATH_END,
  );
  if (authority === null) {
    return undefined;
  }
  let host = "";
  let at = 0;
  for (const piece of pieces) {
    const flattened = flattenedPiece(piece);
    const from = Math.max(authority.start - at, 0);
    const to = Math.min(authority.end - at, flattened.length);
    at += flattened.length;
    if (from >= to) {
      continue;
    }
    host +=
      flattened === SUBSTITUTION
        ? patternHole(piece.kind === "hole" ? piece.name : "value")
        : flattened.slice(from, to).toLowerCase();
  }
  return withoutUserInfo(host);
}

// `user:secret@host` names the host after the last "@".
function withoutUserInfo(authority: string): string {
  return authority.slice(authority.lastIndexOf("@") + 1);
}

/**
 * The path a server registers a route under, read the way `pathOf` reads
 * a request URL, except that a `?` stays in it: Express, Hono and the
 * routers modelled on them write an optional parameter as `:name?`.
 */
export function routePatternOf(value: Value): string | undefined {
  return pathEndingAt(value, ROUTE_PATTERN_END);
}

function pathEndingAt(value: Value, end: PathEnd): string | undefined {
  if (value.kind !== "string" || isLocalUrl(value)) {
    return undefined;
  }
  const literal = literalOf(value);
  return literal === null
    ? pathFromPieces(value.pieces, end)
    : pathFromLiteralUrl(literal, end);
}
