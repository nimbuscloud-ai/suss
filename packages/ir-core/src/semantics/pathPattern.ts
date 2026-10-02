/**
 * Whether two route paths describe a request in common.
 *
 * A normalized path is text with holes in it. `{id}` is exactly one
 * segment, `{tenant?}` is zero or one, `{rest+}` is one or more and
 * `{rest*}` is zero or more, the modifiers Express puts on `:name`. A
 * bare `*` segment is zero or more segments, Express 4's reading of a
 * star. A set piece is written `(v1|v2)` and matches any one of its
 * options, and an option can contain a slash. A hole before the first
 * slash is a base URL the client left open, and it matches the origin.
 *
 * `pathsMeet` expands the sets into alternatives, splits each one into
 * segments, and walks the two segment lists with a reachability table
 * in which a hole absorbs as many segments as its range allows.
 */

import { patternHole } from "../boundaryName.js";

/** How many segments a hole takes: exactly one, zero or one, one or more, or any number. */
export type HoleRange = "one" | "optional" | "many" | "any";

const HOLE_RANGE_SUFFIX: Record<HoleRange, string> = {
  one: "",
  optional: "?",
  many: "+",
  any: "*",
};

/** The path text for a hole that takes `range` segments, such as `{rest+}`. */
export function rangedHole(name: string, range: HoleRange): string {
  return patternHole(`${name}${HOLE_RANGE_SUFFIX[range]}`);
}

/** What an option of a set piece cannot contain and still be read back. */
const UNSPELLABLE_OPTION = /[()|?#{}]/;

/**
 * The path text for a piece that matches any one of `options`, such as
 * `(v1|v2)`. Null when an option would parse as something else, such as
 * a set boundary or the start of a query.
 */
export function setPiece(options: readonly string[]): string | null {
  if (options.some((option) => UNSPELLABLE_OPTION.test(option))) {
    return null;
  }
  return `(${options.join("|")})`;
}

/** One segment of a pattern, after the wide holes are split up. */
type Item =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "shaped";
      readonly shape: string;
      readonly test: RegExp;
      /** The text the segment spells when every hole in it is empty, or null when one cannot be. */
      readonly bare: string | null;
    }
  | { readonly kind: "one" }
  | { readonly kind: "optional" }
  | { readonly kind: "star" };

const ONE: Item = { kind: "one" };
const OPTIONAL: Item = { kind: "optional" };
const STAR: Item = { kind: "star" };

const HOLE_SEGMENT = /^\{[^{}]*?([?+*]?)\}$/;
const SET_PIECE = /\(([^()]*)\)/;

/** How many alternatives a path with several sets may expand into. */
const ALTERNATIVE_CAP = 64;

/**
 * Every path the set pieces expand into. Past `ALTERNATIVE_CAP`, each
 * set is read as a plain hole instead.
 */
function alternativesOf(path: string): string[] {
  let alternatives = [path];
  for (;;) {
    const next: string[] = [];
    let expanded = false;
    for (const alternative of alternatives) {
      const set = SET_PIECE.exec(alternative);
      if (set === null || set.index === undefined) {
        next.push(alternative);
        continue;
      }
      expanded = true;
      const head = alternative.slice(0, set.index);
      const tail = alternative.slice(set.index + set[0].length);
      for (const option of (set[1] ?? "").split("|")) {
        next.push(head + option + tail);
      }
    }
    if (!expanded) {
      return alternatives;
    }
    if (next.length > ALTERNATIVE_CAP) {
      return [path.replace(new RegExp(SET_PIECE, "g"), "{value}")];
    }
    alternatives = next;
  }
}

const HOLE_RANGE_ITEMS: Record<string, readonly Item[]> = {
  "": [ONE],
  "?": [OPTIONAL],
  "+": [ONE, STAR],
  "*": [STAR],
};

function escapedForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A segment with a hole inside its text matches by a per-segment regex, and compares with another such segment by shape. */
function shapedItem(segment: string): Item {
  const source = segment
    .split(/(\{[^}]*\}|\*)/g)
    .map((part) => {
      if (part === "*") {
        return ".*";
      }
      if (part.startsWith("{")) {
        // `count{query*}` is `count` with nothing after it too.
        return /[?*]\}$/.test(part) ? "[^/]*" : "[^/]+";
      }
      return escapedForRegex(part);
    })
    .join("");
  const holes = segment.match(/\{[^}]*\}|\*/g) ?? [];
  return {
    kind: "shaped",
    shape: segment.replace(/\{[^}]*\}/g, "{}"),
    test: new RegExp(`^${source}$`),
    bare: holes.every((hole) => hole === "*" || /[?*]\}$/.test(hole))
      ? segment.replace(/\{[^}]*\}|\*/g, "")
      : null,
  };
}

function itemsOf(segment: string): readonly Item[] {
  if (segment === "*") {
    return [STAR];
  }
  const hole = HOLE_SEGMENT.exec(segment);
  if (hole !== null) {
    return HOLE_RANGE_ITEMS[hole[1] ?? ""] ?? [ONE];
  }
  if (segment.includes("{") || segment.includes("*")) {
    return [shapedItem(segment)];
  }
  return [{ kind: "text", text: segment }];
}

/** The segments of one alternative; a bare `/` has none. */
function segmentsOf(alternative: string): string[] {
  const trimmed = alternative.startsWith("/")
    ? alternative.slice(1)
    : alternative;
  return trimmed === "" ? [] : trimmed.split("/");
}

/**
 * The segments of one alternative, less a base URL hole at the front.
 * `{baseUrl}/links/count` leaves the origin open, and until a deployment
 * fills it in, the hole is read as the origin and takes no segment. A
 * route at `/wellknown/{domain}/{file}` is not the one that call reaches.
 */
function patternSegmentsOf(alternative: string): string[] {
  const segments = segmentsOf(alternative);
  const first = segments[0];
  const opensWithBaseUrl =
    !alternative.startsWith("/") &&
    first !== undefined &&
    HOLE_SEGMENT.test(first);
  return opensWithBaseUrl ? segments.slice(1) : segments;
}

/**
 * The path less a base URL hole at the front, `/links/count` for
 * `{baseUrl}/links/count`, so a key reads the hole as the origin the
 * same way `pathsMeet` does. A path that is only the hole is kept.
 */
export function pathAfterBaseUrl(path: string): string {
  const segments = segmentsOf(path);
  const first = segments[0];
  if (
    path.startsWith("/") ||
    first === undefined ||
    segments.length < 2 ||
    !HOLE_SEGMENT.test(first)
  ) {
    return path;
  }
  return `/${segments.slice(1).join("/")}`;
}

// Pairing compares one path against many, and a large app has thousands
// of routes, so each path is split into items once.
const PATTERNS = new Map<string, Item[][]>();
const PATTERN_CACHE_LIMIT = 50_000;

function patternOf(path: string): Item[][] {
  const known = PATTERNS.get(path);
  if (known !== undefined) {
    return known;
  }
  const pattern = alternativesOf(path).map((alternative) =>
    patternSegmentsOf(alternative).flatMap(itemsOf),
  );
  if (PATTERNS.size >= PATTERN_CACHE_LIMIT) {
    PATTERNS.clear();
  }
  PATTERNS.set(path, pattern);
  return pattern;
}

/** The segments of a concrete request path, each one text. */
function literalItemsOf(path: string): Item[] {
  return segmentsOf(path).map((text) => ({ kind: "text", text }));
}

function absorbsAnything(item: Item): boolean {
  return (
    item.kind === "one" || item.kind === "optional" || item.kind === "star"
  );
}

/** Whether the two items can match the same single segment. */
function meetOnOneSegment(a: Item, b: Item): boolean {
  if (absorbsAnything(a) || absorbsAnything(b)) {
    return true;
  }
  if (a.kind === "text" && b.kind === "text") {
    return a.text === b.text;
  }
  if (a.kind === "text" && b.kind === "shaped") {
    return b.test.test(a.text);
  }
  if (a.kind === "shaped" && b.kind === "text") {
    return a.test.test(b.text);
  }
  return a.kind === "shaped" && b.kind === "shaped" && a.shape === b.shape;
}

function skippable(item: Item): boolean {
  return item.kind === "optional" || item.kind === "star";
}

/** Whether some request lies in both segment lists. */
function itemsMeet(a: readonly Item[], b: readonly Item[]): boolean {
  const width = b.length + 1;
  const seen = new Uint8Array((a.length + 1) * width);
  const queue: number[] = [0];
  seen[0] = 1;
  const visit = (i: number, j: number): void => {
    const at = i * width + j;
    if (seen[at] === 0) {
      seen[at] = 1;
      queue.push(at);
    }
  };
  while (queue.length > 0) {
    const at = queue.pop() as number;
    const i = Math.floor(at / width);
    const j = at % width;
    if (i === a.length && j === b.length) {
      return true;
    }
    const left = a[i];
    const right = b[j];
    if (left !== undefined && skippable(left)) {
      visit(i + 1, j);
    }
    if (right !== undefined && skippable(right)) {
      visit(i, j + 1);
    }
    if (left !== undefined && right !== undefined) {
      if (meetOnOneSegment(left, right)) {
        visit(
          left.kind === "star" ? i : i + 1,
          right.kind === "star" ? j : j + 1,
        );
      }
    }
  }
  return false;
}

/** Whether two normalized route paths describe at least one request in common. */
export function pathsMeet(a: string, b: string): boolean {
  const left = patternOf(a);
  const right = patternOf(b);
  return left.some((one) => right.some((other) => itemsMeet(one, other)));
}

/** Whether a declared route path admits a concrete request path, whose every segment is text. */
export function patternAdmits(declared: string, request: string): boolean {
  const literal = literalItemsOf(request);
  return patternOf(declared).some((items) => itemsMeet(items, literal));
}

/**
 * Whether the path can meet paths other than the ones with its own
 * shape. A hole of one segment lines up with a segment on the other
 * side, so two such paths meet only when their shapes are equal, and
 * a bucket keyed on the shape finds them. A wider hole or a set does
 * not line up, so a path with one has to be compared against every
 * bucket.
 */
export function pathSpansShapes(path: string): boolean {
  return /\{[^{}]*[?+*]\}|\(|(?:^|\/)\*(?:\/|$)/.test(path);
}

function countOf(
  items: readonly Item[],
  kinds: readonly Item["kind"][],
): number {
  return items.filter((item) => kinds.includes(item.kind)).length;
}

/**
 * How narrowly the path states which requests it serves, as a rank to
 * compare lexicographically: fixed segments first, then segments with
 * some text in them, then how few segments it lets vary in number, then
 * how few readings a set gives it. A path with several readings ranks
 * by its loosest one. When two paths serve one request, the one
 * ranking higher is the one a caller meant.
 */
export function pathSpecificity(path: string): readonly number[] {
  const alternatives = patternOf(path);
  const ranks = alternatives.map((items) => [
    countOf(items, ["text"]),
    countOf(items, ["shaped"]),
    -countOf(items, ["optional", "star"]),
  ]);
  const loosest = ranks.reduce((low, rank) =>
    compareRanks(rank, low) < 0 ? rank : low,
  );
  return [...loosest, 1 - alternatives.length];
}

/**
 * How a route's item lines up with the request's item on one segment.
 * `stated` counts a request segment the route spells out too, `shaped`
 * one the route's pattern matches. `guess` means the route spells out
 * a segment where the request has a hole, so the two meet only when the
 * runtime value happens to equal the route's text.
 */
type SegmentFit = "stated" | "shaped" | "free" | "guess" | "apart";

function segmentFit(route: Item, request: Item): SegmentFit {
  if (!meetOnOneSegment(route, request)) {
    return "apart";
  }
  if (request.kind === "text") {
    if (route.kind === "text") {
      return "stated";
    }
    return route.kind === "shaped" ? "shaped" : "free";
  }
  if (absorbsAnything(route)) {
    return "free";
  }
  if (request.kind !== "shaped") {
    return "guess";
  }
  if (route.kind === "shaped") {
    return "free";
  }
  // `count{query*}` spells `count` when the query is empty.
  return route.kind === "text" && request.bare === route.text
    ? "stated"
    : "guess";
}

type Fit = readonly [stated: number, shaped: number];

function betterFit(a: Fit | undefined, b: Fit): boolean {
  return a === undefined || compareRanks(b, a) > 0;
}

/**
 * The best way one route alternative lines up with one request
 * alternative, never putting the route's text over a request hole.
 * Every step moves forward on at least one side, so the table fills in
 * order of how far the two have got.
 */
function bestFit(route: readonly Item[], request: readonly Item[]): Fit | null {
  const width = request.length + 1;
  const best: (Fit | undefined)[] = new Array((route.length + 1) * width);
  best[0] = [0, 0];
  const offer = (i: number, j: number, fit: Fit): void => {
    const at = i * width + j;
    if (betterFit(best[at], fit)) {
      best[at] = fit;
    }
  };
  for (
    let reached = 0;
    reached <= route.length + request.length;
    reached += 1
  ) {
    for (
      let i = Math.max(0, reached - request.length);
      i <= Math.min(route.length, reached);
      i += 1
    ) {
      const j = reached - i;
      const fit = best[i * width + j];
      if (fit === undefined) {
        continue;
      }
      const left = route[i];
      const right = request[j];
      if (left !== undefined && skippable(left)) {
        offer(i + 1, j, fit);
      }
      if (right !== undefined && skippable(right)) {
        offer(i, j + 1, fit);
      }
      if (left === undefined || right === undefined) {
        continue;
      }
      if (left.kind === "star" && right.kind === "star") {
        continue;
      }
      const kind = segmentFit(left, right);
      if (kind === "apart" || kind === "guess") {
        continue;
      }
      offer(
        left.kind === "star" ? i : i + 1,
        right.kind === "star" ? j : j + 1,
        [
          fit[0] + (kind === "stated" ? 1 : 0),
          fit[1] + (kind === "shaped" ? 1 : 0),
        ],
      );
    }
  }
  return best[route.length * width + request.length] ?? null;
}

/**
 * How well a route fits a request path, as a rank to compare
 * lexicographically: how many of the segments the request spells out the
 * route spells out too, then how many its patterns match. A caller
 * breaks a tie with `pathSpecificity`. Null when the two meet only where
 * the route spells out a segment the request leaves as a hole: a request
 * to `/follows/{id}` reaches `/follows/bulk_show` only if the id is the
 * word `bulk_show`, so that route is not one the caller meant.
 */
export function requestFit(
  route: string,
  request: string,
): readonly number[] | null {
  let found: Fit | null = null;
  for (const routeItems of patternOf(route)) {
    for (const requestItems of patternOf(request)) {
      const fit = bestFit(routeItems, requestItems);
      if (fit !== null && (found === null || compareRanks(fit, found) > 0)) {
        found = fit;
      }
    }
  }
  return found;
}

/**
 * Whether the route takes every path: some reading of it is all holes,
 * and one of them takes any number of segments, as in `/*` or `/{url+}`.
 */
export function isCatchAll(route: string): boolean {
  return patternOf(route).some(
    (items) =>
      items.length > 0 &&
      items.every(absorbsAnything) &&
      items.some((item) => item.kind === "star"),
  );
}

/** Negative when `a` ranks below `b`, positive above, zero when equal. */
export function compareRanks(
  a: readonly number[],
  b: readonly number[],
): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
