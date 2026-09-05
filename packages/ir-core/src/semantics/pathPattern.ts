/**
 * pathPattern.ts: whether two route paths describe a request in common.
 *
 * A normalized path is text with holes in it. `{id}` is exactly one
 * segment, `{tenant?}` is zero or one, `{rest+}` is one or more and
 * `{rest*}` is zero or more, the modifiers Express puts on `:name`. A
 * bare `*` segment is zero or more segments, Express 4's reading of a
 * star. A set piece is written `(v1|v2)` and matches any one of its
 * options, and an option can contain a slash.
 *
 * `pathsMeet` expands the sets into alternatives, splits each one into
 * segments, and walks the two segment lists with a reachability table
 * in which a hole absorbs as many segments as its range allows.
 */

import { patternHole } from "../boundaryName.js";

/** How many segments a hole takes, in the words the value domain uses. */
export type HoleRange = "one" | "optional" | "many" | "any";

const HOLE_RANGE_SUFFIX: Record<HoleRange, string> = {
  one: "",
  optional: "?",
  many: "+",
  any: "*",
};

/** How a hole taking `range` segments is spelled in a path. */
export function rangedHole(name: string, range: HoleRange): string {
  return patternHole(`${name}${HOLE_RANGE_SUFFIX[range]}`);
}

/** What an option of a set piece cannot contain and still be read back. */
const UNSPELLABLE_OPTION = /[()|?#{}]/;

/**
 * How a piece that is one of several texts is spelled in a path, or
 * null when an option would be read as something else, such as a set
 * boundary or the start of a query.
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
  | { readonly kind: "shaped"; readonly shape: string; readonly test: RegExp }
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

/** Every way of reading the path with each set piece settled. */
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
        return "[^/]+";
      }
      return escapedForRegex(part);
    })
    .join("");
  return {
    kind: "shaped",
    shape: segment.replace(/\{[^}]*\}/g, "{}"),
    test: new RegExp(`^${source}$`),
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

function patternOf(path: string): Item[][] {
  return alternativesOf(path).map((alternative) =>
    segmentsOf(alternative).flatMap(itemsOf),
  );
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

/** Whether the two items can stand for the same single segment. */
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
