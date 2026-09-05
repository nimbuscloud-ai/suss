/**
 * routePath.ts: spell a value as the path a boundary serves.
 *
 * A provider writes `app.get(USERS, handler)` and a consumer writes
 * `fetch(USERS)`, and the two only pair when both are read the same way.
 * Every adapter reads a path through here, so a prefix constant, a
 * joined path, or a name written in a branch spell the same in each
 * language. A hole the evaluator could not fill is spelled `{name}`, or
 * `{name*}` when it is a joined list, and a piece that is one of a few
 * texts is spelled `(v1|v2)`. An absolute URL loses its origin, since
 * the host is the deployable unit rather than the path, and a query
 * string ends the path where it starts.
 */

import { patternHole, rangedHole, setPiece } from "@suss/ir-core";

import { literalOf } from "./value.js";

import type { Piece, Value } from "./value.js";

const URL_SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;

// Matches the host as well, so replacing a match with "" leaves the
// path's own leading "/" in place, which is what
// `new URL(...).pathname` gives back.
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

function stripQueryAndFragment(text: string): string {
  const idx = text.search(/[?#]/);
  return idx === -1 ? text : text.slice(0, idx);
}

// Each hole becomes this Unicode noncharacter in the flattened text. It
// never appears in an actual URL, and it is not a "/", a colon or a
// scheme character.
const SUBSTITUTION = "\uFFFF";

// A scheme can be written out, substituted whole, or built from both,
// and a bare "//" starts an authority with no scheme at all.
const AUTHORITY_OPENER = /^(?:[-+.\uFFFFa-zA-Z0-9]+:\/\/|\/\/)/;

// Zero when the string is not an absolute URL, so all of it is path.
// The whole length when the authority never ends, so none of it is.
function originEndOf(flattened: string): number {
  const opener = AUTHORITY_OPENER.exec(flattened);
  if (opener === null) {
    return 0;
  }

  const slash = flattened.indexOf("/", opener[0].length);
  return slash === -1 ? flattened.length : slash;
}

// A query string can start partway through a piece of text. Nothing
// after it belongs to the path, including a later hole.
function appendPathText(
  path: string,
  text: string,
): { path: string; stop: boolean } {
  const idx = text.search(/[?#]/);
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
  return stripQueryAndFragment(stripOriginManually(text));
}

// Undefined rather than "" when the literal has no path: an empty string
// is invalid in the IR and `restBinding` throws on one.
function pathFromLiteralUrl(text: string): string | undefined {
  const path = isAbsoluteUrlLiteral(text)
    ? pathnameOfAbsoluteLiteral(text)
    : stripQueryAndFragment(text);
  return path === "" ? undefined : path;
}

/** A piece that is one literal contributes it; anything else is a hole. */
function flattenedPiece(piece: Piece): string {
  return piece.kind === "text" && piece.options.length === 1
    ? (piece.options[0] ?? "")
    : SUBSTITUTION;
}

/**
 * How a piece the evaluator could not settle to one text is spelled in
 * the path. A hole keeps the number of segments it takes, and a piece
 * that is one of a few texts is spelled as that set, so a version
 * prefix written in a branch is read back as each of its branches.
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
function pathFromPieces(pieces: readonly Piece[]): string | undefined {
  const originEnd = originEndOf(pieces.map(flattenedPiece).join(""));
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
      );
      path = appended.path;
      stop = appended.stop;
    }
    at += flattened.length;
  }

  return path === "" ? undefined : path;
}

/**
 * The path a forced value states. Undefined when the value is not a
 * string or has no path in it, which leaves the boundary unbound rather
 * than bound to a guess.
 */
export function pathOf(value: Value): string | undefined {
  if (value.kind !== "string") {
    return undefined;
  }
  const literal = literalOf(value);
  return literal === null
    ? pathFromPieces(value.pieces)
    : pathFromLiteralUrl(literal);
}
