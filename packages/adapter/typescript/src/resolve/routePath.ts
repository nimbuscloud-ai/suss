/**
 * routePath.ts: read the path a boundary serves out of the argument that
 * states it.
 *
 * Both sides of an HTTP boundary write the path in the same three forms,
 * as a string literal, as a name bound to one, or as a template with
 * substitutions in it. A provider writes `app.get(USERS, handler)` and a
 * consumer writes `fetch(USERS)`, and the two only pair when both are
 * read the same way. This file is that single reading.
 *
 * A template is read hole by hole. A hole the resolution store can follow
 * to a written string contributes that string, so a route built from a
 * prefix constant comes out with the prefix in it. A hole nobody can
 * follow becomes `{name}`, which the path normalizer treats the same way
 * as `:name`.
 *
 * An absolute URL loses its origin, since the host is the deployable unit
 * rather than the path, and a query string ends the path where it starts.
 */

import { Node } from "ts-morph";

import { patternHole } from "@suss/behavioral-ir";

import type { TemplateExpression } from "ts-morph";
import type { ResolutionStore } from "../facts/store.js";

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

// Each template substitution becomes this Unicode noncharacter in the
// flattened text. It never appears in an actual URL, and it is not a
// "/", a colon or a scheme character.
const SUBSTITUTION = "\uFFFF";

// A scheme can be written out, substituted whole, or built from both,
// and a bare "//" starts an authority with no scheme at all.
const AUTHORITY_OPENER = /^(?:[-+.\uFFFFa-zA-Z0-9]+:\/\/|\/\/)/;

// Zero when the template is not an absolute URL, so all of it is path.
// The whole length when the authority never ends, so none of it is.
function originEndOf(flattened: string): number {
  const opener = AUTHORITY_OPENER.exec(flattened);
  if (opener === null) {
    return 0;
  }

  const slash = flattened.indexOf("/", opener[0].length);
  return slash === -1 ? flattened.length : slash;
}

// A query string can start partway through a template's static text.
// Nothing after it belongs to the path, including a later substitution.
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

// `` `/pet/${id}` `` gives `/pet/{id}`; the path normalizer treats
// `{id}` and `:id` as the same segment. A substitution before the
// authority's closing "/" is part of the authority whatever it is.
function pathFromTemplateUrl(
  arg: TemplateExpression,
  resolution: ResolutionStore | undefined,
): string | undefined {
  const headText = arg.getHead().getLiteralText();
  const spans = arg.getTemplateSpans();
  const tails = spans.map((span) => span.getLiteral().getLiteralText());
  const originEnd = originEndOf([headText, ...tails].join(SUBSTITUTION));

  const head = appendPathText("", headText.slice(originEnd));
  let path = head.path;
  let stop = head.stop;
  // Where the piece currently being read starts in the flattened text.
  let at = headText.length;

  for (let i = 0; i < spans.length && !stop; i++) {
    const span = spans[i];
    const tailText = tails[i];
    if (span === undefined || tailText === undefined) {
      continue;
    }

    if (at >= originEnd) {
      path += holeText(span.getExpression(), resolution);
    }
    at += SUBSTITUTION.length;

    const appended = appendPathText(
      path,
      tailText.slice(Math.max(0, originEnd - at)),
    );
    path = appended.path;
    stop = appended.stop;
    at += tailText.length;
  }

  return path === "" ? undefined : path;
}

/** The path a URL-shaped node states, in any of its three written forms. */
export function pathFromUrlNode(
  node: Node,
  resolution?: ResolutionStore,
): string | undefined {
  if (Node.isStringLiteral(node)) {
    return pathFromLiteralUrl(node.getLiteralValue());
  }
  if (Node.isNoSubstitutionTemplateLiteral(node)) {
    return pathFromLiteralUrl(node.getLiteralValue());
  }
  if (Node.isTemplateExpression(node)) {
    return pathFromTemplateUrl(node, resolution);
  }
  if (Node.isBinaryExpression(node)) {
    const joined = joinedStringOf(node, resolution);
    return joined === undefined ? undefined : pathFromLiteralUrl(joined);
  }
  return undefined;
}

/**
 * The string a `+` of strings works out to, or undefined when a side
 * is anything else. `"/users" + "/:id"` states the same path a
 * template does, written the other way, and a name in either side is
 * followed to what it was written as, the same hop every other
 * spelling of a path gets.
 */
function joinedStringOf(
  node: Node,
  resolution: ResolutionStore | undefined,
): string | undefined {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  ) {
    return node.getLiteralValue();
  }
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getText() === "+"
  ) {
    const left = joinedStringOf(node.getLeft(), resolution);
    const right = joinedStringOf(node.getRight(), resolution);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  const written = resolution?.resolveWrittenValue(node) ?? null;
  return written === null || written === node
    ? undefined
    : joinedStringOf(written, resolution);
}

function placeholderName(expr: Node): string {
  if (Node.isIdentifier(expr)) {
    return expr.getText();
  }
  if (Node.isPropertyAccessExpression(expr)) {
    return expr.getName();
  }
  return "param";
}

/**
 * What a template's substitution contributes to the path. A name bound to
 * a written string contributes that string, so `` `${BASE}/items/:id` ``
 * keeps the prefix instead of standing in for it.
 */
function holeText(expr: Node, resolution: ResolutionStore | undefined): string {
  const written = resolution?.resolveWrittenValue(expr) ?? null;
  if (written === null) {
    return patternHole(placeholderName(expr));
  }
  // A hole written as the empty string contributes nothing to the path,
  // so `` `${BASE}/users` `` under `BASE = ""` is `/users`. The reader
  // for a whole path gives back undefined for that, since a path of ""
  // is invalid in the IR, and here it means something.
  if (emptyStringLiteral(written)) {
    return "";
  }
  return (
    pathFromUrlNode(written, resolution) ?? patternHole(placeholderName(expr))
  );
}

function emptyStringLiteral(node: Node): boolean {
  return (
    (Node.isStringLiteral(node) ||
      Node.isNoSubstitutionTemplateLiteral(node)) &&
    node.getLiteralValue() === ""
  );
}

/**
 * The path stated by the argument at a call site, following a name one
 * hop to the string it was written as. Undefined when nothing readable is
 * there, which leaves the boundary unbound rather than bound to a guess.
 */
export function pathFromArgument(
  arg: Node,
  resolution?: ResolutionStore,
): string | undefined {
  const written = pathFromUrlNode(arg, resolution);
  if (written !== undefined) {
    return written;
  }
  const resolved = resolution?.resolveWrittenValue(arg) ?? null;
  return resolved !== null ? pathFromUrlNode(resolved, resolution) : undefined;
}
